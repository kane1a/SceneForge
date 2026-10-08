import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { analyzeStory } from './story-analysis';
import SceneEditDialog from './SceneEditDialog';
import type { Project, SceneMeta } from './types';
import { avatarStyle } from './avatar';
import { Switch } from './ui-controls';
import { buildBraidConnectors, orderTimelineScenes, sceneBlockCounts, summarizeTimeline, type BraidConnector } from './timeline-model';
import './visual-details.css';
import './timeline.css';
import './app-zoom.css';

interface Props {
  project: Project;
  onMeta: (sceneId: string, meta: SceneMeta) => void;
  onReorder: (orderedSceneIds: string[]) => void;
  onOpen: (sceneId: string) => void;
  focusedSceneId?: string;
  onSelectScene?: (sceneId: string) => void;
  onDeleteScene?: (sceneId: string) => void;
}

const CARD = 184;
const CARD_HEIGHT = 120;
const GAP = 12;
const BRAID_GAP = 112; // 上下兩排之間給連線的空間
const STEP = CARD + GAP;
const ACT_COLORS = ['gold', 'rose', 'jade', 'sky', 'violet', 'slate'] as const;

type TimelineScene = {
  id: string;
  number: number;
  heading: string;
  act: string;
  actIndex: number;
  cast: string[];
  storyTime?: string;
  storyOrder?: number;
  blockCount: number;
};

const directionClass = (direction: string) => direction === '倒敘' ? 'flashback' : direction === '預敘' ? 'flashforward' : 'straight';

export default function StoryTimeline({ project, onMeta, onReorder, onOpen, focusedSceneId, onSelectScene, onDeleteScene }: Props) {
  const analysis = useMemo(() => analyzeStory(project), [project]);
  const meta = project.sceneMeta ?? {};
  const scenes = useMemo(() => {
    let act = '';
    let actIndex = 0;
    const cast = new Map(analysis.scenes.map((scene) => [scene.id, scene.present]));
    const blockCounts = sceneBlockCounts(project.blocks);
    const items: TimelineScene[] = [];
    for (const block of project.blocks) {
      if (block.type === 'act') { if (items.length || act) actIndex += 1; act = block.text.trim(); }
      if (block.type === 'scene') {
        const sceneMeta = project.sceneMeta?.[block.id];
        items.push({
          id: block.id,
          number: items.length + 1,
          heading: block.text.trim() || '未命名場景',
          act,
          actIndex,
          cast: cast.get(block.id) ?? [],
          storyTime: sceneMeta?.storyTime,
          storyOrder: sceneMeta?.storyOrder,
          blockCount: blockCounts.get(block.id) ?? 0,
        });
      }
    }
    return items;
  }, [project.blocks, project.sceneMeta, analysis.scenes]);
  const chrono = useMemo(() => orderTimelineScenes(scenes), [scenes]);
  const connectors = useMemo(() => buildBraidConnectors(scenes.map((scene) => scene.id), chrono.map((scene) => scene.id)), [scenes, chrono]);
  const connectorById = useMemo(() => new Map(connectors.map((connector) => [connector.sceneId, connector])), [connectors]);
  const rank = useMemo(() => new Map(chrono.map((scene, index) => [scene.id, index])), [chrono]);
  const summary = useMemo(() => summarizeTimeline(scenes, connectors), [scenes, connectors]);
  const maxLength = Math.max(1, ...scenes.map((scene) => scene.blockCount));
  const width = Math.max(760, scenes.length * STEP);
  const [selected, setSelected] = useState<string | null>(null);
  const [hoveredSceneId, setHoveredSceneId] = useState<string | null>(null);
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [showCharacterLanes, setShowCharacterLanes] = useState(false);
  const [showFlashbackArcs, setShowFlashbackArcs] = useState(true);
  const [showLength, setShowLength] = useState(false);
  useEffect(() => { if (focusedSceneId !== undefined) setSelected(focusedSceneId || null); }, [focusedSceneId]);
  const current = selected ? scenes.find((scene) => scene.id === selected) : undefined;
  const editingScene = editingSceneId ? scenes.find((scene) => scene.id === editingSceneId) : undefined;
  const reordered = chrono.some((scene, index) => scene.id !== scenes[index]?.id);
  const jump = (sceneId: string) => { setSelected(sceneId); onSelectScene?.(sceneId); };
  const deleteOnCardKey = (event: ReactKeyboardEvent<HTMLButtonElement>, sceneId: string) => {
    if (!onDeleteScene || event.currentTarget !== document.activeElement) return;
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    event.stopPropagation();
    onDeleteScene(sceneId);
  };
  const startDrag = (event: DragEvent<HTMLButtonElement>, id: string) => {
    setDragging(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    event.dataTransfer.setData('application/x-sceneforge-internal', 'story-timeline');
  };
  const handleDropOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setDropAt(Math.max(0, Math.min(chrono.length, Math.round((event.clientX - rect.left) / STEP))));
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!dragging || dropAt === null) return;
    const ids = chrono.map((scene) => scene.id).filter((id) => id !== dragging);
    const from = chrono.findIndex((scene) => scene.id === dragging);
    ids.splice(dropAt > from ? dropAt - 1 : dropAt, 0, dragging);
    onReorder(ids);
    setDragging(null);
    setDropAt(null);
  };
  const tagFor = (sceneId: string) => connectorById.get(sceneId)?.direction ?? '';
  const sceneCard = (scene: TimelineScene, index: number, draggable = false) => {
    const storyTime = scene.storyTime?.trim();
    const direction = tagFor(scene.id);
    const isHovered = hoveredSceneId === scene.id;
    const lengthPercent = Math.max(12, Math.round(scene.blockCount / maxLength * 100));
    return <button key={scene.id} type="button" draggable={draggable}
      className={`tl-card color-${ACT_COLORS[scene.actIndex % ACT_COLORS.length]}${selected === scene.id ? ' selected' : ''}${isHovered ? ' hovered' : ''}${dragging === scene.id ? ' dragging' : ''}${direction === '倒敘' ? ' back' : ''}${direction === '預敘' ? ' forward' : ''}`}
      style={{ left: index * STEP }}
      title={`${scene.number}. ${scene.heading}${storyTime ? `（${storyTime}）` : ''}`}
      onDragStart={(event) => startDrag(event, scene.id)}
      onDragEnd={() => { setDragging(null); setDropAt(null); }}
      onMouseEnter={() => setHoveredSceneId(scene.id)}
      onMouseLeave={() => setHoveredSceneId((id) => id === scene.id ? null : id)}
      onFocus={() => setHoveredSceneId(scene.id)} onBlur={() => setHoveredSceneId((id) => id === scene.id ? null : id)}
      onClick={() => jump(scene.id)} onDoubleClick={(event) => { event.preventDefault(); setEditingSceneId(scene.id); }} onKeyDown={(event) => deleteOnCardKey(event, scene.id)}
      aria-label={`第 ${scene.number} 場，${scene.heading}${direction ? `，${direction}` : ''}${storyTime ? `，故事時間：${storyTime}` : ''}`}>
      <span className="tl-card-top"><b>第 {scene.number} 場</b>{direction && <em className={`tl-direction ${directionClass(direction)}`}>{direction}</em>}</span>
      <strong>{scene.heading}</strong>
      <span className="tl-story-time">{storyTime || '尚未標註故事時間'}</span>
      {!!scene.cast.length || showLength ? <span className="tl-card-footer">
        {!!scene.cast.length && <span className="tl-cast" aria-label={`出場人物：${scene.cast.join('、')}`}>{scene.cast.slice(0, 5).map((name) => <i key={name} title={name} style={avatarStyle(name, project.bible?.[name])}>{Array.from(name)[0]}</i>)}{scene.cast.length > 5 && <small>+{scene.cast.length - 5}</small>}</span>}
        {showLength && <span className="tl-length" title={`約 ${scene.blockCount} 段劇本內容（以段落數估算）`}><i><b style={{ width: `${lengthPercent}%` }} /></i><small>{scene.blockCount} 段</small></span>}
      </span> : null}
    </button>;
  };


  if (!scenes.length) return <div className="graph-empty"><h2>敘事編織</h2><p>加入場景後，就能並排比較觀眾看到的順序與事件真正發生的順序。</p></div>;

  const characters = analysis.characters.filter((person) => person.scenes.length > 0);
  const narrativeTop = 24;
  const chronologyTop = narrativeTop + CARD_HEIGHT + BRAID_GAP;
  const connectorEndY = chronologyTop;
  const chronologyHeadingTop = chronologyTop + CARD_HEIGHT + 6;
  const headingHeight = 18;
  const laneTop = chronologyHeadingTop + headingHeight + (showCharacterLanes ? 24 : 0);
  const laneTitleHeight = 18;
  const laneHeight = showCharacterLanes ? laneTitleHeight + 6 + characters.length * 32 + 8 : 0;
  const braidHeight = showCharacterLanes ? laneTop + laneHeight + 10 : chronologyHeadingTop + headingHeight + 10;
  const dropZoneHeight = CARD_HEIGHT;

  return <div className="timeline-view" onClick={(event) => { if (!(event.target as Element).closest('.tl-card, .tl-lane-mark, button, .tl-detail, [role="dialog"]')) { setSelected(null); onSelectScene?.(''); } }}>
    <header className="tl-header">
      <div className="tl-heading">
        <h2>敘事編織</h2>
        <p>上排是觀眾看到的敘事順序；下排是事件真正發生的時序。拖曳下排可調整故事順序。</p>
      </div>
    </header>
    <div className="tl-controls">
      <div className="tl-toolbar-area">
        <div className="tl-overlays" role="group" aria-label="時間線圖層" data-seg-ignore>
          <Switch checked={showCharacterLanes} onChange={setShowCharacterLanes} label="人物出場" />
          <Switch checked={showFlashbackArcs} onChange={setShowFlashbackArcs} label="倒敘／預敘弧線" />
          <Switch checked={showLength} onChange={setShowLength} label="場次長度" />
        </div>
        {reordered && <button className="button-ghost button-small tl-reset-order" onClick={() => onReorder(scenes.map((scene) => scene.id))}>重設為劇本順序</button>}
      </div>
    </div>
    <div className="tl-scroll" onClick={(event) => { if (!(event.target as Element).closest('.tl-card, .tl-lane-mark, button')) { setSelected(null); onSelectScene?.(''); } }}>
      <div className="tl-summarybar" aria-live="polite">
        <span className="tl-summary">{summary}</span>
        <p className="tl-legend"><span className="legend-line straight" />正敘　<span className="legend-line flashback" />倒敘　<span className="legend-line flashforward" />預敘</p>
      </div>
      <div className="tl-canvas" style={{ width, minHeight: braidHeight }}>
        <div className="tl-row-heading">觀眾看到的順序</div>
        <div className="tl-row tl-braid-row tl-narrative-row" style={{ top: narrativeTop, left: 0, width }}>{scenes.map((scene, index) => sceneCard(scene, index))}</div>
        <svg className="tl-braid-connectors" width={width} height={braidHeight} aria-hidden="true">
          {connectors.filter((connector) => showFlashbackArcs || !connector.direction).map((connector: BraidConnector) => {
            const fromX = connector.narrativeIndex * STEP + CARD / 2;
            const toX = connector.chronologicalIndex * STEP + CARD / 2;
            const fromY = narrativeTop + CARD_HEIGHT;
            const toY = connectorEndY;
            const jump = connector.direction !== '';
            // 跨越距離越遠，彎折點錯開越多，避免多條弧線疊在同一高度。
            const span = Math.abs(connector.narrativeIndex - connector.chronologicalIndex);
            const lane = connectors.length > 1 ? (connector.narrativeIndex % 4) / 3 : 0.5;
            const bend = fromY + (toY - fromY) * (0.28 + 0.44 * lane);
            const d = jump ? `M ${fromX} ${fromY} C ${fromX} ${bend + Math.min(span, 4) * 2}, ${toX} ${bend - Math.min(span, 4) * 2}, ${toX} ${toY}` : `M ${fromX} ${fromY} L ${toX} ${toY}`;
            return <path key={connector.sceneId} className={`tl-connector ${directionClass(connector.direction)}${hoveredSceneId === connector.sceneId ? ' hovered' : ''}`} d={d} />;
          })}
        </svg>
        <div className="tl-row tl-braid-row tl-chronology-row" style={{ top: chronologyTop, left: 0, width }} onDragOver={handleDropOver} onDrop={drop} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropAt(null); }}>
          {chrono.map((scene, index) => sceneCard(scene, index, true))}
          {dropAt !== null && <span className="tl-drop" style={{ left: dropAt * STEP - GAP / 2 - 1, height: dropZoneHeight }} />}
        </div>
        <div className="tl-row-heading tl-chrono-label" style={{ marginTop: chronologyHeadingTop - headingHeight }}>事件真正發生的順序</div>
        {showCharacterLanes && <div className="tl-lanes" style={{ top: laneTop, width }}>
          <div className="tl-lanes-label">人物出場（依故事發生順序）</div>
          {characters.map((person) => <div className="tl-lane" key={person.name}>
            <strong title={person.name}>{person.name}</strong>
            <div className="tl-lane-track" style={{ width }}>
              {chrono.map((scene, index) => scene.cast.includes(person.name) ? <button key={scene.id} type="button" className={`tl-lane-mark color-${ACT_COLORS[scene.actIndex % ACT_COLORS.length]}${selected === scene.id ? ' selected' : ''}${hoveredSceneId === scene.id ? ' hovered' : ''}`} style={{ ...avatarStyle(person.name, project.bible?.[person.name]), left: index * STEP + (CARD - 23) / 2 }} title={`第 ${scene.number} 場・${scene.heading}`} aria-label={`${person.name}，第 ${scene.number} 場`} onMouseEnter={() => setHoveredSceneId(scene.id)} onMouseLeave={() => setHoveredSceneId((id) => id === scene.id ? null : id)} onClick={() => jump(scene.id)} onDoubleClick={() => onOpen(scene.id)} onKeyDown={(event) => deleteOnCardKey(event, scene.id)}>{Array.from(person.name)[0]}</button> : null)}
            </div>
          </div>)}
        </div>}
      </div>
    </div>
    <div className="tl-footer">
      <div className="tl-detail" aria-live="polite">
        {current ? <>
          <span className="card-number">{current.number}</span>
          <div className="tl-detail-main"><strong>{current.heading}</strong><small>{current.act ? `${current.act} · ` : ''}故事時序第 {(rank.get(current.id) ?? 0) + 1} 位{tagFor(current.id) ? ` · ${tagFor(current.id)}` : ''}{current.storyTime ? ` · ${current.storyTime}` : ''}</small></div>
          <button type="button" className="button-ghost button-small" onClick={() => onOpen(current.id)}>開啟此場</button>
          {onDeleteScene && <button type="button" className="button-ghost button-small tl-delete-scene" onClick={() => onDeleteScene(current.id)}>刪除此場</button>}
        </> : <p className="tl-tip">雙擊任一場次編輯故事時間與簡介；拖動下排卡片調整順序。</p>}
        <span className="tl-wheel-tip">Shift＋滾輪左右捲動</span>
      </div>
    </div>
    {editingScene && <SceneEditDialog sceneNumber={editingScene.number} heading={editingScene.heading} meta={meta[editingScene.id] ?? {}}
      onSave={(nextMeta) => { onMeta(editingScene.id, nextMeta); setEditingSceneId(null); }}
      onCancel={() => setEditingSceneId(null)}
      onOpenScene={() => { setEditingSceneId(null); onOpen(editingScene.id); }} />}
  </div>;
}
