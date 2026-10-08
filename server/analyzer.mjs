import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
// JSON escaping can expand control characters to six bytes each.
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES * 6 + 64 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_LENGTH = 2000;
const MAX_RESULTS = 500;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const migrationByLibrary = new Map();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARAGRAPH_BREAK = /(?:\r?\n)[\t ]*(?:\r?\n)+/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const contentType = req.headers?.['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    req.resume?.();
    throw new HttpError(415, 'Content-Type 必須是 application/json。');
  }
  const declaredLength = Number(req.headers?.['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    req.resume?.();
    throw new HttpError(413, '匯入內容超過安全上限。');
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) throw new HttpError(413, '匯入內容超過安全上限。');
    chunks.push(buffer);
  }
  if (length === 0) throw new HttpError(400, '請提供 JSON 匯入內容。');

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 格式無效。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'JSON 主體必須是物件。');
  }
  return body;
}

function buildPages(text) {
  const pageTexts = text.split('\f');
  let sourceStart = 0;
  let paragraphCount = 0;
  const pages = pageTexts.map((pageText, index) => {
    const paragraphs = [];
    let cursor = 0;
    for (const part of pageText.split(PARAGRAPH_BREAK)) {
      if (!part) continue;
      const localStart = pageText.indexOf(part, cursor);
      if (localStart < 0) continue;
      const localEnd = localStart + part.length;
      cursor = localEnd;
      if (!part.trim()) continue;
      paragraphs.push({
        index: paragraphs.length + 1,
        start: sourceStart + localStart,
        end: sourceStart + localEnd,
        text: part,
      });
    }
    paragraphCount += paragraphs.length;
    const page = {
      number: index + 1,
      status: 'indexed',
      start: sourceStart,
      end: sourceStart + pageText.length,
      paragraphs,
    };
    sourceStart += pageText.length + (index < pageTexts.length - 1 ? 1 : 0);
    return page;
  });
  return { pages, paragraphCount };
}

function getLibraryDir(context) {
  if (!context || typeof context.dataDir !== 'string' || !context.dataDir.trim()) {
    throw new HttpError(500, '文件資料目錄尚未設定。');
  }
  return path.join(context.dataDir, 'library');
}

function summarize(source) {
  return {
    id: source.id,
    name: source.name,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    byteLength: source.byteLength,
    pageCount: source.pages.length,
    paragraphCount: source.paragraphCount,
    status: source.status,
  };
}

async function saveSource(libraryDir, source) {
  await mkdir(libraryDir, { recursive: true });
  const finalPath = path.join(libraryDir, `${source.id}.json`);
  const temporaryPath = path.join(libraryDir, `.${source.id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(source), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function loadSource(libraryDir, id) {
  try {
    return JSON.parse(await readFile(path.join(libraryDir, `${id}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function requireProjectScope(context, value) {
  const configured = typeof context?.hasProject === 'function' || typeof context?.latestProjectId === 'function';
  if (typeof value !== 'string' || !value.trim()) {
    if (!configured) return null;
    throw new HttpError(400, '請先選擇所屬專案。');
  }
  if (!PROJECT_ID_PATTERN.test(value)) throw new HttpError(400, '專案識別碼無效。');
  if (typeof context?.hasProject === 'function' && !(await context.hasProject(value))) throw new HttpError(404, '找不到此專案。');
  return value;
}

async function migrateLegacySources(libraryDir, context) {
  if (migrationByLibrary.has(libraryDir)) {
    const completed = await migrationByLibrary.get(libraryDir);
    if (completed) return;
    migrationByLibrary.delete(libraryDir);
  }
  const migration = (async () => {
    if (typeof context?.latestProjectId !== 'function') return false;
    const latestProjectId = await context.latestProjectId();
    if (typeof latestProjectId !== 'string' || !PROJECT_ID_PATTERN.test(latestProjectId)) return false;
    let names;
    try { names = await readdir(libraryDir); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!UUID_PATTERN.test(id)) continue;
      const source = await loadSource(libraryDir, id);
      if (source && (typeof source.projectId !== 'string' || !source.projectId)) {
        source.projectId = latestProjectId;
        await saveSource(libraryDir, source);
      }
    }
    return true;
  })();
  migrationByLibrary.set(libraryDir, migration);
  try {
    if (!(await migration)) migrationByLibrary.delete(libraryDir);
  } catch (error) {
    migrationByLibrary.delete(libraryDir);
    throw error;
  }
}

async function listSources(libraryDir, projectId) {
  let names;
  try {
    names = await readdir(libraryDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const documents = [];
  for (const name of names) {
    const match = /^([0-9a-f-]{36})\.json$/i.exec(name);
    if (!match || !UUID_PATTERN.test(match[1])) continue;
    const source = await loadSource(libraryDir, match[1]);
    if (source && (projectId === null || source.projectId === projectId)) documents.push(summarize(source));
  }
  documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));
  return documents;
}

function validateMetadata(metadata) {
  if (metadata === undefined) return undefined;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new HttpError(400, '來源中繼資料必須是物件。');
  }
  let serialized;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    throw new HttpError(400, '來源中繼資料格式無效。');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
    throw new HttpError(413, '來源中繼資料超過安全上限。');
  }
  return metadata;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeExcerpt(text, start, length) {
  let excerptStart = Math.max(0, start - 56);
  let excerptEnd = Math.min(text.length, start + length + 56);
  if (excerptStart > 0 && /[\uDC00-\uDFFF]/.test(text[excerptStart])) excerptStart += 1;
  if (excerptEnd < text.length && /[\uDC00-\uDFFF]/.test(text[excerptEnd]) && /[\uD800-\uDBFF]/.test(text[excerptEnd - 1])) excerptEnd += 1;
  return `${excerptStart > 0 ? '…' : ''}${text.slice(excerptStart, excerptEnd)}${excerptEnd < text.length ? '…' : ''}`;
}

function searchSource(source, query) {
  if (typeof query !== 'string' || !query.trim()) throw new HttpError(400, '請輸入搜尋文字。');
  if (query.length > MAX_QUERY_LENGTH) throw new HttpError(400, `搜尋文字不可超過 ${MAX_QUERY_LENGTH} 個字元。`);
  const matcher = new RegExp(escapeRegExp(query), 'giu');
  const results = [];
  let total = 0;
  for (const page of source.pages) {
    const pageText = source.text.slice(page.start, page.end);
    matcher.lastIndex = 0;
    for (const match of pageText.matchAll(matcher)) {
      total += 1;
      if (results.length >= MAX_RESULTS) continue;
      const paragraph = page.paragraphs.find((item) => {
        const pageLocalStart = item.start - page.start;
        const pageLocalEnd = item.end - page.start;
        return match.index >= pageLocalStart && match.index < pageLocalEnd;
      });
      results.push({
        page: page.number,
        offset: match.index,
        sourceOffset: page.start + match.index,
        paragraph: paragraph?.index ?? null,
        excerpt: safeExcerpt(pageText, match.index, match[0].length),
      });
    }
  }
  return { query, total, hasMore: total > MAX_RESULTS, results };
}

function urlFor(req, value) {
  if (value instanceof URL) return value;
  const raw = typeof value === 'string' ? value : req.url || '/';
  return new URL(raw, 'http://127.0.0.1');
}

export async function handleAnalyzer(req, res, url, context) {
  let parsedUrl;
  try {
    parsedUrl = urlFor(req, url);
  } catch {
    return false;
  }
  const pathname = parsedUrl.pathname;
  if (pathname !== '/api/library' && !pathname.startsWith('/api/library/')) return false;

  try {
    const libraryDir = getLibraryDir(context);
    const method = String(req.method || 'GET').toUpperCase();

    if (pathname === '/api/library') {
      if (method === 'GET') {
        const projectId = await requireProjectScope(context, parsedUrl.searchParams.get('projectId'));
        if (projectId) await migrateLegacySources(libraryDir, context);
        sendJson(res, 200, { documents: await listSources(libraryDir, projectId) });
        return true;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { error: '此文件庫路由不支援該方法。' });
        return true;
      }
      const body = await readJson(req);
      const projectId = await requireProjectScope(context, body.projectId);
      if (projectId) await migrateLegacySources(libraryDir, context);
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 255 || /[\u0000-\u001f\u007f]/.test(body.name)) {
        throw new HttpError(400, '檔案名稱必須是 1 至 255 字元的純文字。');
      }
      if (typeof body.text !== 'string') throw new HttpError(400, '匯入內容必須是文字。');
      const byteLength = Buffer.byteLength(body.text, 'utf8');
      if (byteLength > MAX_SOURCE_BYTES) throw new HttpError(413, '單一來源不可超過 20 MiB。');
      const metadata = validateMetadata(body.metadata);
      const { pages, paragraphCount } = buildPages(body.text);
      const now = new Date().toISOString();
      const source = {
        id: randomUUID(),
        ...(projectId ? { projectId } : {}),
        name: body.name.trim(),
        createdAt: now,
        updatedAt: now,
        byteLength,
        status: 'indexed',
        paragraphCount,
        ...(metadata === undefined ? {} : { metadata }),
        pages,
        text: body.text,
      };
      await saveSource(libraryDir, source);
      sendJson(res, 201, { document: summarize(source) });
      return true;
    }

    const parts = pathname.split('/');
    const id = parts[3];
    const projectId = await requireProjectScope(context, parsedUrl.searchParams.get('projectId'));
    if (projectId) await migrateLegacySources(libraryDir, context);
    const loadForProject = async () => {
      const source = await loadSource(libraryDir, id);
      return source && (projectId === null || source.projectId === projectId) ? source : null;
    };
    if (!id || !UUID_PATTERN.test(id)) {
      sendJson(res, 404, { error: '找不到此文件來源。' });
      return true;
    }
    if (parts.length === 4 && method === 'DELETE') {
      const source = await loadForProject();
      if (!source) {
        sendJson(res, 404, { error: '找不到此文件來源。' });
        return true;
      }
      await rm(path.join(libraryDir, `${id}.json`));
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (parts.length === 4 && method === 'GET') {
      const source = await loadForProject();
      if (!source) {
        sendJson(res, 404, { error: '找不到此文件來源。' });
        return true;
      }
      sendJson(res, 200, { ...summarize(source), metadata: source.metadata ?? null, pages: source.pages, text: source.text });
      return true;
    }
    if (parts.length === 5 && parts[4] === 'search' && method === 'GET') {
      const source = await loadForProject();
      if (!source) {
        sendJson(res, 404, { error: '找不到此文件來源。' });
        return true;
      }
      sendJson(res, 200, searchSource(source, parsedUrl.searchParams.get('q')));
      return true;
    }
    sendJson(res, 405, { error: '此文件來源路由不支援該方法。' });
    return true;
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
    } else {
      sendJson(res, 500, { error: '文件庫操作失敗。' });
    }
    return true;
  }
}
