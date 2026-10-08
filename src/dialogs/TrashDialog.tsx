import { useEffect, useState } from 'react';
import { api } from '../api';
import { askConfirm } from '../confirm';
import { StorageLocation } from '../storage-location';
import { Select } from '../ui-controls';
import type { TrashedItemSummary, TrashedProjectSummary } from '../types';

type Entry = { kind: 'project'; item: TrashedProjectSummary } | { kind: 'snapshot' | 'backup'; item: TrashedItemSummary };

export default function TrashDialog({ onClose, notify, onRestored }: { onClose: () => void; notify: (text: string) => void; onRestored: (projectId: string) => Promise<void> }) {
  const [projects, setProjects] = useState<TrashedProjectSummary[]>([]);
  const [items, setItems] = useState<TrashedItemSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);
  const reload = async () => { const contents = await api.listTrash(); setProjects(contents.projects); setItems(contents.items); return contents; };
  useEffect(() => {
    void Promise.all([api.listTrash(), api.getTrashDays().catch(() => 30)]).then(([contents, retention]) => { setProjects(contents.projects); setItems(contents.items); setDays(retention); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '無法讀取垃圾桶。')).finally(() => setBusy(false));
  }, []);
  const changeDays = async (value: number) => {
    setBusy(true); setError('');
    try { await api.setTrashDays(value); setDays(value); await reload(); notify(value ? `垃圾桶會在 ${value} 天後自動清除，已立即清理過期項目` : '垃圾桶不再自動清除'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '無法儲存設定。'); }
    finally { setBusy(false); }
  };
  const removeForever = async (entry: Entry) => {
    const title = entry.kind === 'backup' ? entry.item.originalName ?? entry.item.title : entry.item.title;
    const message = entry.kind === 'project' ? `劇本${entry.item.sfeFile ? '與對應的 .sfe 檔' : ''}及 ${entry.item.snapshotCount} 個快照都會永久刪除。` : entry.kind === 'backup' ? `備份檔「${title}」會從垃圾桶資料夾永久刪除。` : '這份版本快照會永久刪除。';
    if (!(await askConfirm({ title: `永久刪除「${title}」？`, message, confirmLabel: '永久刪除', cancelLabel: '取消', danger: true }))) return;
    setBusy(true); setError('');
    try {
      if (entry.kind === 'project') await api.deleteTrashed(entry.item.id); else await api.deleteTrashItem(entry.item.id);
      const contents = await reload();
      if (entry.kind === 'project' ? contents.projects.some((item) => item.id === entry.item.id) : contents.items.some((item) => item.id === entry.item.id)) throw new Error('永久刪除後的讀回驗證失敗。');
      notify('已永久刪除');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '刪除失敗。'); }
    finally { setBusy(false); }
  };
  const restoreProject = async (item: TrashedProjectSummary) => {
    setBusy(true); setError('');
    try {
      const restored = await api.restoreTrashedProject(item.id);
      const [listed, contents, readback] = await Promise.all([api.listProjects(), api.listTrash(), api.getProject(item.id)]);
      if (!listed.some((entry) => entry.id === item.id) || contents.projects.some((entry) => entry.id === item.id) || restored.id !== readback.id) throw new Error('還原後的讀回驗證失敗。');
      setProjects(contents.projects); setItems(contents.items); await onRestored(item.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '還原專案失敗。'); }
    finally { setBusy(false); }
  };
  const restoreItem = async (item: TrashedItemSummary) => {
    setBusy(true); setError('');
    try {
      const result = await api.restoreTrashItem(item.id);
      const contents = await api.listTrash();
      if (contents.items.some((entry) => entry.id === item.id)) throw new Error('還原後的讀回驗證失敗。');
      if (item.kind === 'snapshot') {
        if (!item.projectId || !item.originalId || result.id !== item.originalId || !(await api.listSnapshots(item.projectId)).some((snap) => snap.id === item.originalId)) throw new Error('還原後找不到原版本快照。');
      } else if (!result.name || !(await api.listBackups()).backups.some((backup) => backup.name === result.name)) throw new Error('還原後找不到備份檔。');
      setProjects(contents.projects); setItems(contents.items); notify(item.kind === 'snapshot' ? '已還原快照' : '已還原備份');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '還原失敗。'); }
    finally { setBusy(false); }
  };
  const entries: Entry[] = [...projects.map((item) => ({ kind: 'project' as const, item })), ...items.map((item) => ({ kind: item.kind, item }))];
  const label = (kind: Entry['kind']) => kind === 'project' ? '劇本' : kind === 'snapshot' ? '快照' : '備份';
  const titleOf = (entry: Entry) => entry.kind === 'backup' ? entry.item.originalName ?? entry.item.title : entry.item.title;
  const deletedAt = (entry: Entry) => entry.item.deletedAt;
  const restore = (entry: Entry) => entry.kind === 'project' ? void restoreProject(entry.item) : void restoreItem(entry.item);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="app-dialog trash-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-title">
      <header><div><p className="eyebrow">可還原的內容</p><h2 id="trash-title">垃圾桶</h2></div><button className="dialog-close" aria-label="關閉垃圾桶" disabled={busy} onClick={onClose}>×</button></header>
      <p className="dialog-copy">劇本、手動刪除的快照與備份都會先移到 SceneForge 垃圾桶，期限內可以還原。</p>
      <StorageLocation label="檔案垃圾桶存放在" folder="trash" note=".sfe 與備份檔存放於此資料夾；快照內容仍保存在 SceneForge 資料庫。" />
      <div className="trash-retention"><span>自動永久刪除</span><Select ariaLabel="自動永久刪除" value={String(days)} options={[...[7, 14, 30, 60, 90, 180].map((count) => ({ value: String(count), label: `${count} 天後` })), { value: '0', label: '永不自動刪除' }]} onChange={(value) => void changeDays(Number(value))} disabled={busy} /></div>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {busy ? <p className="dialog-copy">正在處理…</p> : !entries.length ? <p className="dialog-empty">垃圾桶目前是空的。</p> : <ul className="trash-list">{entries.map((entry) => {
        const left = days > 0 ? Math.max(0, Math.ceil((new Date(deletedAt(entry)).getTime() + days * 86_400_000 - Date.now()) / 86_400_000)) : null;
        return <li key={`${entry.kind}:${entry.item.id}`} data-trash-kind={entry.kind}><div><strong><span className="trash-kind-label">{label(entry.kind)}</span> {titleOf(entry)}</strong><span>移入 {new Date(deletedAt(entry)).toLocaleDateString('zh-TW')}{entry.kind === 'project' ? ` · ${entry.item.snapshotCount} 個快照${entry.item.sfeFile ? ' · 含 .sfe 檔' : ''}` : entry.kind === 'snapshot' ? ' · 版本快照' : ' · 整體資料備份'}{left !== null && <em className={left <= 3 ? 'soon' : ''}> · {left === 0 ? '今天刪除' : `${left} 天後永久刪除`}</em>}</span></div><div className="trash-actions"><button className="button-ghost button-small" disabled={busy} onClick={() => restore(entry)}>還原</button><button className="text-button danger-text" disabled={busy} onClick={() => void removeForever(entry)}>永久刪除</button></div></li>;
      })}</ul>}
    </section>
  </div>;
}
