// Collects the license text of every third-party package shipped with SceneForge
// (bundled into the UI, or installed as a runtime dependency of the desktop app)
// and emits it as dist/THIRD_PARTY_LICENSES.txt.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

function packageDirFromModuleId(id) {
  const normalized = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0];
  const index = normalized.lastIndexOf('/node_modules/');
  if (index < 0) return null;
  const rest = normalized.slice(index + '/node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return `${normalized.slice(0, index)}/node_modules/${name}`;
}

function describe(dir) {
  const manifestPath = path.join(dir, 'package.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const license = typeof manifest.license === 'string' ? manifest.license
    : manifest.license?.type ?? (Array.isArray(manifest.licenses) ? manifest.licenses.map((l) => l.type).join(' OR ') : 'MIT');
  // Dual-licensed packages are used under MIT when it is one of the options.
  const chosen = /MIT/.test(license) && /OR/.test(license) ? 'MIT' : license;
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name ?? '';
  const files = readdirSync(dir).filter((name) => LICENSE_FILE.test(name)).sort();
  const text = files.map((name) => readFileSync(path.join(dir, name), 'utf8').trim()).join('\n\n');
  return { name: manifest.name, version: manifest.version, license: chosen, author, homepage: manifest.homepage ?? '', text, dependencies: Object.keys(manifest.dependencies ?? {}) };
}

export default function thirdPartyLicenses(root) {
  return {
    name: 'third-party-licenses',
    apply: 'build',
    generateBundle() {
      const dirs = new Set();
      for (const id of this.getModuleIds()) {
        const dir = packageDirFromModuleId(id);
        if (dir) dirs.add(dir);
      }
      // Runtime dependencies of the desktop app (packaged next to the UI).
      const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
      for (const [key, entry] of Object.entries(lock.packages ?? {})) {
        if (key && !entry.dev) dirs.add(path.join(root, key).replace(/\\/g, '/'));
      }
      dirs.add(path.join(root, 'node_modules/electron').replace(/\\/g, '/'));

      // Some packages ship a prebuilt bundle that already contains their own dependencies
      // (mammoth.browser.js, docx), so their dependency tree is listed too.
      const resolveDependency = (fromDir, name) => {
        let dir = fromDir;
        while (dir.includes('/node_modules/')) {
          const candidate = `${dir}/node_modules/${name}`;
          if (existsSync(path.join(candidate, 'package.json'))) return candidate;
          dir = dir.slice(0, dir.lastIndexOf('/node_modules/'));
        }
        const top = `${root.replace(/\\/g, '/')}/node_modules/${name}`;
        return existsSync(path.join(top, 'package.json')) ? top : null;
      };
      const seen = new Map();
      const queue = [...dirs];
      const visited = new Set();
      while (queue.length) {
        const dir = queue.shift();
        if (visited.has(dir)) continue;
        visited.add(dir);
        const info = describe(dir);
        if (!info) continue;
        if (!seen.has(`${info.name}@${info.version}`)) seen.set(`${info.name}@${info.version}`, info);
        if (info.name === 'electron') continue;
        for (const dependency of info.dependencies) {
          const next = resolveDependency(dir, dependency);
          if (next) queue.push(next);
        }
      }
      const packages = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
      const rule = '-'.repeat(72);
      const sections = packages.map((p) => [
        rule,
        `${p.name} ${p.version}`,
        `License: ${p.license}${p.homepage ? `\n${p.homepage}` : ''}`,
        '',
        p.text || `${p.author ? `Copyright (c) ${p.author}\n` : ''}Licensed under the ${p.license} license.`,
      ].join('\n'));
      const courierNote = [
        rule,
        'Courier Prime (Alan Dague-Greene for Quote-Unquote Apps)',
        'License: OFL-1.1',
        'https://quoteunquoteapps.com/courierprime/',
        '',
        'Licensed under the SIL Open Font License 1.1; see fonts/OFL.txt.',
      ].join('\n');
      const fontsNote = [
        rule,
        'Noto Sans Mono CJK TC (Google / Adobe)',
        'License: OFL-1.1',
        'https://github.com/googlefonts/noto-cjk',
        '',
        'Licensed under the SIL Open Font License 1.1; see fonts/OFL.txt.',
      ].join('\n');
      const electronNote = 'Electron also ships Chromium; its licenses are in LICENSES.chromium.html next to the application.';
      const header = [
        'SceneForge third-party licenses',
        '',
        'SceneForge includes the following open-source software and fonts.',
        electronNote,
        '',
      ].join('\n');
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: `${header}\n${[...sections, courierNote, fontsNote].join('\n\n')}\n`,
      });
    },
  };
}
