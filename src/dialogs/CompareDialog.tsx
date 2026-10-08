import { useEffect, useState } from 'react';
import { api } from '../api';
import { askConfirm, askConfirmWithOption } from '../confirm';
import { BLOCK_LABELS } from '../config';
import { charDiff, diffProjects } from '../diff';
import { StorageLocation } from '../storage-location';
import { Select } from '../ui-controls';
import type { Project, SnapshotSummary } from '../types';

export type RevisionBase = { id: string; createdAt: string; project: Project };

/** 工具 › 版本比對與修訂。快照清單與比較狀態在這裡；修訂基準與保留數量由 App 保存。 */
export default function CompareDialog({ project, demo, revisionBase, revisedCount, snapshotKeep, onSnapshotKeepChange, onRevisionBase, onRevisionBaseRemoved, notify, onError, onClose }: {
  project: Project;
  demo: boolean;
  revisionBase: RevisionBase | null;
  revisedCount: number;
  snapshotKeep: 0 | 10 | 20 | 50;
  onSnapshotKeepChange: (keep: 0 | 10 | 20 | 50) => void;
  onRevisionBase: (base: RevisionBase | null) => void;
  onRevisionBaseRemoved: () => void;
  notify: (text: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const [compareList, setCompareList] = useState<SnapshotSummary[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState('');
  const [compareWith, setCompareWith] = useState<RevisionBase | null>(null);
  useEffect(() => {
    if (demo) return;
    (async () => {
      try {
        const list = await api.listSnapshots(project.id);
        setCompareList(list);
        setSnapshots(list);
      } catch (error) {
        setCompareList([]);
        setSnapshots([]);
        setSnapshotError(error instanceof Error ? error.message : '無法載入版本快照。');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const chooseCompare = async (snapshotId: string) => {
    if (!snapshotId) { setCompareWith(null); return; }
    try { const snap = await api.getSnapshot(project.id, snapshotId); setCompareWith({ id: snapshotId, createdAt: snap.createdAt, project: snap.project }); }
    catch (error) { onError(error instanceof Error ? error.message : '無法讀取快照。'); }
  };
  const useAsRevisionBase = (base: { id: string; createdAt: string; project: Project } | null) => {
    onRevisionBase(base);
  };
  const snapshotNow = async () => {
    if (snapshotBusy) return;
    setSnapshotBusy(true);
    setSnapshotError('');
    try {
      await api.createSnapshot(project.id);
      const list = await api.listSnapshots(project.id);
      setCompareList(list);
      setSnapshots(list);
      notify('已建立快照');
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : '建立快照失敗。');
    } finally { setSnapshotBusy(false); }
  };
  const deleteSnapshot = async (snapshot: SnapshotSummary) => {
    if (snapshotBusy) return;
    const confirmed = await askConfirm({ title: '刪除這個快照？', message: `「${snapshot.title}」建立於 ${new Date(snapshot.createdAt).toLocaleString('zh-TW')}。刪除後會移至 SceneForge 垃圾桶，期限內可以還原。`, confirmLabel: '移至垃圾桶', cancelLabel: '取消', danger: true });
    if (!confirmed) return;
    setSnapshotBusy(true);
    setSnapshotError('');
    try {
      await api.deleteSnapshot(project.id, snapshot.id);
      const list = await api.listSnapshots(project.id);
      setCompareList(list);
      setSnapshots(list);
      if (compareWith?.id === snapshot.id) setCompareWith(null);
      if (revisionBase?.id === snapshot.id) {
        onRevisionBaseRemoved();
      }
      notify('已移至垃圾桶');
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : '刪除快照失敗。');
    } finally { setSnapshotBusy(false); }
  };
  const pruneSnapshots = async () => {
    if (snapshotBusy) return;
    let keep: 0 | 10 | 20 | 50 = 0;
    if (snapshotKeep === 0) {
      const confirmed = await askConfirm({ title: '清除全部快照？', message: `這個劇本的 ${snapshots.length} 個快照都會永久刪除，無法復原。`, confirmLabel: '全部清除', cancelLabel: '取消', danger: true });
      if (!confirmed) return;
    } else {
      const answer = await askConfirmWithOption({ title: '清除舊快照？', message: '清除的快照會永久刪除，無法復原。關閉下方選項會清除全部快照。', confirmLabel: '清除', cancelLabel: '取消', danger: true, option: { label: `保留最新 ${snapshotKeep} 個快照`, checked: true } });
      if (!answer.confirmed) return;
      keep = answer.option ? snapshotKeep : 0;
    }
    setSnapshotBusy(true);
    setSnapshotError('');
    try {
      const result = await api.pruneSnapshots(project.id, keep);
      const list = await api.listSnapshots(project.id);
      setCompareList(list);
      setSnapshots(list);
      if (compareWith && !list.some((item) => item.id === compareWith.id)) setCompareWith(null);
      if (revisionBase && !list.some((item) => item.id === revisionBase.id)) {
        onRevisionBaseRemoved();
      }
      notify(result.deleted ? `已清除 ${result.deleted} 個舊快照` : '沒有需要清除的舊快照');
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : '清除舊快照失敗。');
    } finally { setSnapshotBusy(false); }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <section className="app-dialog compare-dialog" role="dialog" aria-modal="true" aria-labelledby="compare-title">
          <header><div><p className="eyebrow">版本</p><h2 id="compare-title">版本比對與修訂</h2></div><button className="dialog-close" aria-label="關閉" onClick={() => onClose()}>×</button></header>
          {demo ? <p className="dialog-empty">示範版沒有快照資料庫；電腦版可比對任兩個版本並標示修訂。</p> : <>
            <div className="compare-bar">
              <label className="compare-select-label">與此版本比較<Select ariaLabel="選擇比較快照" value={compareWith?.id ?? ''} options={[{ value: '', label: '選擇快照…' }, ...compareList.map((snap) => ({ value: snap.id, label: `${snap.title} · ${new Date(snap.createdAt).toLocaleString('zh-TW')}` }))]} onChange={(value) => void chooseCompare(value)} disabled={snapshotBusy} /></label>
              <button className="button-ghost" disabled={snapshotBusy} onClick={() => void snapshotNow()}>先建立目前快照</button>
            </div>
            <StorageLocation label="版本快照存放在" folder="data" note="快照不是個別檔案，和劇本一起存在 SceneForge 資料庫（sceneforge.sqlite）裡。" />
            <div className="snapshot-management">
              <div className="snapshot-retention-row">
                <span>清理舊快照</span>
                <Select ariaLabel="保留快照數量" className="snapshot-retention-select" value={String(snapshotKeep)} options={[...[10, 20, 50].map((count) => ({ value: String(count), label: `保留最新 ${count} 個` })), { value: '0', label: '不保留' }]} onChange={(value) => onSnapshotKeepChange(Number(value) as 0 | 10 | 20 | 50)} disabled={snapshotBusy} />
                <button className="button-ghost button-small" disabled={snapshotBusy || !snapshots.length} onClick={() => void pruneSnapshots()}>清除舊快照…</button>
              </div>
              {snapshotError && <p className="dialog-error" role="alert">{snapshotError}</p>}
              {!snapshots.length ? <p className="dialog-empty">尚無版本快照。</p> : <ul className="snapshot-list" aria-label="版本快照清單">{snapshots.map((snap) => <li key={snap.id}>
                <div><strong>{snap.title || '未命名劇本'}</strong><small>{new Date(snap.createdAt).toLocaleString('zh-TW')}</small></div>
                <button className="button-ghost button-small" disabled={snapshotBusy} onClick={() => void chooseCompare(snap.id)}>比較</button>
                <button className="text-button danger-text" disabled={snapshotBusy} onClick={() => void deleteSnapshot(snap)}>刪除</button>
              </li>)}</ul>}
            </div>
            <div className="revision-state">{revisionBase ? <>修訂標記：以 {new Date(revisionBase.createdAt).toLocaleString('zh-TW')} 為基準，共 {revisedCount} 段標上 *。<button className="text-button" onClick={() => useAsRevisionBase(null)}>關閉修訂標記</button></> : '修訂標記未開啟。選一個版本後，可把它設為修訂基準。'}</div>
            {compareWith && (() => {
              const changes = diffProjects(compareWith.project, project);
              const outlineFields = [['logline', '一句話故事'], ['synopsis', '故事大綱'], ['core', '故事核心']] as const;
              const outlineChanges = outlineFields.flatMap(([field, label]) => {
                const before = compareWith.project.storyOutline?.[field] ?? '';
                const after = project.storyOutline?.[field] ?? '';
                return before === after ? [] : [{ field, label, before, after }];
              });
              const counts = { added: changes.filter((c) => c.kind === 'added').length, removed: changes.filter((c) => c.kind === 'removed').length, changed: changes.filter((c) => c.kind === 'changed' || c.kind === 'retyped').length + outlineChanges.length };
              return <>
                <div className="compare-summary"><span className="ins">新增 {counts.added}</span><span className="del">刪除 {counts.removed}</span><span>修改 {counts.changed}</span><button className="button-primary button-small" onClick={() => useAsRevisionBase(compareWith)}>設為修訂基準</button></div>
                <div className="compare-list">{changes.length === 0 && outlineChanges.length === 0 ? <p className="dialog-empty">兩個版本內容相同。</p> : changes.map((change, index) => <div key={index} className={`change change-${change.kind}`}>
                  <div className="change-meta"><span>{change.kind === 'added' ? '新增' : change.kind === 'removed' ? '刪除' : change.kind === 'retyped' ? '類型變更' : '修改'}</span><span>{BLOCK_LABELS[(change.after ?? change.before)!.type]}</span><span className="change-scene">{change.scene}</span></div>
                  <p>{change.kind === 'changed' ? charDiff(change.before!.text, change.after!.text).map((seg, segIndex) => seg.op === 'same' ? <span key={segIndex}>{seg.text}</span> : seg.op === 'ins' ? <ins key={segIndex}>{seg.text}</ins> : <del key={segIndex}>{seg.text}</del>) : change.kind === 'retyped' ? `${BLOCK_LABELS[change.before!.type]} → ${BLOCK_LABELS[change.after!.type]}：${change.after!.text}` : (change.after ?? change.before)!.text}</p>
                </div>)}</div>
                {outlineChanges.length > 0 && <div className="compare-list" aria-label="故事大綱差異">{outlineChanges.map((change) => <div key={change.field} className="change change-changed" data-story-outline-diff={change.field}>
                  <div className="change-meta"><span>修改</span><span>{change.label}</span></div>
                  <p><del>{change.before || '（空白）'}</del><ins>{change.after || '（空白）'}</ins></p>
                </div>)}</div>}
              </>;
            })()}
          </>}
        </section>
      </div>;
}
