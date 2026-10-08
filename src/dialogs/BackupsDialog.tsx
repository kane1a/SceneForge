import { useEffect, useState } from 'react';
import { api, type BackupInfo } from '../api';
import { askConfirm, askConfirmWithOption } from '../confirm';
import { StorageLocation } from '../storage-location';

/** 檔案 › 整體資料備份。清單與操作狀態都在這裡；還原後重新載入劇本由 App 透過 onRestored 處理。 */
export default function BackupsDialog({ demo, onClose, notify, onError, beforeRestore, onRestored }: {
  demo: boolean;
  onClose: () => void;
  notify: (text: string) => void;
  onError: (message: string) => void;
  beforeRestore: () => Promise<void>;
  onRestored: () => Promise<void>;
}) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupBusy, setBackupBusy] = useState('');
  const reload = async () => setBackups((await api.listBackups()).backups);
  useEffect(() => {
    if (demo) return;
    reload().catch((error) => onError(error instanceof Error ? error.message : '無法讀取備份。'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteBackup = async (item: BackupInfo) => {
    if (!(await askConfirm({ title: '移至垃圾桶？', message: `${new Date(item.createdAt).toLocaleString('zh-TW')} 的整個資料庫備份會移至 SceneForge 垃圾桶，期限內可還原。`, confirmLabel: '移至垃圾桶', cancelLabel: '取消', danger: true }))) return;
    setBackupBusy('移動中…');
    try { await api.deleteBackup(item.name); await reload(); notify('已移至垃圾桶'); } catch (error) { onError(error instanceof Error ? error.message : '移至垃圾桶失敗。'); } finally { setBackupBusy(''); }
  };
  const pruneBackups = async () => {
    const answer = await askConfirmWithOption({ title: '清除舊備份？', message: '清除的備份會永久刪除。關閉下方選項會清除全部備份。', confirmLabel: '清除', cancelLabel: '取消', danger: true, option: { label: '保留最新 5 份備份', checked: true } });
    if (!answer.confirmed) return;
    setBackupBusy('清除中…');
    try { const result = await api.pruneBackups(answer.option ? 5 : 0); await reload(); notify(result.deleted ? `已清除 ${result.deleted} 份備份` : '沒有需要清除的備份'); } catch (error) { onError(error instanceof Error ? error.message : '清除備份失敗。'); } finally { setBackupBusy(''); }
  };
  const backupNow = async () => {
    setBackupBusy('正在備份…');
    try { await api.createBackup(); await reload(); notify('已備份'); } catch (error) { onError(error instanceof Error ? error.message : '備份失敗。'); }
    finally { setBackupBusy(''); }
  };
  const restoreFromBackup = async (item: BackupInfo) => {
    if (!(await askConfirm({ title: `還原到 ${new Date(item.createdAt).toLocaleString('zh-TW')} 的備份？`, message: `目前的所有劇本會先自動備份一次，再被取代。` }))) return;
    setBackupBusy('正在還原…');
    try {
      await beforeRestore();
      await api.restoreBackup(item.name);
      await onRestored();
      await reload();
      notify('已還原備份');
    } catch (error) { onError(error instanceof Error ? error.message : '還原失敗。'); }
    finally { setBackupBusy(''); }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !backupBusy) onClose(); }}>
    <section className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="backups-title">
      <header><div><p className="eyebrow">資料安全</p><h2 id="backups-title">整體資料備份</h2></div><button className="dialog-close" aria-label="關閉" disabled={!!backupBusy} onClick={onClose}>×</button></header>
      <StorageLocation label="劇本檔（.sfe）預設存放在" folder="scripts" note="「存檔」「另存新檔」預設放在這裡；也可以另選位置。" />
      <StorageLocation label="SceneForge 資料庫（劇本內容、版本快照、垃圾桶）" folder="data" />
      <StorageLocation label="整體資料備份存放在" folder="backups" note="每一份備份是一個 .sqlite 檔，檔名就是建立時間。" />
      <div className="backup-compare">
        <div><strong>整體資料備份</strong><span>整個資料庫，包含所有劇本、快照與垃圾桶。電腦出問題或誤刪劇本時用來救回。每 20 分鐘有變更時自動建立，保留最近 30 份</span></div>
        <div><strong>版本快照</strong><span>單一劇本某個時間點的內容，用來比對修改與標示修訂。在「工具 › 版本比對與修訂」管理</span></div>
      </div>
      {demo ? <p className="dialog-empty">示範版沒有本機資料庫，無法備份。</p> : <>
        <div className="backup-actions">
          <button className="button-primary" disabled={!!backupBusy} onClick={() => void backupNow()}>{backupBusy || '立即備份'}</button>
          <button className="button-ghost" disabled={!!backupBusy || !backups.length} onClick={() => void pruneBackups()}>清除舊備份…</button>
        </div>
        <ul className="trash-list backup-list">{backups.map((item) => <li key={item.name}><div><strong>{new Date(item.createdAt).toLocaleString('zh-TW')}</strong><span>{item.kind === 'auto' ? '自動' : item.kind === 'manual' ? '手動' : '還原前'} · {(item.size / 1024).toFixed(0)} KB</span></div><button className="button-ghost button-small" disabled={!!backupBusy} onClick={() => void restoreFromBackup(item)}>還原</button><button className="text-button danger-text" disabled={!!backupBusy} onClick={() => void deleteBackup(item)}>移至垃圾桶</button></li>)}</ul>
      </>}
    </section>
  </div>;
}
