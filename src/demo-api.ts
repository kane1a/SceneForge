/**
 * Demo build only: answers the app's /api/* calls from localStorage so the full UI runs
 * as a static page (no local server). Never imported by the desktop build.
 */
import type { Project } from './types';

const KEY = 'sceneforge-demo-db-v1';
interface Db { projects: Project[]; trash: (Project & { deletedAt: string })[]; trashDays: number; snapshots: { id: string; projectId: string; createdAt: string; title: string; content: Project }[]; memory: unknown }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const uid = () => crypto.randomUUID();

function load(seed: () => Project[]): Db {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (stored?.projects) return { ...stored, trashDays: Number.isInteger(stored.trashDays) && stored.trashDays >= 0 ? stored.trashDays : 30 } as Db;
  } catch { /* storage unavailable: start fresh in memory */ }
  return { projects: seed(), trash: [], trashDays: 30, snapshots: [], memory: { characters: [], notCharacters: [], rules: [], corrections: 0 } };
}

export function installDemoApi(seed: () => Project[]) {
  const db = load(seed);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* keep in memory */ } };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const at = url.pathname.indexOf('/api/');
    if (at < 0) return realFetch(input, init);
    const parts = url.pathname.slice(at + 1).split('/').filter(Boolean).map(decodeURIComponent);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = () => JSON.parse(String(init?.body ?? '{}'));
    const now = () => new Date().toISOString();
    const summary = (project: Project) => ({ id: project.id, title: project.title, updatedAt: project.updatedAt });

    if (parts[1] === 'storage') return json(200, { dataDir: '瀏覽器本機儲存空間', database: '瀏覽器本機儲存空間', backupsDir: '瀏覽器本機儲存空間', trashDir: '示範版瀏覽器資料（不使用檔案垃圾桶資料夾）' });
    if (parts[1] === 'health') return json(200, { ok: true, app: 'SceneForge', version: 'demo' });
    if (parts[1] === 'library') {
      if (method === 'GET' && parts.length === 2) return json(200, { documents: [] });
      return json(501, { error: '示範版不含文件索引；請在本機版使用。' });
    }
    if (parts[1] === 'import-memory') {
      if (method === 'PUT') { db.memory = body(); save(); }
      return json(200, { memory: db.memory });
    }
    if (parts[1] === 'trash') {
      if (parts[2] === 'settings') {
        if (method === 'PUT') {
          const days = body().days;
          if (!Number.isInteger(days) || days < 0 || days > 3650) return json(400, { error: '保留天數無效' });
          db.trashDays = days;
          if (days > 0) { const cutoff = Date.now() - days * 86_400_000; db.trash = db.trash.filter((item) => Date.parse(item.deletedAt) >= cutoff); }
          save();
        }
        return json(200, { days: db.trashDays });
      }
      if (parts.length === 3 && method === 'DELETE') { db.trash = db.trash.filter((item) => item.id !== parts[2]); save(); return json(200, { ok: true }); }
      if (parts.length === 2) return json(200, { projects: db.trash.map((item) => ({ ...summary(item), deletedAt: item.deletedAt, snapshotCount: 0, sfeFile: false })), items: [] });
      const index = db.trash.findIndex((item) => item.id === parts[2]);
      if (index < 0) return json(404, { error: '找不到專案' });
      const [{ deletedAt: _deleted, ...restored }] = db.trash.splice(index, 1);
      db.projects.unshift(restored); save();
      return json(200, restored);
    }
    if (parts[1] === 'projects') {
      if (parts.length === 2) {
        if (method === 'GET') return json(200, { projects: [...db.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary) });
        const project = { ...body(), updatedAt: now() } as Project;
        db.projects.unshift(project); save();
        return json(201, project);
      }
      const project = db.projects.find((item) => item.id === parts[2]);
      if (!project) return json(404, { error: '找不到專案' });
      if (parts.length === 3) {
        if (method === 'GET') return json(200, project);
        if (method === 'PUT') { const next = { ...body(), updatedAt: now() } as Project; db.projects = db.projects.map((item) => item.id === next.id ? next : item); save(); return json(200, next); }
        if (method === 'DELETE') { db.projects = db.projects.filter((item) => item.id !== project.id); db.trash.unshift({ ...project, deletedAt: now() }); save(); return new Response(null, { status: 204 }); }
      }
      if (parts[3] === 'snapshots') {
        if (parts.length === 4 && method === 'GET') return json(200, { snapshots: db.snapshots.filter((item) => item.projectId === project.id).map(({ id, createdAt, title }) => ({ id, createdAt, title })).reverse() });
        if (parts.length === 4) { const snap = { id: uid(), projectId: project.id, createdAt: now(), title: project.title, content: structuredClone(project) }; db.snapshots.push(snap); save(); return json(201, { id: snap.id, createdAt: snap.createdAt, title: snap.title }); }
        const snap = db.snapshots.find((item) => item.id === parts[4]);
        if (!snap) return json(404, { error: '找不到快照' });
        const restored = { ...snap.content, updatedAt: now() };
        db.projects = db.projects.map((item) => item.id === project.id ? restored : item); save();
        return json(200, restored);
      }
    }
    return json(404, { error: 'Not found' });
  };
}
