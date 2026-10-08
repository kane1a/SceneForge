import { APP_CONFIG } from './config';
import type { Project, ProjectSummary, SnapshotSummary, TrashedItemSummary, TrashedProjectSummary } from './types';
import type { ImportMemory } from './smart-import';

/** A script font: bundled with SceneForge, or installed on this computer (`local` = names for CSS local()). */
export interface FontInfo { id: string; family: string; css?: string; bundled: boolean; system?: boolean; local?: string[]; latin: boolean; cjk: boolean }
export interface ScriptStats { pages: number; scenes: number; hanChars: number; characters: number; dialogueLines: number; standardLines: number; minutes: number }
export interface TrashContents { projects: TrashedProjectSummary[]; items: TrashedItemSummary[] }
export interface BackupInfo { name: string; size: number; createdAt: string; kind: string }
export interface PageStart { blockId: string; page: number; continued: boolean }
export interface ExportOptions { template?: 'hollywood' | 'zh-inline'; sceneNumbers?: boolean; anonymous?: boolean; revised?: string[] }
export interface RenderRequest { project: Project; format: { paper: string; fontPt: number; lineSpacing: number; paragraphSpacing: number }; fonts: { latin: string; cjk: string }; includeCover?: boolean; options?: ExportOptions }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${APP_CONFIG.apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.error || payload?.message || '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(detail || `伺服器回應 ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  storage(): Promise<{ dataDir: string; database: string; backupsDir: string; trashDir: string }> {
    return request('/storage');
  },
  async listProjects(): Promise<ProjectSummary[]> {
    const result = await request<{ projects: ProjectSummary[] }>('/projects');
    if (!Array.isArray(result.projects)) throw new Error('專案清單格式錯誤。');
    return result.projects;
  },
  getProject(id: string): Promise<Project> {
    return request<Project>(`/projects/${encodeURIComponent(id)}`);
  },
  createProject(project: Project): Promise<Project> {
    return request<Project>('/projects', { method: 'POST', body: JSON.stringify(project) });
  },
  saveProject(project: Project): Promise<Project> {
    return request<Project>(`/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: JSON.stringify(project) });
  },
  deleteLibraryDocument(id: string, projectId: string): Promise<{ ok: boolean }> {
    return request(`/library/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  },
  async listSnapshots(id: string): Promise<SnapshotSummary[]> {
    const result = await request<{ snapshots: SnapshotSummary[] }>(`/projects/${encodeURIComponent(id)}/snapshots`);
    if (!Array.isArray(result.snapshots)) throw new Error('快照清單格式錯誤。');
    return result.snapshots;
  },
  createSnapshot(id: string): Promise<SnapshotSummary> {
    return request<SnapshotSummary>(`/projects/${encodeURIComponent(id)}/snapshots`, { method: 'POST' });
  },
  deleteSnapshot(id: string, snapshotId: string): Promise<{ ok: boolean }> {
    return request(`/projects/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}`, { method: 'DELETE' });
  },
  pruneSnapshots(id: string, keep: 0 | 10 | 20 | 50): Promise<{ ok: boolean; deleted: number; kept: number }> {
    return request(`/projects/${encodeURIComponent(id)}/snapshots/prune`, { method: 'POST', body: JSON.stringify({ keep }) });
  },
  restoreSnapshot(id: string, snapshotId: string): Promise<Project> {
    return request<Project>(`/projects/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(snapshotId)}/restore`, { method: 'POST' });
  },
  async listTrash(): Promise<TrashContents> {
    const result = await request<TrashContents>('/trash');
    if (!Array.isArray(result.projects) || !Array.isArray(result.items)) throw new Error('垃圾桶清單格式錯誤。');
    return result;
  },
  trashProject(id: string): Promise<void> {
    return request<void>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  getProjectFilePath(id: string): Promise<string | null> {
    return request<{ path: string | null }>(`/projects/${encodeURIComponent(id)}/file`).then((result) => result.path);
  },
  registerProjectFile(id: string, filePath: string): Promise<{ ok: boolean; path: string }> {
    return request(`/projects/${encodeURIComponent(id)}/file`, { method: 'PUT', body: JSON.stringify({ path: filePath }) });
  },
  deleteTrashItem(id: string): Promise<{ ok: boolean }> {
    return request(`/trash/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  restoreTrashItem(id: string): Promise<{ ok: boolean; kind: 'snapshot' | 'backup'; id?: string; name?: string }> {
    return request(`/trash/items/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  },
  async getImportMemory(): Promise<ImportMemory> {
    const result = await request<{ memory: ImportMemory }>('/import-memory');
    return result.memory;
  },
  async saveImportMemory(memory: ImportMemory): Promise<ImportMemory> {
    const result = await request<{ memory: ImportMemory }>('/import-memory', { method: 'PUT', body: JSON.stringify(memory) });
    return result.memory;
  },
  listFonts(): Promise<{ fonts: FontInfo[]; scanning: boolean }> {
    return request('/fonts');
  },
  renderStats(body: RenderRequest): Promise<{ stats: ScriptStats; pageStarts: PageStart[]; sceneEighths: Record<string, number> }> {
    return request('/render/stats', { method: 'POST', body: JSON.stringify(body) });
  },
  async getSnapshot(projectId: string, snapshotId: string): Promise<{ createdAt: string; project: Project }> {
    return request(`/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}`);
  },
  async renderPdf(body: RenderRequest): Promise<Blob> {
    const response = await fetch(`${APP_CONFIG.apiBase}/render/pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload?.error || `PDF 產生失敗（${response.status}）`); }
    return response.blob();
  },
  deleteBackup(name: string): Promise<{ ok: boolean }> {
    return request(`/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },
  pruneBackups(keep: number): Promise<{ ok: boolean; deleted: number; kept: number }> {
    return request('/backups/prune', { method: 'POST', body: JSON.stringify({ keep }) });
  },
  async listBackups(): Promise<{ backups: BackupInfo[]; intervalMinutes: number; keep: number }> {
    return request('/backups');
  },
  createBackup(): Promise<{ name: string }> {
    return request('/backups', { method: 'POST' });
  },
  restoreBackup(name: string): Promise<{ ok: boolean }> {
    return request(`/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' });
  },
  async getTrashDays(): Promise<number> {
    return (await request<{ days: number }>('/trash/settings')).days;
  },
  async setTrashDays(days: number): Promise<number> {
    return (await request<{ days: number }>('/trash/settings', { method: 'PUT', body: JSON.stringify({ days }) })).days;
  },
  deleteTrashed(id: string): Promise<{ ok: boolean }> {
    return request(`/trash/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  restoreTrashedProject(id: string): Promise<Project> {
    return request<Project>(`/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  },
};
