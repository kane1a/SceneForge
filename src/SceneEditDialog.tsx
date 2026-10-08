import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { SceneMeta } from './types';
import './app-zoom.css';

interface Props {
  sceneNumber: number;
  heading: string;
  meta: SceneMeta;
  onSave: (meta: SceneMeta) => void;
  onCancel: () => void;
  onOpenScene: () => void;
}

export default function SceneEditDialog({ sceneNumber, heading, meta, onSave, onCancel, onOpenScene }: Props) {
  const [storyTime, setStoryTime] = useState(meta.storyTime ?? '');
  const [summary, setSummary] = useState(meta.summary ?? '');
  const dialogRef = useRef<HTMLElement>(null);
  const storyTimeRef = useRef<HTMLInputElement>(null);
  const skipFocusRestore = useRef(false);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = requestAnimationFrame(() => storyTimeRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      if (!skipFocusRestore.current && opener?.isConnected) {
        requestAnimationFrame(() => opener.focus({ preventScroll: true }));
      }
    };
  }, []);

  const save = () => onSave({ ...meta, storyTime: storyTime.trim(), summary: summary.trim() });
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      save();
      return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLTextAreaElement && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div className="dialog-backdrop scene-edit-backdrop" role="presentation">
    <section ref={dialogRef} className="app-dialog scene-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="scene-edit-title" onKeyDown={handleKeyDown}>
      <div className="scene-edit-intro">
        <header className="scene-edit-header">
          <p className="eyebrow">分場資料</p>
          <div className="scene-edit-title-row">
            <h2 id="scene-edit-title">編輯場景</h2>
            <button type="button" className="scene-edit-close" aria-label="關閉對話框" title="關閉" onClick={onCancel}>×</button>
          </div>
        </header>
        <div className="scene-edit-reference">
          <span className="card-number">第 {sceneNumber} 場</span>
          <strong>{heading || '未命名場景'}</strong>
        </div>
      </div>
      <div className="scene-edit-fields">
        <label className="scene-edit-field">故事時間
          <input ref={storyTimeRef} value={storyTime} maxLength={200} placeholder="如：第 3 天、七年前、黃昏" onChange={(event) => setStoryTime(event.target.value)} />
        </label>
        <label className="scene-edit-field">簡介
          <textarea value={summary} maxLength={4000} rows={5} placeholder="寫下這場的重點…" onChange={(event) => setSummary(event.target.value)} />
        </label>
      </div>
      <footer>
        <button type="button" className="text-button scene-edit-open" onClick={() => { skipFocusRestore.current = true; onOpenScene(); }}><span aria-hidden="true">↗</span><span>開啟此場</span></button>
        <div className="scene-edit-actions">
          <button type="button" className="button-ghost scene-edit-cancel" onClick={onCancel}>取消</button>
          <button type="button" className="button-primary scene-edit-save" onClick={save}>儲存</button>
        </div>
      </footer>
    </section>
  </div>;
}
