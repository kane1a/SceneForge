// Fonts, PDF/statistics rendering and automatic backups.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { BUNDLED_FONTS } from './bundled-fonts.mjs';
import { createSystemFonts } from './system-fonts.mjs';
import { moveFile } from './trash-storage.mjs';

// The print engine (pdfkit + fontkit) loads on first use, not at start-up.
let enginePromise = null;
const engine = () => (enginePromise ??= import('./pdf-layout.mjs'));
const FONT_TYPES = new Map([['.ttf', 'font/ttf'], ['.otf', 'font/otf'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttc', 'font/collection']]);
const BACKUP_KEEP = 30;
const BACKUP_INTERVAL_MS = 20 * 60 * 1000;

export function createFeatures({ db, dataDir, trashStorage, readJsonBody, sendJson, fail, validateProject }) {
  const backupDir = path.join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });

  // ——— Fonts: the bundled pair plus everything installed on this computer ———
  const systemFonts = createSystemFonts(dataDir);
  setTimeout(() => { void systemFonts.scan().catch((error) => console.error('Font scan failed:', error.message)); }, 1500).unref?.();
  const listFonts = () => [
    ...Object.entries(BUNDLED_FONTS).map(([id, font]) => ({ id, family: font.label, css: font.css, bundled: true, system: false, latin: font.script === 'latin', cjk: font.script === 'cjk' })),
    ...systemFonts.list(),
  ];
  const fontSpec = (id, bold = false) => {
    if (BUNDLED_FONTS[id]) return bold ? BUNDLED_FONTS[id].bold ?? BUNDLED_FONTS[id].regular : BUNDLED_FONTS[id].regular;
    return typeof id === 'string' ? systemFonts.resolve(id, bold) : null;
  };
  const fontSetFor = async (fonts = {}) => {
    const { createFontSet } = await engine();
    const latin = fontSpec(fonts.latin) ?? BUNDLED_FONTS['courier-prime'].regular;
    const latinBold = fontSpec(fonts.latin, true) ?? latin;
    const cjk = fontSpec(fonts.cjk) ?? BUNDLED_FONTS['noto-mono-cjk'].regular;
    try { return createFontSet({ latin, latinBold, cjk }); }
    catch { return createFontSet({ latin: BUNDLED_FONTS['courier-prime'].regular, latinBold: BUNDLED_FONTS['courier-prime'].bold, cjk: BUNDLED_FONTS['noto-mono-cjk'].regular }); }
  };

  // ——— Backups ———
  let lastBackupSignature = '';
  const signature = () => {
    const row = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM projects').get();
    const trash = db.prepare('SELECT COUNT(*) AS n FROM trashed_projects').get();
    return `${row.n}|${row.latest}|${trash.n}`;
  };
  const listBackups = () => readdirSync(backupDir).filter((name) => name.endsWith('.sqlite')).map((name) => {
    const stat = statSync(path.join(backupDir, name));
    return { name, size: stat.size, createdAt: stat.mtime.toISOString(), kind: name.split('-')[0] };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const makeBackup = (kind = 'auto') => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
    const name = `${kind}-${stamp}-${randomUUID().slice(0, 6)}.sqlite`;
    db.exec(`VACUUM INTO '${path.join(backupDir, name).replace(/'/g, "''")}'`);
    lastBackupSignature = signature();
    const autos = listBackups().filter((item) => item.kind === 'auto');
    for (const old of autos.slice(BACKUP_KEEP)) { try { unlinkSync(path.join(backupDir, old.name)); } catch { /* ignore */ } }
    return name;
  };
  const autoBackup = () => {
    try { if (signature() !== lastBackupSignature) makeBackup('auto'); } catch (error) { console.error('Automatic backup failed:', error.message); }
  };
  autoBackup();
  const timer = setInterval(autoBackup, BACKUP_INTERVAL_MS);
  timer.unref();

  const TABLES = ['projects', 'snapshots', 'trashed_projects', 'trashed_snapshots', 'settings'];
  const restoreBackup = (name) => {
    if (!/^[\w-]+\.sqlite$/.test(name) || !existsSync(path.join(backupDir, name))) fail(404, '找不到備份');
    makeBackup('before-restore');
    db.exec(`ATTACH DATABASE '${path.join(backupDir, name).replace(/'/g, "''")}' AS restore_source`);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of TABLES) {
          const exists = db.prepare("SELECT 1 FROM restore_source.sqlite_master WHERE type = 'table' AND name = ?").get(table);
          db.exec(`DELETE FROM main.${table}`);
          if (exists) db.exec(`INSERT INTO main.${table} SELECT * FROM restore_source.${table}`);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.exec('DETACH DATABASE restore_source'); }
    lastBackupSignature = signature();
  };

  // ——— Trash retention ———
  const readSetting = (key, fallback) => {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value_json) : fallback;
  };
  const writeSetting = (key, value) => db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
    .run(key, JSON.stringify(value), new Date().toISOString());
  const trashDays = () => { const days = readSetting('trash-days', 30); return Number.isInteger(days) && days >= 0 ? days : 30; };
  const purgeTrash = (id) => {
    const days = trashDays();
    const cutoff = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
    const projects = id
      ? db.prepare('SELECT id, sfe_trash_name FROM trashed_projects WHERE id = ?').all(id)
      : cutoff ? db.prepare('SELECT id, sfe_trash_name FROM trashed_projects WHERE deleted_at < ?').all(cutoff) : [];
    const items = id ? [] : cutoff
      ? db.prepare('SELECT id, trash_name FROM trashed_items WHERE deleted_at < ?').all(cutoff)
      : [];
    for (const project of projects) trashStorage.remove(project.sfe_trash_name);
    for (const item of items) trashStorage.remove(item.trash_name);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (id) {
        db.prepare('DELETE FROM trashed_snapshots WHERE project_id = ?').run(id);
        db.prepare('DELETE FROM trashed_items WHERE project_id = ?').run(id);
        db.prepare('DELETE FROM trashed_projects WHERE id = ?').run(id);
      } else if (cutoff) {
        db.prepare('DELETE FROM trashed_snapshots WHERE project_id IN (SELECT id FROM trashed_projects WHERE deleted_at < ?)').run(cutoff);
        db.prepare('DELETE FROM trashed_projects WHERE deleted_at < ?').run(cutoff);
        db.prepare('DELETE FROM trashed_items WHERE deleted_at < ?').run(cutoff);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const deleteTrashItem = (id) => {
    const item = db.prepare('SELECT kind, trash_name FROM trashed_items WHERE id = ?').get(id);
    if (!item) fail(404, '找不到垃圾桶項目');
    if (item.kind === 'backup') trashStorage.remove(item.trash_name);
    const deleted = db.prepare('DELETE FROM trashed_items WHERE id = ?').run(id);
    if (!Number(deleted.changes)) fail(404, '找不到垃圾桶項目');
  };
  const restoreTrashItem = (id) => {
    const item = db.prepare('SELECT * FROM trashed_items WHERE id = ?').get(id);
    if (!item) fail(404, '找不到垃圾桶項目');
    if (item.kind === 'snapshot') {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(item.project_id)) fail(409, '請先還原所屬劇本，再還原快照');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO snapshots (id, project_id, title, created_at, content_json) VALUES (?, ?, ?, ?, ?)')
          .run(item.original_id, item.project_id, item.title, item.created_at, item.content_json);
        db.prepare('DELETE FROM trashed_items WHERE id = ?').run(id);
        db.exec('COMMIT');
        return { ok: true, kind: 'snapshot', id: item.original_id };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (typeof item.original_name !== 'string' || path.basename(item.original_name) !== item.original_name || !item.original_name.endsWith('.sqlite')) fail(400, '備份檔名無效');
    const restoredPath = trashStorage.restore(item.trash_name, path.join(backupDir, item.original_name));
    if (!restoredPath) fail(404, '找不到垃圾桶內的備份檔');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM trashed_items WHERE id = ?').run(id);
      db.exec('COMMIT');
      return { ok: true, kind: 'backup', name: path.basename(restoredPath) };
    } catch (error) {
      db.exec('ROLLBACK');
      moveFile(restoredPath, path.join(trashStorage.dir, item.trash_name));
      throw error;
    }
  };
  try { purgeTrash(); } catch (error) { console.error('Trash purge failed:', error.message); }
  const purgeTimer = setInterval(() => { try { purgeTrash(); } catch { /* retry next hour */ } }, 3_600_000);
  purgeTimer.unref();

  return async function handleFeatures(req, res, segments) {
    if (segments[0] !== 'api') return false;

    if (segments[1] === 'trash' && segments[2] === 'items' && segments.length === 5 && segments[4] === 'restore' && req.method === 'POST') {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(segments[3])) fail(400, 'Invalid ID');
      sendJson(res, 200, restoreTrashItem(segments[3]));
      return true;
    }
    if (segments[1] === 'trash' && segments[2] === 'items' && segments.length === 4 && req.method === 'DELETE') {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(segments[3])) fail(400, 'Invalid ID');
      deleteTrashItem(segments[3]);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (segments[1] === 'trash' && segments[2] === 'settings' && segments.length === 3) {
      if (req.method === 'GET') { sendJson(res, 200, { days: trashDays() }); return true; }
      if (req.method !== 'PUT') fail(405, 'Method not allowed');
      const body = await readJsonBody(req);
      if (!Number.isInteger(body.days) || body.days < 0 || body.days > 3650) fail(400, '保留天數無效');
      writeSetting('trash-days', body.days);
      purgeTrash();
      sendJson(res, 200, { days: body.days });
      return true;
    }
    if (segments[1] === 'trash' && segments.length === 3 && req.method === 'DELETE') {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(segments[2])) fail(400, 'Invalid ID');
      purgeTrash(segments[2]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (segments[1] === 'fonts') {
      if (segments.length === 2 && req.method === 'GET') { sendJson(res, 200, { fonts: listFonts(), scanning: systemFonts.scanning }); return true; }
      if (segments.length === 4 && segments[3] === 'file' && req.method === 'GET' && BUNDLED_FONTS[segments[2]]) {
        const file = fontSpec(segments[2], new URL(req.url, 'http://local').searchParams.get('bold') === '1');
        if (!file || !existsSync(file)) fail(404, '找不到字型');
        const body = readFileSync(file);
        res.writeHead(200, { 'Content-Type': FONT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        res.end(body);
        return true;
      }
      fail(404, '找不到字型');
    }

    if (segments[1] === 'render' && segments.length === 3 && req.method === 'POST') {
      const body = await readJsonBody(req);
      let project = validateProject(body.project);
      const format = body.format && typeof body.format === 'object' ? body.format : {};
      const fontSet = await fontSetFor(body.fonts);
      const { layoutScript, renderPdf } = await engine();
      const opts = body.options && typeof body.options === 'object' ? body.options : {};
      const layoutOptions = {
        template: opts.template === 'zh-inline' ? 'zh-inline' : 'hollywood',
        sceneNumbers: opts.sceneNumbers === true,
        revised: new Set(Array.isArray(opts.revised) ? opts.revised.filter((id) => typeof id === 'string').slice(0, 25000) : []),
      };
      // Anonymous submission: no author, contact or metadata anywhere in the file.
      if (opts.anonymous === true) project = { ...project, titlePage: project.titlePage ? { ...project.titlePage, author: '', contact: '', notes: '' } : undefined };
      if (segments[2] === 'stats') {
        const layout = layoutScript(project, format, fontSet, layoutOptions);
        sendJson(res, 200, { stats: layout.stats, pageStarts: layout.pageStarts, sceneEighths: layout.sceneEighths });
        return true;
      }
      if (segments[2] === 'pdf') {
        const { buffer, stats } = await renderPdf(project, format, fontSet, { includeCover: body.includeCover !== false, anonymous: opts.anonymous === true, ...layoutOptions });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buffer.length, 'Cache-Control': 'no-store', 'X-SceneForge-Pages': String(stats.pages), 'X-Content-Type-Options': 'nosniff' });
        res.end(buffer);
        return true;
      }
      fail(404, 'Not found');
    }

    if (segments[1] === 'projects' && segments[3] === 'snapshots' && segments.length === 5 && req.method === 'GET') {
      const row = db.prepare('SELECT content_json, created_at FROM snapshots WHERE project_id = ? AND id = ?').get(segments[2], segments[4]);
      if (!row) fail(404, '找不到快照');
      sendJson(res, 200, { createdAt: row.created_at, project: JSON.parse(row.content_json) });
      return true;
    }

    if (segments[1] === 'backups') {
      if (segments.length === 2 && req.method === 'GET') { sendJson(res, 200, { backups: listBackups(), intervalMinutes: BACKUP_INTERVAL_MS / 60000, keep: BACKUP_KEEP }); return true; }
      if (segments.length === 2 && req.method === 'POST') { const name = makeBackup('manual'); sendJson(res, 201, { name }); return true; }
      if (segments.length === 4 && segments[3] === 'restore' && req.method === 'POST') { restoreBackup(segments[2]); sendJson(res, 200, { ok: true }); return true; }
      if (segments.length === 3 && req.method === 'DELETE') {
        const name = segments[2];
        if (!/^[\w-]+\.sqlite$/.test(name) || !existsSync(path.join(backupDir, name))) fail(404, '找不到備份');
        const source = path.join(backupDir, name);
        const stat = statSync(source);
        const trashItemId = randomUUID();
        const deletedAt = new Date().toISOString();
        const trashName = trashStorage.moveIn(source, `backup-${trashItemId}`);
        if (!trashName) fail(404, '找不到備份');
        try {
          db.prepare(`INSERT INTO trashed_items (id, kind, title, original_name, created_at, deleted_at, trash_name)
            VALUES (?, 'backup', ?, ?, ?, ?, ?)`)
            .run(trashItemId, name, name, stat.mtime.toISOString(), deletedAt, trashName);
        } catch (error) {
          moveFile(path.join(trashStorage.dir, trashName), source);
          throw error;
        }
        sendJson(res, 200, { ok: true, trashItemId });
        return true;
      }
      if (segments.length === 3 && segments[2] === 'prune' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const keep = Number(body.keep);
        if (!Number.isInteger(keep) || keep < 0 || keep > 1000) fail(400, '保留數量不正確。');
        let deleted = 0;
        for (const old of listBackups().slice(keep)) { try { unlinkSync(path.join(backupDir, old.name)); deleted += 1; } catch { /* ignore */ } }
        sendJson(res, 200, { ok: true, deleted, kept: keep });
        return true;
      }
      fail(405, 'Method not allowed');
    }
    return false;
  };
}
