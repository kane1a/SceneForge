import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createFeatures } from './features.mjs';
import { createTrashStorage, moveFile } from './trash-storage.mjs';
import { rewritePortableDatabasePaths } from './portable-paths.mjs';
import { API_COOKIE, createApiToken, hasValidApiToken, isAllowedHost, routeTemplate, CSP } from './security.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.SCENEFORGE_DATA_DIR || path.join(ROOT, 'data'));
const DIST_DIR = path.resolve(process.env.SCENEFORGE_DIST_DIR || path.join(ROOT, 'dist'));
const TOKEN_FILE = path.resolve(process.env.SCENEFORGE_TOKEN_FILE || path.join(DATA_DIR, 'api-token'));
const PORT_FILE = path.resolve(process.env.SCENEFORGE_PORT_FILE || path.join(DATA_DIR, 'port.json'));
const API_TOKEN = process.env.SCENEFORGE_API_TOKEN || createApiToken();
if (API_TOKEN.length < 32) throw new Error('SCENEFORGE_API_TOKEN must contain at least 32 characters');
const HOST = '127.0.0.1';
const PORT_TEXT = process.env.SCENEFORGE_PORT ?? '4318';
const PORT = Number(PORT_TEXT);
let activePort = PORT;
const WEB_PORT = Number(process.env.SCENEFORGE_WEB_PORT ?? '4317');
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  'http://localhost:4317', 'http://127.0.0.1:4317',
  'http://localhost:4318', 'http://127.0.0.1:4318',
  `http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`,
  `http://localhost:${PORT_TEXT}`, `http://127.0.0.1:${PORT_TEXT}`,
]);
const BLOCK_TYPES = new Set(['scene', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'shot', 'act', 'note', 'message', 'titlecard']);
const PROFILE_FIELDS = ['age', 'role', 'look', 'personality', 'want', 'need', 'flaw', 'arc', 'backstory', 'notes'];
const CLAIM_STATUSES = new Set(['candidate', 'confirmed', 'archived']);
const THREAD_STATUSES = new Set(['open', 'progress', 'resolved', 'abandoned']);
const RELATION_TYPES = new Set(['family', 'love', 'friend', 'ally', 'mentor', 'work', 'rival', 'enemy', 'other']);
const MINDMAP_MAX_NODES = 5000;
const MINDMAP_MAX_DEPTH = 24;
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
  ['.txt', 'text/plain; charset=utf-8'], ['.pdf', 'application/pdf'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'], ['.wasm', 'application/wasm'],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function writePrivateFile(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch { /* Windows inherits ACLs from the user-data directory. */ }
}

function persistToken() {
  writePrivateFile(TOKEN_FILE, `${API_TOKEN}\n`);
}

function persistPort(port) {
  writePrivateFile(PORT_FILE, JSON.stringify({ port, token: API_TOKEN }));
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function fail(status, message) {
  throw new HttpError(status, message);
}

function initializeDatabase() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'sceneforge.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      content_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_by_project_created
      ON snapshots(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS trashed_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      content_json TEXT NOT NULL,
      sfe_original_path TEXT,
      sfe_trash_name TEXT
    );
    CREATE TABLE IF NOT EXISTS project_file_locations (
      project_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trashed_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'backup')),
      title TEXT NOT NULL,
      project_id TEXT,
      original_id TEXT,
      original_name TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      content_json TEXT,
      trash_name TEXT
    );
    CREATE INDEX IF NOT EXISTS trash_items_by_deleted
      ON trashed_items(deleted_at DESC);
    CREATE TABLE IF NOT EXISTS trashed_snapshots (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_json TEXT NOT NULL,
      PRIMARY KEY(id, project_id)
    );
    CREATE INDEX IF NOT EXISTS trashed_by_deleted
      ON trashed_projects(deleted_at DESC);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const trashColumns = new Set(db.prepare('PRAGMA table_info(trashed_projects)').all().map((column) => column.name));
  if (!trashColumns.has('sfe_original_path')) db.exec('ALTER TABLE trashed_projects ADD COLUMN sfe_original_path TEXT');
  if (!trashColumns.has('sfe_trash_name')) db.exec('ALTER TABLE trashed_projects ADD COLUMN sfe_trash_name TEXT');
  return db;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function assertObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(400, `${name} must be an object`);
}

function assertKeys(value, required, optional, name) {
  assertObject(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(400, `${name}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(400, `${name} has an unsupported field`);
}

function assertString(value, name, maxLength, { nonempty = true } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || (nonempty && value.trim().length === 0)) {
    fail(400, `${name} is invalid`);
  }
  return value;
}

function assertId(value, name) {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value)) {
    fail(400, `${name} is invalid`);
  }
  return value;
}

function assertTimestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    fail(400, `${name} is invalid`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail(400, `${name} is invalid`);
  return value;
}

function validateProject(input) {
  assertKeys(input, ['id', 'title', 'updatedAt', 'blocks', 'entities', 'claims', 'threads'], ['relations', 'recordOrder', 'mindmap', 'titlePage', 'sceneMeta', 'comments', 'kind', 'facts', 'factColumns', 'bible', 'characterDrafts', 'settings', 'dismissedIdentitySuggestions', 'ignoredStoryCandidates', 'hiddenLocations', 'storyOutline'], 'project');
  const id = assertId(input.id, 'project.id');
  const title = assertString(input.title, 'project.title', 300);
  assertTimestamp(input.updatedAt, 'project.updatedAt');
  const validateArray = (list, name, maxItems) => {
    if (!Array.isArray(list) || list.length > maxItems) fail(400, `${name} must be an array`);
    return list;
  };
  const blocks = validateArray(input.blocks, 'project.blocks', 25000).map((block, index) => {
    assertKeys(block, ['id', 'type', 'text'], [], `blocks[${index}]`);
    const blockId = assertId(block.id, `blocks[${index}].id`);
    if (!BLOCK_TYPES.has(block.type)) fail(400, `blocks[${index}].type is invalid`);
    return { id: blockId, type: block.type, text: assertString(block.text, `blocks[${index}].text`, 1_000_000, { nonempty: false }) };
  });
  const entities = validateArray(input.entities, 'project.entities', 10000).map((entity, index) => {
    assertKeys(entity, ['id', 'name', 'aliases', 'description'], [], `entities[${index}]`);
    const aliases = validateArray(entity.aliases, `entities[${index}].aliases`, 200)
      .map((alias, aliasIndex) => assertString(alias, `entities[${index}].aliases[${aliasIndex}]`, 200, { nonempty: false }));
    return {
      id: assertId(entity.id, `entities[${index}].id`),
      name: assertString(entity.name, `entities[${index}].name`, 200),
      aliases,
      description: assertString(entity.description, `entities[${index}].description`, 5000, { nonempty: false }),
    };
  });
  const claims = validateArray(input.claims, 'project.claims', 20000).map((claim, index) => {
    assertKeys(claim, ['id', 'text', 'status'], ['sourceBlockId', 'characterId', 'sourceRef', 'threadLinks', 'threadStatus'], `claims[${index}]`);
    if (!CLAIM_STATUSES.has(claim.status)) fail(400, `claims[${index}].status is invalid`);
    const clean = {
      id: assertId(claim.id, `claims[${index}].id`),
      text: assertString(claim.text, `claims[${index}].text`, 5000),
      status: claim.status,
    };
    if (Object.hasOwn(claim, 'sourceBlockId')) clean.sourceBlockId = assertId(claim.sourceBlockId, `claims[${index}].sourceBlockId`);
    if (Object.hasOwn(claim, 'characterId')) clean.characterId = assertId(claim.characterId, `claims[${index}].characterId`);
    if (Object.hasOwn(claim, 'threadLinks')) {
      assertKeys(claim.threadLinks, [], ['setupBlockId', 'payoffBlockId'], `claims[${index}].threadLinks`);
      clean.threadLinks = {};
      for (const key of ['setupBlockId', 'payoffBlockId']) if (Object.hasOwn(claim.threadLinks, key)) clean.threadLinks[key] = assertId(claim.threadLinks[key], `claims[${index}].threadLinks.${key}`);
    }
    if (Object.hasOwn(claim, 'threadStatus')) {
      if (!THREAD_STATUSES.has(claim.threadStatus)) fail(400, `claims[${index}].threadStatus is invalid`);
      clean.threadStatus = claim.threadStatus;
    }
    if (Object.hasOwn(claim, 'sourceRef')) {
      assertKeys(claim.sourceRef, ['documentId', 'title', 'excerpt'], ['locator'], `claims[${index}].sourceRef`);
      clean.sourceRef = {
        documentId: assertString(claim.sourceRef.documentId, `claims[${index}].sourceRef.documentId`, 200),
        title: assertString(claim.sourceRef.title, `claims[${index}].sourceRef.title`, 500),
        excerpt: assertString(claim.sourceRef.excerpt, `claims[${index}].sourceRef.excerpt`, 5000, { nonempty: false }),
      };
      if (Object.hasOwn(claim.sourceRef, 'locator')) clean.sourceRef.locator = assertString(claim.sourceRef.locator, `claims[${index}].sourceRef.locator`, 500, { nonempty: false });
    }
    return clean;
  });
  const threads = validateArray(input.threads, 'project.threads', 20000).map((thread, index) => {
    assertKeys(thread, ['id', 'title', 'status'], ['setupBlockId', 'payoffBlockId', 'characterId', 'sourceRef', 'emptyDraft'], `threads[${index}]`);
    if (!THREAD_STATUSES.has(thread.status)) fail(400, `threads[${index}].status is invalid`);
    if (Object.hasOwn(thread, 'emptyDraft') && typeof thread.emptyDraft !== 'boolean') fail(400, `threads[${index}].emptyDraft must be boolean`);
    const clean = {
      id: assertId(thread.id, `threads[${index}].id`),
      title: assertString(thread.title, `threads[${index}].title`, 5000, { nonempty: !Object.hasOwn(thread, 'emptyDraft') }),
      status: thread.status,
      ...(Object.hasOwn(thread, 'emptyDraft') ? { emptyDraft: thread.emptyDraft } : {}),
    };
    for (const key of ['setupBlockId', 'payoffBlockId']) {
      if (Object.hasOwn(thread, key)) clean[key] = assertId(thread[key], `threads[${index}].${key}`);
    }
    if (Object.hasOwn(thread, 'characterId')) clean.characterId = assertId(thread.characterId, `threads[${index}].characterId`);
    if (Object.hasOwn(thread, 'sourceRef')) {
      assertKeys(thread.sourceRef, ['documentId', 'title', 'excerpt'], ['locator'], `threads[${index}].sourceRef`);
      clean.sourceRef = {
        documentId: assertString(thread.sourceRef.documentId, `threads[${index}].sourceRef.documentId`, 200),
        title: assertString(thread.sourceRef.title, `threads[${index}].sourceRef.title`, 500),
        excerpt: assertString(thread.sourceRef.excerpt, `threads[${index}].sourceRef.excerpt`, 5000, { nonempty: false }),
      };
      if (Object.hasOwn(thread.sourceRef, 'locator')) clean.sourceRef.locator = assertString(thread.sourceRef.locator, `threads[${index}].sourceRef.locator`, 500, { nonempty: false });
    }
    return clean;
  });
  for (const [name, items] of Object.entries({ blocks, entities, claims, threads })) {
    const ids = new Set();
    for (const item of items) {
      if (ids.has(item.id)) fail(400, `${name} IDs must be unique`);
      ids.add(item.id);
    }
  }
  const clean = { id, title, updatedAt: input.updatedAt, blocks, entities, claims, threads };
  if (Object.hasOwn(input, 'recordOrder')) {
    const recordOrder = validateArray(input.recordOrder, 'project.recordOrder', 40000).map((item, index) => assertId(item, `project.recordOrder[${index}]`));
    if (new Set(recordOrder).size !== recordOrder.length) fail(400, 'project.recordOrder IDs must be unique');
    clean.recordOrder = recordOrder;
  }
  if (Object.hasOwn(input, 'relations')) {
    clean.relations = validateArray(input.relations, 'project.relations', 5000).map((relation, index) => {
      assertKeys(relation, ['id', 'from', 'to', 'type'], ['label', 'sinceScene'], `relations[${index}]`);
      if (!RELATION_TYPES.has(relation.type)) fail(400, `relations[${index}].type is invalid`);
      const item = {
        id: assertId(relation.id, `relations[${index}].id`),
        from: assertString(relation.from, `relations[${index}].from`, 200),
        to: assertString(relation.to, `relations[${index}].to`, 200),
        type: relation.type,
      };
      if (Object.hasOwn(relation, 'label')) item.label = assertString(relation.label, `relations[${index}].label`, 200, { nonempty: false });
      if (Object.hasOwn(relation, 'sinceScene')) item.sinceScene = assertId(relation.sinceScene, `relations[${index}].sinceScene`);
      return item;
    });
  }
  if (Object.hasOwn(input, 'mindmap')) clean.mindmap = validateMindNode(input.mindmap);
  if (Object.hasOwn(input, 'sceneMeta')) {
    assertObject(input.sceneMeta, 'sceneMeta');
    const entries = Object.entries(input.sceneMeta);
    if (entries.length > 25000) fail(400, 'sceneMeta is too large');
    clean.sceneMeta = Object.fromEntries(entries.map(([key, meta]) => {
      assertId(key, 'sceneMeta key');
      assertKeys(meta, [], ['summary', 'color', 'storyTime', 'storyOrder'], `sceneMeta.${key}`);
      const item = {};
      if (Object.hasOwn(meta, 'summary')) item.summary = assertString(meta.summary, `sceneMeta.${key}.summary`, 4000, { nonempty: false });
      if (Object.hasOwn(meta, 'color')) {
        if (!['', 'gold', 'rose', 'jade', 'sky', 'violet', 'slate'].includes(meta.color)) fail(400, `sceneMeta.${key}.color is invalid`);
        item.color = meta.color;
      }
      if (Object.hasOwn(meta, 'storyTime')) item.storyTime = assertString(meta.storyTime, `sceneMeta.${key}.storyTime`, 200, { nonempty: false });
      if (Object.hasOwn(meta, 'storyOrder')) {
        if (typeof meta.storyOrder !== 'number' || !Number.isFinite(meta.storyOrder)) fail(400, `sceneMeta.${key}.storyOrder is invalid`);
        item.storyOrder = meta.storyOrder;
      }
      return [key, item];
    }));
  }
  if (Object.hasOwn(input, 'comments')) {
    clean.comments = validateArray(input.comments, 'project.comments', 20000).map((comment, index) => {
      assertKeys(comment, ['id', 'blockId', 'text', 'createdAt'], ['resolved'], `comments[${index}]`);
      const item = {
        id: assertId(comment.id, `comments[${index}].id`),
        blockId: assertId(comment.blockId, `comments[${index}].blockId`),
        text: assertString(comment.text, `comments[${index}].text`, 4000),
        createdAt: assertTimestamp(comment.createdAt, `comments[${index}].createdAt`),
      };
      if (Object.hasOwn(comment, 'resolved')) {
        if (typeof comment.resolved !== 'boolean') fail(400, `comments[${index}].resolved is invalid`);
        item.resolved = comment.resolved;
      }
      return item;
    });
  }
  if (Object.hasOwn(input, 'settings')) {
    assertKeys(input.settings, ['preset'], ['fonts', 'showActHeadings', 'autoContinuation'], 'project.settings');
    if (!['us-screenplay', 'taiwan-work'].includes(input.settings.preset)) fail(400, 'project.settings.preset is invalid');
    const settings = { preset: input.settings.preset };
    if (Object.hasOwn(input.settings, 'fonts')) {
      assertKeys(input.settings.fonts, ['latin', 'cjk'], [], 'project.settings.fonts');
      settings.fonts = { latin: assertString(input.settings.fonts.latin, 'settings.fonts.latin', 100), cjk: assertString(input.settings.fonts.cjk, 'settings.fonts.cjk', 100) };
    }
    if (Object.hasOwn(input.settings, 'showActHeadings')) {
      if (typeof input.settings.showActHeadings !== 'boolean') fail(400, 'project.settings.showActHeadings is invalid');
      settings.showActHeadings = input.settings.showActHeadings;
    }
    if (Object.hasOwn(input.settings, 'autoContinuation')) {
      if (typeof input.settings.autoContinuation !== 'boolean') fail(400, 'project.settings.autoContinuation is invalid');
      settings.autoContinuation = input.settings.autoContinuation;
    }
    clean.settings = settings;
  }
  if (Object.hasOwn(input, 'dismissedIdentitySuggestions')) clean.dismissedIdentitySuggestions = validateArray(input.dismissedIdentitySuggestions, 'project.dismissedIdentitySuggestions', 50000).map((value, index) => assertString(value, `project.dismissedIdentitySuggestions[${index}]`, 500, { nonempty: false }));
  if (Object.hasOwn(input, 'ignoredStoryCandidates')) clean.ignoredStoryCandidates = validateArray(input.ignoredStoryCandidates, 'project.ignoredStoryCandidates', 50000).map((value, index) => assertString(value, `project.ignoredStoryCandidates[${index}]`, 500, { nonempty: false }));
  if (Object.hasOwn(input, 'hiddenLocations')) clean.hiddenLocations = validateArray(input.hiddenLocations, 'project.hiddenLocations', 50000).map((value, index) => assertString(value, `project.hiddenLocations[${index}]`, 500, { nonempty: false }));
  if (Object.hasOwn(input, 'kind')) {
    if (!['film', 'series', 'short'].includes(input.kind)) fail(400, 'project.kind is invalid');
    clean.kind = input.kind;
  }
  if (Object.hasOwn(input, 'facts')) {
    clean.facts = validateArray(input.facts, 'project.facts', 2000).map((fact, index) => {
      assertKeys(fact, ['id', 'text', 'known'], [], `facts[${index}]`);
      assertObject(fact.known, `facts[${index}].known`);
      const known = Object.entries(fact.known);
      if (known.length > 500) fail(400, `facts[${index}].known is too large`);
      return {
        id: assertId(fact.id, `facts[${index}].id`),
        text: assertString(fact.text, `facts[${index}].text`, 2000, { nonempty: false }),
        known: Object.fromEntries(known.map(([name, sceneId]) => [assertString(name, `facts[${index}].known key`, 200), assertId(sceneId, `facts[${index}].known.${name}`)])),
      };
    });
  }
  if (Object.hasOwn(input, 'factColumns')) {
    clean.factColumns = validateArray(input.factColumns, 'project.factColumns', 500).map((who, index) => assertString(who, `factColumns[${index}]`, 200));
  }
  if (Object.hasOwn(input, 'storyOutline')) {
    assertKeys(input.storyOutline, [], ['logline', 'synopsis', 'core'], 'project.storyOutline');
    const outline = {};
    if (Object.hasOwn(input.storyOutline, 'logline')) outline.logline = assertString(input.storyOutline.logline, 'storyOutline.logline', 1000, { nonempty: false });
    if (Object.hasOwn(input.storyOutline, 'synopsis')) outline.synopsis = assertString(input.storyOutline.synopsis, 'storyOutline.synopsis', 100_000, { nonempty: false });
    if (Object.hasOwn(input.storyOutline, 'core')) outline.core = assertString(input.storyOutline.core, 'storyOutline.core', 5000, { nonempty: false });
    clean.storyOutline = outline;
  }
  if (Object.hasOwn(input, 'bible')) {
    assertObject(input.bible, 'project.bible');
    const entries = Object.entries(input.bible);
    if (entries.length > 5000) fail(400, 'project.bible is too large');
    clean.bible = Object.fromEntries(entries.map(([name, profile]) => {
      assertString(name, 'bible key', 200);
      assertKeys(profile, [], [...PROFILE_FIELDS, 'avatarHue', 'tier'], `bible.${name}`);
      return [name, Object.fromEntries(Object.entries(profile).map(([field, value]) => {
        if (field === 'avatarHue') {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 360) fail(400, `bible.${name}.avatarHue is invalid`);
          return [field, Math.round(value)];
        }
        if (field === 'tier') {
          if (!['lead', 'support', 'extra'].includes(value)) fail(400, `bible.${name}.tier is invalid`);
          return [field, value];
        }
        return [field, assertString(value, `bible.${name}.${field}`, 8000, { nonempty: false })];
      }))];
    }));
  }
  if (Object.hasOwn(input, 'characterDrafts')) {
    const seenDraftIds = new Set();
    clean.characterDrafts = validateArray(input.characterDrafts, 'project.characterDrafts', 1000).map((draft, index) => {
      assertKeys(draft, ['id', 'fields'], ['touched'], `characterDrafts[${index}]`);
      const draftId = assertId(draft.id, `characterDrafts[${index}].id`);
      if (Object.hasOwn(draft, 'touched') && typeof draft.touched !== 'boolean') fail(400, `characterDrafts[${index}].touched must be boolean`);
      if (seenDraftIds.has(draftId)) fail(400, `characterDrafts[${index}].id is duplicated`);
      seenDraftIds.add(draftId);
      assertObject(draft.fields, `characterDrafts[${index}].fields`);
      assertKeys(draft.fields, [], ['name', ...PROFILE_FIELDS], `characterDrafts[${index}].fields`);
      const fields = Object.fromEntries(Object.entries(draft.fields).map(([field, value]) => [
        field,
        assertString(value, `characterDrafts[${index}].fields.${field}`, field === 'name' ? 200 : 8000, { nonempty: false }),
      ]));
      return { id: draftId, fields, ...(Object.hasOwn(draft, 'touched') ? { touched: draft.touched } : {}) };
    });
  }
  if (Object.hasOwn(input, 'titlePage')) {
    const fields = ['title', 'subtitle', 'author', 'basedOn', 'draft', 'date', 'contact', 'notes'];
    assertKeys(input.titlePage, [], [...fields, 'print'], 'titlePage');
    const page = {};
    for (const key of fields) if (Object.hasOwn(input.titlePage, key)) page[key] = assertString(input.titlePage[key], `titlePage.${key}`, 2000, { nonempty: false });
    if (Object.hasOwn(input.titlePage, 'print')) {
      if (typeof input.titlePage.print !== 'boolean') fail(400, 'titlePage.print is invalid');
      page.print = input.titlePage.print;
    }
    clean.titlePage = page;
  }
  return clean;
}

function validateMindNode(root) {
  let count = 0;
  const visit = (node, depth, name) => {
    if (++count > MINDMAP_MAX_NODES) fail(400, 'mindmap has too many nodes');
    if (depth > MINDMAP_MAX_DEPTH) fail(400, 'mindmap is too deep');
    assertKeys(node, ['id', 'text', 'children'], ['collapsed', 'side', 'note', 'sceneId', 'marker', 'color', 'generated', 'edited'], name);
    if (!Array.isArray(node.children)) fail(400, `${name}.children must be an array`);
    const item = {
      id: assertId(node.id, `${name}.id`),
      text: assertString(node.text, `${name}.text`, 2000, { nonempty: false }),
      children: node.children.map((child, index) => visit(child, depth + 1, `${name}.children[${index}]`)),
    };
    if (Object.hasOwn(node, 'side')) {
      if (node.side !== 'left' && node.side !== 'right') fail(400, `${name}.side is invalid`);
      item.side = node.side;
    }
    if (Object.hasOwn(node, 'collapsed')) {
      if (typeof node.collapsed !== 'boolean') fail(400, `${name}.collapsed is invalid`);
      item.collapsed = node.collapsed;
    }
    if (Object.hasOwn(node, 'note')) item.note = assertString(node.note, `${name}.note`, 12000, { nonempty: false });
    if (Object.hasOwn(node, 'sceneId')) item.sceneId = assertId(node.sceneId, `${name}.sceneId`);
    if (Object.hasOwn(node, 'marker')) {
      if (!['todo', 'done', 'important', 'question', 'foreshadow', 'turn'].includes(node.marker)) fail(400, `${name}.marker is invalid`);
      item.marker = node.marker;
    }
    if (Object.hasOwn(node, 'color')) {
      if (!Number.isInteger(node.color) || node.color < 0 || node.color > 7) fail(400, `${name}.color is invalid`);
      item.color = node.color;
    }
    for (const field of ['generated', 'edited']) if (Object.hasOwn(node, field)) {
      if (typeof node[field] !== 'boolean') fail(400, `${name}.${field} is invalid`);
      item[field] = node[field];
    }
    return item;
  };
  return visit(root, 0, 'mindmap');
}

const IMPORT_MEMORY_LIMITS = { characters: 2000, notCharacters: 2000, rules: 500 };
function validateImportMemory(input) {
  assertKeys(input, ['characters', 'notCharacters', 'rules'], ['corrections'], 'memory');
  const strings = (list, name, max) => {
    if (!Array.isArray(list) || list.length > max) fail(400, `memory.${name} is invalid`);
    return list.map((value, index) => assertString(value, `memory.${name}[${index}]`, 200));
  };
  if (!Array.isArray(input.rules) || input.rules.length > IMPORT_MEMORY_LIMITS.rules) fail(400, 'memory.rules is invalid');
  const rules = input.rules.map((rule, index) => {
    assertKeys(rule, ['prefix', 'type'], ['hits'], `memory.rules[${index}]`);
    if (!BLOCK_TYPES.has(rule.type)) fail(400, `memory.rules[${index}].type is invalid`);
    const item = { prefix: assertString(rule.prefix, `memory.rules[${index}].prefix`, 40), type: rule.type };
    if (Object.hasOwn(rule, 'hits')) {
      if (!Number.isInteger(rule.hits) || rule.hits < 0) fail(400, `memory.rules[${index}].hits is invalid`);
      item.hits = rule.hits;
    }
    return item;
  });
  const corrections = Object.hasOwn(input, 'corrections') ? input.corrections : 0;
  if (!Number.isInteger(corrections) || corrections < 0) fail(400, 'memory.corrections is invalid');
  return {
    characters: strings(input.characters, 'characters', IMPORT_MEMORY_LIMITS.characters),
    notCharacters: strings(input.notCharacters, 'notCharacters', IMPORT_MEMORY_LIMITS.notCharacters),
    rules,
    corrections,
  };
}

async function readJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) fail(415, 'Content-Type must be application/json');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    req.resume();
    fail(Number(length) > MAX_BODY_BYTES ? 413 : 400, 'Request body is invalid or too large');
  }
  let total = 0;
  let tooLarge = false;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) tooLarge = true;
    else if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) fail(413, 'Request body is too large');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail(400, 'Malformed JSON body');
  }
}

function checkWriteOrigin(req) {
  const origin = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.has(origin)
    || origin === `http://127.0.0.1:${activePort}`
    || origin === `http://localhost:${activePort}`;
  if (typeof origin !== 'string' || !allowed) fail(403, 'Origin is not allowed');
}

function getPathSegments(pathname) {
  try {
    return pathname.split('/').slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    fail(400, 'Malformed URL path');
  }
}

async function serveStatic(req, res, requestUrl) {
  if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed');
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    fail(400, 'Malformed URL path');
  }
  if (decodedPath.includes(String.fromCharCode(0)) || decodedPath.includes(String.fromCharCode(92))
      || [...decodedPath].some((character) => character.charCodeAt(0) < 32)) {
    fail(404, 'Not found');
  }
  let distRoot;
  try {
    distRoot = await realpath(DIST_DIR);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const requestedRelative = decodedPath.slice(1) || 'index.html';
  const candidate = path.resolve(distRoot, requestedRelative);
  const relativeCandidate = path.relative(distRoot, candidate);
  if (relativeCandidate === '..' || relativeCandidate.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCandidate)) {
    fail(404, 'Not found');
  }
  let filePath = candidate;
  try {
    filePath = await realpath(candidate);
  } catch (error) {
    const acceptsHtml = (req.headers.accept || '').includes('text/html');
    if (req.method === 'GET' && !path.extname(requestedRelative) && acceptsHtml) {
      try {
        filePath = await realpath(path.join(distRoot, 'index.html'));
      } catch {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
    } else if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    } else {
      throw error;
    }
  }
  const realRelative = path.relative(distRoot, filePath);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    fail(404, 'Not found');
  }
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!fileStat.isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Content-Length': fileStat.size,
    // Built assets carry a content hash in their name, so they never change once cached.
    'Cache-Control': requestUrl.pathname.startsWith('/assets/') || requestUrl.pathname.startsWith('/fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (contentType.startsWith('text/html')) {
    headers['Content-Security-Policy'] = CSP;
    headers['Set-Cookie'] = `${API_COOKIE}=${API_TOKEN}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=86400`;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

function createHandler(db, trashStorage) {
  return async function handleRequest(req, res) {
    let route = '/unknown';
    try {
      if (!isAllowedHost(req.headers.host, activePort)) fail(403, 'Host is not allowed');
      if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) fail(400, 'Malformed request target');
      const requestUrl = new URL(req.url, `http://${HOST}`);
      route = routeTemplate(requestUrl.pathname);
      if (requestUrl.pathname.startsWith('/api/') || requestUrl.pathname === '/api') {
        if (!hasValidApiToken(req, API_TOKEN)) fail(401, 'API token is missing or invalid');
        if (req.method !== 'GET' && req.method !== 'HEAD') checkWriteOrigin(req);
        await handleApi(req, res, requestUrl, db, trashStorage);
      } else {
        await serveStatic(req, res, requestUrl);
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
      } else if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        const category = error instanceof Error && ['TypeError', 'RangeError', 'SyntaxError'].includes(error.name) ? error.name : 'Error';
        console.error(`Request failed: ${req.method} ${route} ${category}`);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  };
}

let features = null;
async function handleApi(req, res, requestUrl, db, trashStorage) {
  const isLibraryPath = requestUrl.pathname === '/api/library' || requestUrl.pathname.startsWith('/api/library/');
  if (isLibraryPath) {
    try {
      const analyzer = await import('./analyzer.mjs');
      if (typeof analyzer.handleAnalyzer !== 'function') throw new Error('Analyzer handler is not available');
      if (await analyzer.handleAnalyzer(req, res, requestUrl, {
        dataDir: DATA_DIR,
        hasProject: (id) => Boolean(db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)),
        latestProjectId: () => db.prepare('SELECT id FROM projects ORDER BY updated_at DESC, id LIMIT 1').get()?.id ?? null,
      })) return;
    } catch (error) {
      const analyzerUrl = new URL('./analyzer.mjs', import.meta.url).href;
      if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === analyzerUrl) {
        fail(501, 'Library analyzer is unavailable');
      }
      throw error;
    }
  }
  const segments = getPathSegments(requestUrl.pathname);
  features ??= createFeatures({ db, dataDir: DATA_DIR, trashStorage, readJsonBody, sendJson, fail, validateProject });
  if (await features(req, res, segments)) return;
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'trash') {
    if (req.method !== 'GET') fail(405, 'Method not allowed');
    const projects = db.prepare(`
      SELECT id, title, updated_at AS updatedAt, deleted_at AS deletedAt,
        (SELECT COUNT(*) FROM trashed_snapshots WHERE project_id = trashed_projects.id) AS snapshotCount,
        (sfe_trash_name IS NOT NULL) AS sfeFile
      FROM trashed_projects ORDER BY deleted_at DESC, id
    `).all().map((project) => ({ ...project, sfeFile: Boolean(project.sfeFile) }));
    const items = db.prepare(`
      SELECT id, kind, title, project_id AS projectId, original_id AS originalId,
        original_name AS originalName, created_at AS createdAt, deleted_at AS deletedAt
      FROM trashed_items ORDER BY deleted_at DESC, id
    `).all();
    sendJson(res, 200, { projects, items });
    return;
  }
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'import-memory') {
    if (req.method === 'GET') {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = 'import-memory'").get();
      sendJson(res, 200, { memory: row ? JSON.parse(row.value_json) : { characters: [], notCharacters: [], rules: [], corrections: 0 } });
      return;
    }
    if (req.method !== 'PUT') fail(405, 'Method not allowed');
    const memory = validateImportMemory(await readJsonBody(req));
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('import-memory', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
      .run(JSON.stringify(memory), new Date().toISOString());
    sendJson(res, 200, { memory });
    return;
  }
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'storage') {
    if (req.method !== 'GET') fail(405, 'Method not allowed');
    sendJson(res, 200, { dataDir: DATA_DIR, database: path.join(DATA_DIR, 'sceneforge.sqlite'), backupsDir: path.join(DATA_DIR, 'backups'), trashDir: trashStorage.dir });
    return;
  }
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'health') {
    if (req.method !== 'GET') fail(405, 'Method not allowed');
    sendJson(res, 200, { ok: true, app: 'SceneForge', version: '0.6.27' });
    return;
  }
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'projects') {
    if (req.method === 'GET') {
      const rows = db.prepare('SELECT id, title, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC, id').all();
      sendJson(res, 200, { projects: rows });
      return;
    }
    if (req.method !== 'POST') fail(405, 'Method not allowed');
    const project = validateProject(await readJsonBody(req));
    const now = new Date().toISOString();
    const saved = { ...project, updatedAt: now };
    const created = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM projects WHERE id = ? UNION ALL SELECT 1 FROM trashed_projects WHERE id = ?').get(saved.id, saved.id)) fail(409, 'Project ID already exists or is in the trash');
      db.prepare('INSERT INTO projects (id, title, updated_at, content_json) VALUES (?, ?, ?, ?)')
        .run(saved.id, saved.title, now, JSON.stringify(saved));
      return saved;
    });
    sendJson(res, 201, created);
    return;
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'file') {
    const projectId = assertId(segments[2], 'project ID');
    if (req.method === 'GET') {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) fail(404, 'Project not found');
      const row = db.prepare('SELECT file_path AS path FROM project_file_locations WHERE project_id = ?').get(projectId);
      sendJson(res, 200, { path: row?.path ?? null });
      return;
    }
    if (req.method !== 'PUT') fail(405, 'Method not allowed');
    const body = await readJsonBody(req);
    if (typeof body.path !== 'string' || !path.isAbsolute(body.path) || path.extname(body.path).toLowerCase() !== '.sfe') fail(400, '只能登記有效的 .sfe 劇本檔。');
    const filePath = path.resolve(body.path);
    try { if (!statSync(filePath).isFile()) fail(400, '找不到 .sfe 劇本檔。'); }
    catch (error) { if (error instanceof HttpError) throw error; fail(400, '找不到 .sfe 劇本檔。'); }
    transaction(db, () => {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) fail(404, 'Project not found');
      db.prepare('INSERT INTO project_file_locations (project_id, file_path) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET file_path = excluded.file_path')
        .run(projectId, filePath);
    });
    sendJson(res, 200, { ok: true, path: filePath });
    return;
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'projects' && segments[3] === 'snapshots') {
    const projectId = assertId(segments[2], 'project ID');
    if (req.method === 'GET') {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) fail(404, 'Project not found');
      const snapshots = db.prepare(
        'SELECT id, created_at AS createdAt, title FROM snapshots WHERE project_id = ? ORDER BY created_at DESC, rowid DESC',
      ).all(projectId);
      sendJson(res, 200, { snapshots });
      return;
    }
    if (req.method !== 'POST') fail(405, 'Method not allowed');
    const created = transaction(db, () => {
      const row = db.prepare('SELECT content_json FROM projects WHERE id = ?').get(projectId);
      if (!row) fail(404, 'Project not found');
      const content = JSON.parse(row.content_json);
      const snapshot = { id: randomUUID(), createdAt: new Date().toISOString(), title: content.title };
      db.prepare('INSERT INTO snapshots (id, project_id, title, created_at, content_json) VALUES (?, ?, ?, ?, ?)')
        .run(snapshot.id, projectId, snapshot.title, snapshot.createdAt, row.content_json);
      return snapshot;
    });
    sendJson(res, 201, created);
    return;
  }
  if (segments.length === 5 && segments[0] === 'api' && segments[1] === 'projects'
      && segments[3] === 'snapshots' && segments[4] === 'prune') {
    if (req.method !== 'POST') fail(405, 'Method not allowed');
    const projectId = assertId(segments[2], 'project ID');
    const body = await readJsonBody(req);
    const keep = Number(body.keep);
    if (![0, 10, 20, 50].includes(keep)) fail(400, '快照保留數量必須是 0、10、20 或 50。');
    const deleted = transaction(db, () => {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) fail(404, 'Project not found');
      const result = db.prepare(`
        DELETE FROM snapshots WHERE project_id = ? AND id NOT IN (
          SELECT id FROM snapshots WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
        )
      `).run(projectId, projectId, keep);
      return Number(result.changes);
    });
    sendJson(res, 200, { ok: true, deleted, kept: keep });
    return;
  }
  if (segments.length === 5 && segments[0] === 'api' && segments[1] === 'projects'
      && segments[3] === 'snapshots' && req.method === 'DELETE') {
    const projectId = assertId(segments[2], 'project ID');
    const snapshotId = assertId(segments[4], 'snapshot ID');
    const trashedId = randomUUID();
    const deletedAt = new Date().toISOString();
    transaction(db, () => {
      const snapshot = db.prepare('SELECT title, created_at, content_json FROM snapshots WHERE project_id = ? AND id = ?').get(projectId, snapshotId);
      if (!snapshot) fail(404, 'Snapshot not found');
      db.prepare(`INSERT INTO trashed_items (id, kind, title, project_id, original_id, created_at, deleted_at, content_json)
        VALUES (?, 'snapshot', ?, ?, ?, ?, ?, ?)`).run(trashedId, snapshot.title, projectId, snapshotId, snapshot.created_at, deletedAt, snapshot.content_json);
      db.prepare('DELETE FROM snapshots WHERE project_id = ? AND id = ?').run(projectId, snapshotId);
    });
    sendJson(res, 200, { ok: true, trashItemId: trashedId });
    return;
  }
  if (segments.length === 6 && segments[0] === 'api' && segments[1] === 'projects'
      && segments[3] === 'snapshots' && segments[5] === 'restore') {
    if (req.method !== 'POST') fail(405, 'Method not allowed');
    const projectId = assertId(segments[2], 'project ID');
    const snapshotId = assertId(segments[4], 'snapshot ID');
    const restored = transaction(db, () => {
      const current = db.prepare('SELECT content_json FROM projects WHERE id = ?').get(projectId);
      if (!current) fail(404, 'Project not found');
      const target = db.prepare('SELECT content_json FROM snapshots WHERE id = ? AND project_id = ?').get(snapshotId, projectId);
      if (!target) fail(404, 'Snapshot not found');
      const now = new Date().toISOString();
      const currentProject = JSON.parse(current.content_json);
      const autoTitle = `還原前自動快照：${currentProject.title}`.slice(0, 300);
      db.prepare('INSERT INTO snapshots (id, project_id, title, created_at, content_json) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), projectId, autoTitle, now, current.content_json);
      const snapshotProject = JSON.parse(target.content_json);
      const saved = { ...snapshotProject, updatedAt: now };
      db.prepare('UPDATE projects SET title = ?, updated_at = ?, content_json = ? WHERE id = ?')
        .run(saved.title, now, JSON.stringify(saved), projectId);
      return saved;
    });
    sendJson(res, 200, restored);
    return;
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'trash' && segments[3] === 'restore') {
    if (req.method !== 'POST') fail(405, 'Method not allowed');
    const projectId = assertId(segments[2], 'project ID');
    const trashed = db.prepare('SELECT title, updated_at, content_json, sfe_original_path, sfe_trash_name FROM trashed_projects WHERE id = ?').get(projectId);
    if (!trashed) fail(404, 'Trashed project not found');
    if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) fail(409, 'A project with this ID already exists');
    let restoredFilePath = null;
    if (trashed.sfe_trash_name && trashed.sfe_original_path) restoredFilePath = trashStorage.restore(trashed.sfe_trash_name, trashed.sfe_original_path);
    let restored;
    try {
      restored = transaction(db, () => {
        db.prepare('INSERT INTO projects (id, title, updated_at, content_json) VALUES (?, ?, ?, ?)')
          .run(projectId, trashed.title, trashed.updated_at, trashed.content_json);
        db.prepare(`
          INSERT INTO snapshots (id, project_id, title, created_at, content_json)
          SELECT id, project_id, title, created_at, content_json FROM trashed_snapshots WHERE project_id = ?
        `).run(projectId);
        db.prepare('DELETE FROM trashed_snapshots WHERE project_id = ?').run(projectId);
        db.prepare('DELETE FROM trashed_projects WHERE id = ?').run(projectId);
        if (restoredFilePath) db.prepare('INSERT INTO project_file_locations (project_id, file_path) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET file_path = excluded.file_path').run(projectId, restoredFilePath);
        return JSON.parse(trashed.content_json);
      });
    } catch (error) {
      if (restoredFilePath && trashed.sfe_trash_name) moveFile(restoredFilePath, path.join(trashStorage.dir, trashed.sfe_trash_name));
      throw error;
    }
    sendJson(res, 200, restored);
    return;
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'projects') {
    const id = assertId(segments[2], 'project ID');
    if (req.method === 'GET') {
      const row = db.prepare('SELECT content_json FROM projects WHERE id = ?').get(id);
      if (!row) fail(404, 'Project not found');
      sendJson(res, 200, JSON.parse(row.content_json));
      return;
    }
    if (req.method === 'PUT') {
      const incoming = validateProject(await readJsonBody(req));
      if (incoming.id !== id) fail(400, 'Project ID does not match URL');
      const now = new Date().toISOString();
      const saved = { ...incoming, updatedAt: now };
      const updated = transaction(db, () => {
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) fail(404, 'Project not found');
        db.prepare('UPDATE projects SET title = ?, updated_at = ?, content_json = ? WHERE id = ?')
          .run(saved.title, now, JSON.stringify(saved), id);
        return saved;
      });
      sendJson(res, 200, updated);
      return;
    }
    if (req.method === 'DELETE') {
      const row = db.prepare('SELECT id, title, updated_at, content_json FROM projects WHERE id = ?').get(id);
      if (!row) fail(404, 'Project not found');
      const location = db.prepare('SELECT file_path FROM project_file_locations WHERE project_id = ?').get(id);
      const originalPath = location?.file_path ?? null;
      const sfeTrashName = originalPath ? trashStorage.moveIn(originalPath, `project-${id}`) : null;
      try {
        transaction(db, () => {
          const current = db.prepare('SELECT id, title, updated_at, content_json FROM projects WHERE id = ?').get(id);
          if (!current) fail(404, 'Project not found');
          const deletedAt = new Date().toISOString();
          db.prepare(`INSERT INTO trashed_projects (id, title, updated_at, deleted_at, content_json, sfe_original_path, sfe_trash_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(current.id, current.title, current.updated_at, deletedAt, current.content_json, sfeTrashName ? originalPath : null, sfeTrashName);
          db.prepare(`
            INSERT INTO trashed_snapshots (id, project_id, title, created_at, content_json)
            SELECT id, project_id, title, created_at, content_json FROM snapshots WHERE project_id = ?
          `).run(id);
          const manuallyDeleted = db.prepare("SELECT original_id, title, created_at, content_json FROM trashed_items WHERE project_id = ? AND kind = 'snapshot'").all(id);
          for (const snapshot of manuallyDeleted) {
            db.prepare('INSERT INTO trashed_snapshots (id, project_id, title, created_at, content_json) VALUES (?, ?, ?, ?, ?)')
              .run(snapshot.original_id, id, snapshot.title, snapshot.created_at, snapshot.content_json);
          }
          db.prepare("DELETE FROM trashed_items WHERE project_id = ? AND kind = 'snapshot'").run(id);
          db.prepare('DELETE FROM project_file_locations WHERE project_id = ?').run(id);
          db.prepare('DELETE FROM projects WHERE id = ?').run(id);
        });
      } catch (error) {
        if (sfeTrashName && originalPath) moveFile(path.join(trashStorage.dir, sfeTrashName), originalPath);
        throw error;
      }
      res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end();
      return;
    }
    fail(405, 'Method not allowed');
  }
  fail(404, 'Not found');
}

if (!/^(?:0|[1-9]\d{0,4})$/.test(PORT_TEXT) || !Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error('SCENEFORGE_PORT must be an integer between 0 and 65535');
}
persistToken();

const db = initializeDatabase();
try {
  const mapping = JSON.parse(process.env.SCENEFORGE_PORTABLE_PATH_MAP_JSON || 'null');
  const changed = rewritePortableDatabasePaths(db, mapping);
  if (changed.projectFiles || changed.trashedProjects) {
    console.log(`SceneForge portable paths migrated: ${changed.projectFiles} project files, ${changed.trashedProjects} trashed projects`);
  }
} catch (error) {
  db.close();
  throw new Error(`無法更新免安裝版劇本路徑：${error?.message ?? error}`);
}
const trashStorage = createTrashStorage(DATA_DIR);
features = createFeatures({ db, dataDir: DATA_DIR, trashStorage, readJsonBody, sendJson, fail, validateProject });
const handler = createHandler(db, trashStorage);
const server = http.createServer((req, res) => {
  const tracked = process.env.SCENEFORGE_PERF_LOG === '1'
    && ((req.method === 'PUT' && /^\/api\/projects\/[^/?]+$/.test(req.url ?? ''))
      || (req.method === 'POST' && req.url === '/api/render/stats'));
  if (!tracked) { void handler(req, res); return; }
  const started = process.hrtime.bigint();
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname;
    console.log(`[SF-PERF] ${req.method} ${routeTemplate(pathname)} status=${res.statusCode} server_ms=${durationMs.toFixed(2)}`);
  });
  void handler(req, res);
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(PORT, HOST, () => {
  const address = server.address();
  activePort = address.port;
  persistPort(activePort);
  console.log(`SceneForge listening on http://${HOST}:${activePort}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
