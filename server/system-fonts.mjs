// Fonts installed on the writer's computer, found by scanning the usual font folders.
// Scanning runs in the background after start-up and is cached, so only new or changed
// files are ever parsed again.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc']);
const MAX_FILE_BYTES = 80 * 1024 * 1024;
const CACHE_VERSION = 2;

function fontFolders() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const windows = process.env.WINDIR || 'C:\\Windows';
    return [path.join(windows, 'Fonts'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  }
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local', 'share', 'fonts')];
}

function listFiles(dir, depth = 0, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 4) listFiles(full, depth + 1, out);
    else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const pickName = (records, preferZh) => {
  if (!records) return '';
  if (preferZh) for (const key of ['zh-TW', 'zh-HK', 'zh', 'zh-CN']) if (records[key]) return records[key];
  return records.en ?? Object.values(records)[0] ?? '';
};

function describeFaces(fontkit, file) {
  const font = fontkit.openSync(file);
  const faces = 'fonts' in font ? font.fonts : [font];
  return faces.map((face) => {
    const has = (ch) => { try { const glyph = face.glyphForCodePoint(ch.codePointAt(0)); return !!glyph && glyph.id !== 0; } catch { return false; } };
    const records = face.name?.records ?? {};
    const family = pickName(records.preferredFamily, false) || pickName(records.fontFamily, false) || face.familyName;
    const displayFamily = pickName(records.preferredFamily, true) || pickName(records.fontFamily, true) || family;
    const style = (pickName(records.preferredSubfamily, false) || pickName(records.fontSubfamily, false) || face.subfamilyName || '').toLowerCase();
    return {
      ps: face.postscriptName,
      full: pickName(records.fullName, false) || face.fullName || family,
      family,
      display: displayFamily,
      weight: face['OS/2']?.usWeightClass ?? (/bold/.test(style) ? 700 : 400),
      italic: /italic|oblique/.test(style) || (face.italicAngle ?? 0) !== 0,
      latin: has('A') && has('a') && has('0'),
      cjk: has('中') && has('劇') && has('的'),
      collection: faces.length > 1,
    };
  }).filter((face) => face.ps && (face.latin || face.cjk));
}

export function createSystemFonts(dataDir) {
  const cacheFile = path.join(dataDir, 'system-fonts.json');
  let cache = { version: CACHE_VERSION, files: {} };
  try { const saved = JSON.parse(readFileSync(cacheFile, 'utf8')); if (saved.version === CACHE_VERSION) cache = saved; } catch { /* first scan */ }
  let scanning = false;
  let families = [];
  const byId = new Map();

  const rebuild = () => {
    const groups = new Map();
    for (const [file, entry] of Object.entries(cache.files)) {
      for (const face of entry.faces) {
        const key = face.family;
        if (!groups.has(key)) groups.set(key, { family: face.family, display: face.display, faces: [] });
        groups.get(key).faces.push({ ...face, file });
      }
    }
    byId.clear();
    families = [...groups.values()].map((group) => {
      const upright = group.faces.filter((face) => !face.italic);
      const pool = upright.length ? upright : group.faces;
      const regular = pool.reduce((best, face) => Math.abs(face.weight - 400) < Math.abs(best.weight - 400) ? face : best);
      const bold = pool.filter((face) => face.weight >= 600).sort((a, b) => Math.abs(a.weight - 700) - Math.abs(b.weight - 700))[0];
      const id = `sys-${createHash('sha1').update(group.family).digest('hex').slice(0, 16)}`;
      const item = { id, family: group.display || group.family, css: group.family, regular, bold, latin: group.faces.some((face) => face.latin), cjk: group.faces.some((face) => face.cjk) };
      byId.set(id, item);
      return item;
    }).sort((a, b) => Number(b.cjk) - Number(a.cjk) || a.family.localeCompare(b.family, 'zh-Hant'));
  };
  rebuild();

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const fontkit = await import('fontkit');
      const files = fontFolders().filter((dir) => existsSync(dir)).flatMap((dir) => listFiles(dir));
      const seen = new Set(files);
      let changed = false;
      for (const file of Object.keys(cache.files)) if (!seen.has(file)) { delete cache.files[file]; changed = true; }
      let parsed = 0;
      for (const file of files) {
        let stat;
        try { stat = statSync(file); } catch { continue; }
        const known = cache.files[file];
        if (known && known.size === stat.size && known.mtime === stat.mtimeMs) continue;
        if (stat.size > MAX_FILE_BYTES) continue;
        let faces = [];
        try { faces = describeFaces(fontkit, file); } catch { faces = []; }
        cache.files[file] = { size: stat.size, mtime: stat.mtimeMs, faces };
        changed = true;
        // Keep the server responsive while a large font folder is read for the first time.
        if (++parsed % 8 === 0) { rebuild(); await new Promise((resolve) => setImmediate(resolve)); }
      }
      if (changed) {
        rebuild();
        try { writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* cache is optional */ }
      }
    } finally {
      scanning = false;
    }
  }

  return {
    scan,
    get scanning() { return scanning; },
    list: () => families.map(({ id, family, css, latin, cjk, regular }) => ({ id, family, css, latin, cjk, bundled: false, system: true, local: [regular.ps, regular.full] })),
    /** { file, face } for the PDF engine; `face` is the PostScript name inside a collection. */
    resolve(id, bold = false) {
      const item = byId.get(id);
      if (!item) return null;
      const face = bold && item.bold ? item.bold : item.regular;
      return { file: face.file, face: face.collection ? face.ps : undefined };
    },
  };
}
