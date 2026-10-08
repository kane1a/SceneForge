import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { avatarStyle } from './avatar';
import { analyzeStory } from './story-analysis';
import SceneEditDialog from './SceneEditDialog';
import type { Project, SceneColor, SceneMeta } from './types';
import './visual-details.css';
import './app-zoom.css';

interface Props {
  project: Project;
  sceneEighths: Record<string, number>;
  onMove: (sceneId: string, target: { beforeSceneId?: string; endOfActId?: string }) => void;
  onMeta: (sceneId: string, meta: SceneMeta) => void;
  onRenameAct: (actId: string, title: string) => void;
  onOpen: (sceneId: string) => void;
  focusActId?: string;
  onDeleteScene?: (sceneId: string) => void;
}

const COLORS: SceneColor[] = ['', 'gold', 'rose', 'jade', 'sky', 'violet', 'slate'];
const COLOR_NAMES: Record<SceneColor, string> = { '': '無', gold: '金', rose: '玫瑰', jade: '玉', sky: '天空', violet: '紫', slate: '石板' };

export default function SceneBoard({ project, onMove, onMeta, onRenameAct, onOpen, focusActId, onDeleteScene }: Props) {
  const analysis = useMemo(() => analyzeStory(project), [project]);
  const columns = useMemo(() => {
    const cols: { id: string; title: string; scenes: { id: string; number: number; heading: string; teaser: string }[] }[] = [];
    let number = 0;
    let current: (typeof cols)[number] | null = null;
    let teaserFor: { teaser: string } | null = null;
    for (const block of project.blocks) {
      if (block.type === 'act') { current = { id: block.id, title: block.text.trim() || '未命名幕', scenes: [] }; cols.push(current); teaserFor = null; continue; }
      if (block.type === 'scene') {
        number += 1;
        if (!current) { current = { id: '', title: '開場', scenes: [] }; cols.push(current); }
        const card = { id: block.id, number, heading: block.text.trim() || '未命名場景', teaser: '' };
        current.scenes.push(card);
        teaserFor = card;
        continue;
      }
      if (teaserFor && !teaserFor.teaser && block.type === 'action' && block.text.trim()) teaserFor.teaser = block.text.trim().slice(0, 90);
    }
    return cols;
  }, [project.blocks]);
  const castByScene = useMemo(() => new Map(analysis.scenes.map((scene) => [scene.id, scene.present])), [analysis]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [palette, setPalette] = useState<string | null>(null);
  const [editingAct, setEditingAct] = useState<string | null>(null);
  const [actDraft, setActDraft] = useState('');
  const [editingActSummary, setEditingActSummary] = useState<string | null>(null);
  const [actSummaryDraft, setActSummaryDraft] = useState('');
  const editingScene = editingSceneId ? columns.flatMap((column) => column.scenes).find((scene) => scene.id === editingSceneId) : undefined;
  useEffect(() => {
    if (focusActId === undefined) return;
    document.querySelector<HTMLElement>(`.board-col[data-act-id="${focusActId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [focusActId, columns.length]);
  useEffect(() => {
    if (!palette) return;
    const close = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest('.card-palette, .card-number-pick'))) setPalette(null); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [palette]);

  const onDragStart = (event: DragEvent, id: string) => {
    setDragging(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    event.dataTransfer.setData('application/x-sceneforge-internal', 'scene-card');
  };
  const finish = () => { setDragging(null); setDropBefore(null); };
  /** 找出游標所在高度對應的插入點：第一張「中線在游標下方」的卡片之前；都沒有就是該幕最後。 */
  const dropTargetAt = (col: HTMLElement, clientY: number, actId: string) => {
    for (const card of col.querySelectorAll<HTMLElement>('.scene-card[data-scene-id]')) {
      const rect = card.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return card.dataset.sceneId!;
    }
    return `end:${actId}`;
  };
  const isNoopMove = (column: { id: string; scenes: { id: string }[] }, sceneId: string, target: string) => {
    const ids = column.scenes.map((scene) => scene.id);
    const from = ids.indexOf(sceneId);
    if (from < 0) return false;
    if (target === sceneId) return true;
    if (target.startsWith('end:')) return from === ids.length - 1;
    return ids[from + 1] === target;
  };
  const deleteOnCardKey = (event: ReactKeyboardEvent<HTMLElement>, sceneId: string) => {
    if (!onDeleteScene || event.target !== event.currentTarget || event.currentTarget !== document.activeElement) return;
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    event.stopPropagation();
    onDeleteScene(sceneId);
  };
  const onSceneCardKeyDown = (event: ReactKeyboardEvent<HTMLElement>, sceneId: string) => {
    if (event.target === event.currentTarget && event.currentTarget === document.activeElement && event.key === 'Enter') {
      event.preventDefault();
      setEditingSceneId(sceneId);
      return;
    }
    deleteOnCardKey(event, sceneId);
  };


  if (!columns.length) {
    return <div className="board-page">
      <header className="board-page-header"><div><h2 className="story-page-title">分場大綱</h2><p className="story-page-subtitle">依場次整理摘要，並拖曳卡片調整順序。</p></div></header>
      <p className="board-empty">寫下第一個場景標題後，每一場都會變成一張卡片。</p>
    </div>;
  }

  return <div className="board-page">
    <header className="board-page-header"><div><h2 className="story-page-title">分場大綱</h2><p className="story-page-subtitle">依場次整理摘要，並拖曳卡片調整順序。</p></div></header>
    <div className="board" onClick={(event) => { const target = event.target; if (target instanceof Element && !target.closest('.scene-card, button, input, textarea, select, [role="dialog"], [role="menu"]')) setSelected(null); }} onDragEnd={finish}>
    {columns.map((column) => {
      const actMeta = project.sceneMeta?.[column.id] ?? {};
      return <section key={column.id || 'prelude'} className="board-col" data-act-id={column.id}
      onDragOver={(event) => { if (dragging) { event.preventDefault(); { const target = dropTargetAt(event.currentTarget, event.clientY, column.id); setDropBefore(isNoopMove(column, dragging, target) ? null : target); } } }}
      onDrop={(event) => {
        event.preventDefault();
        if (!dragging) return;
        // 依游標垂直位置決定插入點；位置沒有實際改變（拖回原處、在旁邊放開）就不動。
        const target = dropTargetAt(event.currentTarget, event.clientY, column.id);
        if (!isNoopMove(column, dragging, target)) {
          if (!target.startsWith('end:')) onMove(dragging, { beforeSceneId: target });
          else onMove(dragging, { endOfActId: column.id });
        }
        finish();
      }}>
      <header><div className="board-act-heading">{editingAct === column.id
        ? <input aria-label="編輯分幕標題" autoFocus value={actDraft} onChange={(event) => setActDraft(event.target.value)} onBlur={() => { if (actDraft.trim()) onRenameAct(column.id, actDraft.trim()); setEditingAct(null); }} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); if (event.key === 'Escape') setEditingAct(null); }} />
        : <h3 title="按兩下修改分幕標題" onDoubleClick={() => { if (column.id) { setEditingAct(column.id); setActDraft(column.title); } }}>{column.title}</h3>}<span>{column.scenes.length} 場</span></div></header>
      {column.id && <div className="act-summary-row">
        {editingActSummary === column.id
          ? <textarea className="act-summary-editor" aria-label="編輯分幕摘要" autoFocus value={actSummaryDraft} onChange={(event) => setActSummaryDraft(event.target.value)} onBlur={() => { onMeta(column.id, { ...actMeta, summary: actSummaryDraft.trim() }); setEditingActSummary(null); }} onKeyDown={(event) => { if (event.key === 'Escape') setEditingActSummary(null); if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) (event.target as HTMLTextAreaElement).blur(); }} />
          : <p className={`act-summary${actMeta.summary ? '' : ' placeholder'}`} onClick={() => { setEditingActSummary(column.id); setActSummaryDraft(actMeta.summary ?? ''); }}>{actMeta.summary || '點這裡補充分幕摘要或備註…'}</p>}
      </div>}
      <div className="board-cards">
        {column.scenes.map((scene) => {
          const meta = project.sceneMeta?.[scene.id] ?? {};
          const cast = castByScene.get(scene.id) ?? [];
          return <article key={scene.id} data-scene-id={scene.id} className={`scene-card color-${meta.color || 'none'}${dragging === scene.id ? ' dragging' : ''}${dropBefore === scene.id ? ' drop-before' : ''}${selected === scene.id ? ' selected' : ''}`}
            draggable={editing !== scene.id}
            tabIndex={0}
            aria-label={`第 ${scene.number} 場・${scene.heading}`}
            onDragStart={(event) => { if ((event.target as Element).closest('button, input, textarea, select')) { event.preventDefault(); return; } onDragStart(event, scene.id); }}
                        onDoubleClick={(event) => { if ((event.target as Element).closest('button, input, textarea, select')) return; setEditingSceneId(scene.id); }}
            onClick={() => setSelected(scene.id)}
            onFocus={(event) => { if (event.target === event.currentTarget) setSelected(scene.id); }}
            onKeyDown={(event) => onSceneCardKeyDown(event, scene.id)}>
            <div className="card-top">
              <div className="card-top-meta">
                <button type="button" className="card-number card-number-pick" aria-label={`第 ${scene.number} 場，點選變更卡片顏色`} aria-expanded={palette === scene.id} title="點選變更卡片顏色" onClick={(event) => { event.stopPropagation(); setPalette(palette === scene.id ? null : scene.id); }}><span className="card-number-ink">{scene.number}</span></button>
              </div>
              {palette === scene.id && <div className="card-palette" role="menu" aria-label="卡片顏色">{COLORS.map((color) => <button key={color || 'none'} role="menuitemradio" aria-checked={(meta.color || '') === color} className={`swatch color-${color || 'none'}${(meta.color || '') === color ? ' current' : ''}`} title={COLOR_NAMES[color]} aria-label={COLOR_NAMES[color]} onClick={() => { onMeta(scene.id, { ...meta, color }); setPalette(null); }} />)}</div>}
              <div className="scene-card-actions">
              <button type="button" className="scene-card-action scene-card-open" aria-label="開啟此場" title="開啟此場" onClick={(event) => { event.stopPropagation(); onOpen(scene.id); }}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5h6.5V10M12.5 3.5 6.5 9.5" /><path d="M10 9.5v3H3.5V6h3" /></svg>
              </button>
              {onDeleteScene && <button type="button" className="scene-card-action scene-card-delete" aria-label={`刪除第 ${scene.number} 場`} title="刪除此場" onClick={(event) => { event.stopPropagation(); onDeleteScene(scene.id); }}>×</button>}
              </div>
            </div>
            <h4>{scene.heading}</h4>
            <div className="card-summary-row">
              {editing === scene.id
                ? <textarea autoFocus value={draft} rows={4} placeholder="這場發生什麼？" onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => { onMeta(scene.id, { ...meta, summary: draft.trim() }); setEditing(null); }}
                    onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null); if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) (event.target as HTMLTextAreaElement).blur(); }} />
                : <p className={meta.summary ? 'card-summary' : 'card-summary placeholder'} onClick={() => { setEditing(scene.id); setDraft(meta.summary ?? ''); }}>{meta.summary || scene.teaser || '點這裡寫下這場的摘要…'}</p>}
            </div>
            {cast.length > 0 && <div className="card-cast">{cast.slice(0, 5).map((name) => <span className="card-cast-person" key={name}><i className="card-cast-avatar" style={avatarStyle(name, project.bible?.[name])}>{Array.from(name.normalize('NFKC'))[0] ?? '人'}</i><span>{name}</span></span>)}{cast.length > 5 && <span className="card-cast-more">另 {cast.length - 5} 人</span>}</div>}
          </article>;
        })}
        {dragging && <div className={`board-drop-end${dropBefore === `end:${column.id}` ? ' active' : ''}`} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setDropBefore(`end:${column.id}`); }}>放到這一幕的最後</div>}
      </div>
    </section>;
    })}
    </div>
    {editingScene && <SceneEditDialog sceneNumber={editingScene.number} heading={editingScene.heading} meta={project.sceneMeta?.[editingScene.id] ?? {}}
      onSave={(nextMeta) => { onMeta(editingScene.id, nextMeta); setEditingSceneId(null); }}
      onCancel={() => setEditingSceneId(null)}
      onOpenScene={() => { setEditingSceneId(null); onOpen(editingScene.id); }} />}
  </div>;
}
