import { useEffect, useState } from 'react';
import { api } from './api';
import { desktop } from './docfile';

export type StorageKey = 'scripts' | 'data' | 'backups' | 'trash';

/** 顯示資料存放位置，桌面版可直接打開該資料夾。所有對話框共用同一個外觀。 */
export function StorageLocation({ label, folder, note }: { label: string; folder: StorageKey; note?: string }) {
  const [path, setPath] = useState('');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (desktop?.folders) { const folders = await desktop.folders(); if (alive) setPath(folders[folder]); return; }
      if (folder === 'scripts') return;
      const info = await api.storage();
      if (alive) setPath(folder === 'backups' ? info.backupsDir : folder === 'trash' ? info.trashDir : info.database);
    };
    void load().catch(() => {});
    return () => { alive = false; };
  }, [folder]);
  if (folder === 'scripts' && !desktop?.folders) return null;
  return <div className="storage-location">
    <div className="storage-location-text">
      <span className="storage-location-label">{label}</span>
      <code className="storage-location-path" title={path}>{path || '讀取中…'}</code>
      {note && <small className="storage-location-note">{note}</small>}
    </div>
    {desktop?.openFolder && <button type="button" className="button-ghost button-small" onClick={() => void desktop?.openFolder?.(folder)}>打開資料夾</button>}
  </div>;
}
