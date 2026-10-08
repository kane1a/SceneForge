import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { analyzeStory, buildCharacterAliasMap, RELATION_LABELS, type CharacterInfo } from './story-analysis';
import { speakerKey } from './smart-import';
import { RELATION_TYPES, type Project, type Relation, type RelationType } from './types';
import './visual-details.css';
import { avatarFill, avatarStyle, resolveAvatarHue } from './avatar';
import { Select, Switch } from './ui-controls';
import { exportGraphPng } from './graph-export';
import { useWheelZoom } from './graph-zoom';
import { ScenePreview, buildSceneSelectOptions } from './scene-select';
import { autoTiers, resolveTier } from './character-tier';
import { LABEL_LINE_HEIGHT, LABEL_STACK_GAP, labelSize, layout, loadPositions, relationPairKey, savePositions, type GraphNode, type Point } from './relation-layout';

interface View { x: number; y: number; k: number }

interface Props {
  project: Project;
  onAddRelation: (relation: Omit<Relation, 'id'>) => void;
  onRemoveRelation: (id: string) => void;
  onJumpToScene: (sceneId: string) => void;
  focusCharacter?: string;
  onFocusCharacter?: (name: string | null) => void;
}

interface DisclosureProps {
  className: string;
  title: string;
  badge?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

function Disclosure({ className, title, badge, open, onToggle, children }: DisclosureProps) {
  const contentId = useId();
  return <section className={`gp-disclosure ${className}${open ? ' is-open' : ''}`}>
    <button type="button" className="gp-disclosure-trigger" aria-expanded={open} aria-controls={contentId} onClick={onToggle}>
      <span className="gp-disclosure-title">{title}</span>
      {badge && <span className="gp-disclosure-badge">{badge}</span>}
      <svg className="gp-disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    <div id={contentId} className="gp-disclosure-panel" aria-hidden={!open} inert={!open}>
      <div className="gp-disclosure-inner">{children}</div>
    </div>
  </section>;
}

const relationLabel = (relation: Relation) => relation.label || RELATION_LABELS[relation.type];

export default function RelationGraph({ project, onAddRelation, onRemoveRelation, onJumpToScene, focusCharacter, onFocusCharacter }: Props) {
  const fullAnalysis = useMemo(() => analyzeStory(project), [project.blocks, project.entities, project.relations]);
  const aliasMap = useMemo(() => buildCharacterAliasMap(project), [project.entities]);
  const canonicalName = (raw: string) => { const key = speakerKey(raw); return aliasMap.get(key) ?? key; };
  const [showExtras, setShowExtras] = useState(() => window.localStorage.getItem(`sf:relation-extras:${project.id}`) === 'true');
  useEffect(() => { setShowExtras(window.localStorage.getItem(`sf:relation-extras:${project.id}`) === 'true'); }, [project.id]);
  const toggleExtras = (next: boolean) => { setShowExtras(next); window.localStorage.setItem(`sf:relation-extras:${project.id}`, String(next)); };
  // 路人（自動分級或手動指定）預設不上圖；已建立明確關係的角色一律保留。
  const hiddenExtras = useMemo(() => {
    if (showExtras) return new Set<string>();
    const tiers = autoTiers(fullAnalysis.characters);
    const related = new Set((project.relations ?? []).flatMap((relation) => [canonicalName(relation.from), canonicalName(relation.to)]));
    return new Set(fullAnalysis.characters.filter((info) => resolveTier(info.name, tiers, project.bible?.[info.name]) === 'extra' && !related.has(info.name)).map((info) => info.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullAnalysis, showExtras, project.bible, project.relations, aliasMap]);
  const analysis = useMemo(() => hiddenExtras.size ? {
    ...fullAnalysis,
    characters: fullAnalysis.characters.filter((info) => !hiddenExtras.has(info.name)),
    links: fullAnalysis.links.filter((link) => !hiddenExtras.has(link.a) && !hiddenExtras.has(link.b)),
  } : fullAnalysis, [fullAnalysis, hiddenExtras]);
  const extraCount = useMemo(() => {
    const tiers = autoTiers(fullAnalysis.characters);
    return fullAnalysis.characters.filter((info) => resolveTier(info.name, tiers, project.bible?.[info.name]) === 'extra').length;
  }, [fullAnalysis, project.bible]);
  const relations = useMemo(() => {
    const unique = new Map<string, Relation>();
    for (const relation of project.relations ?? []) {
      const from = canonicalName(relation.from);
      const to = canonicalName(relation.to);
      if (!from || !to || from === to) continue;
      const key = [from, to, relation.type, relation.label ?? '', relation.sinceScene ?? ''].join('\\u0000');
      if (!unique.has(key)) unique.set(key, { ...relation, from, to });
    }
    return [...unique.values()];
  }, [project.relations, aliasMap]);
  const explicitRelationPairs = useMemo(() => new Set(relations.map((relation) => relationPairKey(relation.from, relation.to))), [relations]);
  // Timeline: null = whole script; otherwise the graph as it stands at that scene (0-based index).
  // `progress` moves continuously while playing (smooth slider); the graph follows its whole scene.
  const [progress, setProgress] = useState<number | null>(null);
  const at = progress === null ? null : Math.floor(progress);
  const setAt = (value: number | null) => setProgress(value);
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<0.5 | 1 | 2>(1);
  const [playbackRun, setPlaybackRun] = useState(0);
  const [arrivedNodes, setArrivedNodes] = useState<Set<string>>(() => new Set());
  const [enteredRelations, setEnteredRelations] = useState<Set<string>>(() => new Set());
  const playbackStartedRef = useRef(false);
  const arrivedNodesRef = useRef(new Set<string>());
  const enteredRelationsRef = useRef(new Set<string>());
  const sceneIndex = useMemo(() => new Map(analysis.scenes.map((scene) => [scene.id, scene.index])), [analysis.scenes]);
  const sinceSceneOptions = useMemo(() => buildSceneSelectOptions(project.blocks, '從故事開始就成立', (number) => `從第 ${number} 場起`), [project.blocks]);
  const firstAppearance = useMemo(() => {
    const first = new Map<string, number>();
    analysis.scenes.forEach((scene) => scene.present.forEach((name) => { if (!first.has(name)) first.set(name, scene.index); }));
    return first;
  }, [analysis.scenes]);
  const sinceIndex = (relation: Relation) => relation.sinceScene ? sceneIndex.get(relation.sinceScene) ?? 0 : 0;
  const lastScene = analysis.scenes.length - 1;
  // At a point on the timeline: who has appeared, who has shared a scene, and which relation is current for each pair.
  const visible = useMemo(() => {
    if (at === null) return null;
    const people = new Set<string>();
    const pairs = new Map<string, { a: string; b: string; weight: number }>();
    for (const scene of analysis.scenes.slice(0, at + 1)) {
      scene.present.forEach((name) => people.add(name));
      const cast = [...scene.present].sort();
      for (let i = 0; i < cast.length; i += 1) for (let j = i + 1; j < cast.length; j += 1) {
        const key = `${cast[i]}\u0000${cast[j]}`;
        const link = pairs.get(key) ?? { a: cast[i], b: cast[j], weight: 0 };
        link.weight += 1;
        pairs.set(key, link);
      }
    }
    return { people, links: [...pairs.values()] };
  }, [at, analysis.scenes]);
  const shownRelations = useMemo(() => {
    const limit = at ?? Number.POSITIVE_INFINITY;
    const latest = new Map<string, Relation>();
    for (const relation of [...relations].sort((a, b) => sinceIndex(a) - sinceIndex(b))) {
      if (sinceIndex(relation) > limit) continue;
      const key = [relation.from, relation.to].sort().join('\u0000');
      if (at === null) latest.set(relation.id, relation); else latest.set(key, relation);
    }
    return [...latest.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relations, at, sceneIndex]);
  useEffect(() => {
    if (!playing || at === null) return;
    const scene = analysis.scenes[at];
    if (!scene) return;
    const newlyArrived = scene.present.filter((name) => firstAppearance.get(name) === at && !arrivedNodesRef.current.has(name));
    if (newlyArrived.length) {
      newlyArrived.forEach((name) => arrivedNodesRef.current.add(name));
      setArrivedNodes((current) => new Set([...current, ...newlyArrived]));
    }
    const activeRelations = shownRelations.filter((relation) => !visible || (visible.people.has(relation.from) && visible.people.has(relation.to)));
    const newlyActive = activeRelations.map((relation) => relation.id).filter((id) => !enteredRelationsRef.current.has(id));
    if (newlyActive.length) {
      newlyActive.forEach((id) => enteredRelationsRef.current.add(id));
      setEnteredRelations((current) => new Set([...current, ...newlyActive]));
    }
  }, [at, playing, playbackRun, analysis.scenes, firstAppearance, shownRelations, visible]);
  const evidenceScene = (a: string, b: string, relation?: Relation) => {
    if (relation?.sinceScene) return relation.sinceScene;
    return analysis.scenes.find((scene) => scene.present.includes(a) && scene.present.includes(b))?.id;
  };
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      let done = false;
      setProgress((current) => {
        const next = (current ?? 0) + (dt / 750) * playbackSpeed; // roughly 0.75 s per scene at 1×
        if (next >= lastScene) { done = true; return lastScene; }
        return next;
      });
      if (done) setPlaying(false); else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, lastScene, playbackSpeed]);
  const positionsRef = useRef(new Map<string, Point>());
  const positionsProjectRef = useRef('');
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [sceneDisclosureOpen, setSceneDisclosureOpen] = useState(true);
  const [addRelationOpen, setAddRelationOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [showCo, setShowCo] = useState(() => window.localStorage.getItem(`sf:relation-co:${project.id}`) !== 'false');
  useEffect(() => { setShowCo(window.localStorage.getItem(`sf:relation-co:${project.id}`) !== 'false'); }, [project.id]);
  const toggleCo = (next: boolean) => { setShowCo(next); window.localStorage.setItem(`sf:relation-co:${project.id}`, String(next)); };
  const [showStats, setShowStats] = useState(true);
  const [flowEnabled, setFlowEnabled] = useState(() => window.localStorage.getItem('sceneforge-graph-flow') !== 'false');
  const [reduceMotion, setReduceMotion] = useState(false);
  const statsProjectRef = useRef('');
  const [linkTarget, setLinkTarget] = useState('');
  const [linkType, setLinkType] = useState<RelationType>('friend');
  const [linkLabel, setLinkLabel] = useState('');
  const [linkSince, setLinkSince] = useState('');
  const svgRef = useRef<SVGSVGElement>(null);
  useWheelZoom(svgRef, setView, 0.3, 2.5);
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  useEffect(() => { setSelected(focusCharacter ? canonicalName(focusCharacter) : null); }, [focusCharacter, aliasMap]);
  const selectCharacter = (name: string | null) => { setSelected(name); onFocusCharacter?.(name); };
  useEffect(() => {
    if (!project.id || statsProjectRef.current !== project.id) {
      statsProjectRef.current = project.id;
      setShowStats(window.localStorage.getItem(`sf:relation-stats:${project.id}`) !== 'false');
    }
  }, [project.id]);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  const toggleStats = () => setShowStats((value) => {
    const next = !value;
    window.localStorage.setItem(`sf:relation-stats:${project.id}`, String(next));
    return next;
  });

  const signature = project.id + '#' + analysis.characters.map((info) => info.name).join('|') + '#' + relations.map((relation) => `${relation.from}>${relation.to}`).join('|');
  useEffect(() => {
    if (positionsProjectRef.current !== project.id) {
      positionsProjectRef.current = project.id;
      positionsRef.current = loadPositions(project.id);
    }
    const next = layout(analysis.characters, analysis.links, relations, positionsRef.current, relationLabel);
    next.forEach((node) => positionsRef.current.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 }));
    savePositions(project.id, positionsRef.current);
    setNodes(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const fit = () => {
    const svg = svgRef.current;
    if (!svg || !nodes.length) return;
    const { width, height } = svg.getBoundingClientRect();
    const xs = nodes.flatMap((node) => [(node.x ?? 0) - node.r - 40, (node.x ?? 0) + node.r + 40]);
    const ys = nodes.flatMap((node) => [(node.y ?? 0) - node.r - 30, (node.y ?? 0) + node.r + 50]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    const k = Math.min(1.05, Math.max(0.3, Math.min(width / w, height / h) * 0.85));
    setView({ k, x: width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * k });
  };
  const fitted = useRef('');
  useEffect(() => { if (nodes.length && fitted.current !== project.id) { fitted.current = project.id; fit(); } });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { map.set(a, (map.get(a) ?? new Set()).add(b)); map.set(b, (map.get(b) ?? new Set()).add(a)); };
    analysis.links.forEach((link) => add(link.a, link.b));
    relations.forEach((relation) => add(relation.from, relation.to));
    return map;
  }, [analysis.links, relations]);
  const focus = hover ?? selected;
  const dim = (id: string) => focus !== null && id !== focus && !neighbours.get(focus)?.has(id);

  const onPointerDown = (event: ReactPointerEvent, id?: string) => {
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    const node = id ? byId.get(id) : undefined;
    drag.current = { kind: id ? 'node' : 'pan', id, startX: event.clientX, startY: event.clientY, originX: node ? node.x ?? 0 : view.x, originY: node ? node.y ?? 0 : view.y, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
    if (state.kind === 'pan') setView((current) => ({ ...current, x: state.originX + dx, y: state.originY + dy }));
    else if (state.id) {
      const x = state.originX + dx / view.k;
      const y = state.originY + dy / view.k;
      positionsRef.current.set(state.id, { x, y });
      setNodes((items) => items.map((node) => node.id === state.id ? { ...node, x, y } : node));
    }
  };
  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    if (!state.moved) selectCharacter(state.kind === 'node' ? state.id ?? null : null);
    else if (state.kind === 'node') savePositions(project.id, positionsRef.current);
  };


  const relayout = () => {
    positionsRef.current.clear();
    const next = layout(analysis.characters, analysis.links, relations, positionsRef.current, relationLabel);
    next.forEach((node) => positionsRef.current.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 }));
    savePositions(project.id, positionsRef.current);
    setNodes(next);
    requestAnimationFrame(fit);
  };

  const exportPng = () => void exportGraphPng(svgRef.current, `${project.title}-人物關係圖.png`, ['--g-ink', '--g-paper', '--g-muted', '--g-line', '--g-gold', '--g-gold-light', '--paper', '--ink', '--muted', '--accent', '--desk', '--font-ui']);

  const info = selected ? analysis.characters.find((item) => item.name === selected) : undefined;
  useLayoutEffect(() => {
    setSceneDisclosureOpen((info?.scenes.length ?? 0) <= 6);
    setAddRelationOpen(false);
  }, [selected, info?.scenes.length]);
  const maxLines = Math.max(1, ...analysis.characters.map((item) => item.lines));
  const edgePath = (a: GraphNode, b: GraphNode) => {
    const ax = a.x ?? 0, ay = a.y ?? 0, bx = b.x ?? 0, by = b.y ?? 0;
    return { d: `M${ax},${ay} L${bx},${by}`, lx: (ax + bx) / 2, ly: (ay + by) / 2 };
  };

  if (!analysis.characters.length) {
    return <div className="graph-empty">
      <div className="graph-empty-art" aria-hidden="true"><span /><span /><span /></div>
      <h2>人物關係圖</h2>
      <p>星圖會從角色對白自動建立。</p>
      <ul className="gp-help-list" aria-label="圖表內容">
        <li><strong>角色</strong><span>台詞與出場次數</span></li>
        <li><strong>連線</strong><span>同場或確認關係</span></li>
      </ul>
    </div>;
  }

  return <div className={`graph-wrap${reduceMotion ? ' reduce-motion' : ''}`}>
    <div className="graph-toolbar">
      <Switch checked={showCo} onChange={toggleCo} label="同場連線" />
      <Switch checked={flowEnabled} title="選取角色後顯示流向" onChange={(next) => { setFlowEnabled(next); window.localStorage.setItem('sceneforge-graph-flow', String(next)); }} label="連線流動" />
      <Switch checked={showStats} onChange={() => toggleStats()} label="顯示統計" />
      {extraCount > 0 && <Switch checked={showExtras} onChange={toggleExtras} title="只出場一場、沒有建立關係的角色；可在人物設定改層級" label={`顯示路人（${extraCount}）`} />}
      <span className="graph-toolbar-sep" aria-hidden="true" />
      <button className="toolbar-button" onClick={relayout}>重新排列</button>
      <button className="toolbar-button" onClick={fit}>置中</button>
      <button className="toolbar-button" onClick={exportPng}>匯出 PNG</button>
    </div>
    <svg ref={svgRef} className="graph-canvas" role="img" aria-label="人物關係圖" onPointerDown={(event) => onPointerDown(event)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => { drag.current = null; }}>
      <defs>
        <radialGradient id="node-core" cx="35%" cy="30%" r="80%"><stop offset="0%" stopColor="var(--g-paper)" /><stop offset="100%" stopColor="var(--g-line)" /></radialGradient>
        <radialGradient id="node-lead" cx="35%" cy="30%" r="85%"><stop offset="0%" stopColor="var(--g-gold-light)" /><stop offset="100%" stopColor="var(--g-gold)" /></radialGradient>
        <filter id="node-shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#000" floodOpacity=".18" /></filter>
      </defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {showCo && analysis.links.filter((full) => !explicitRelationPairs.has(relationPairKey(full.a, full.b))).map((full) => {
          // Every line stays on screen and fades in and out, so playback never pops.
          const link = visible ? visible.links.find((item) => item.a === full.a && item.b === full.b) ?? { ...full, weight: 0 } : full;
          const a = byId.get(link.a), b = byId.get(link.b);
          if (!a || !b) return null;
          const faded = link.weight === 0 || (focus !== null && link.a !== focus && link.b !== focus);
          const scene = evidenceScene(link.a, link.b);
          const active = !!selected && (link.a === selected || link.b === selected) && link.weight > 0;
          return <g key={`${link.a}-${link.b}`}>
            <line className="co-link" x1={a.x} y1={a.y} x2={b.x} y2={b.y} pathLength={1} strokeWidth={0.65 + Math.min(link.weight, 8) * 0.28} opacity={link.weight === 0 ? 0 : faded ? 0.04 : Math.min(0.3, 0.08 + link.weight * 0.035)}
              onPointerDown={(event) => event.stopPropagation()} onClick={() => scene && onJumpToScene(scene)} />
            {active && flowEnabled && !reduceMotion && <circle className="co-particle" r="3"><animateMotion dur="2.8s" repeatCount="indefinite" path={`M${a.x},${a.y} L${b.x},${b.y}`} /></circle>}
            <title>{`${link.a} × ${link.b}：同場 ${link.weight} 次（點一下跳到第一次同場）`}</title>
          </g>;
        })}
        {(() => {
          // Labels of several relations between the same two people stack instead of overlapping.
          const stacks = new Map<string, string[]>();
          relations.forEach((relation) => {
            if (!shownRelations.includes(relation) || (!!visible && (!visible.people.has(relation.from) || !visible.people.has(relation.to)))) return;
            const key = relationPairKey(relation.from, relation.to);
            stacks.set(key, [...(stacks.get(key) ?? []), relation.id]);
          });
          // Lines first, labels on top: a later line never runs through an earlier label.
          const items = relations.map((relation, index) => {
          const a = byId.get(relation.from), b = byId.get(relation.to);
          if (!a || !b) return null;
          const hidden = !shownRelations.includes(relation) || (!!visible && (!visible.people.has(relation.from) || !visible.people.has(relation.to)));
          const { d, lx, ly } = edgePath(a, b);
          const label = relation.label || RELATION_LABELS[relation.type];
          const size = labelSize(label);
          // Stacked labels of the same pair sit one above the other, centred on the line.
          const stack = (stacks.get(relationPairKey(relation.from, relation.to)) ?? []).map((id) => relations.find((item) => item.id === id)!).map((item) => labelSize(item.label || RELATION_LABELS[item.type]).height);
          const slot = (stacks.get(relationPairKey(relation.from, relation.to)) ?? []).indexOf(relation.id);
          const stackHeight = stack.reduce((sum, height) => sum + height, 0) + Math.max(0, stack.length - 1) * LABEL_STACK_GAP;
          const above = stack.slice(0, Math.max(0, slot)).reduce((sum, height) => sum + height + LABEL_STACK_GAP, 0);
          const labelCenter = { x: lx, y: slot < 0 ? ly : ly - stackHeight / 2 + above + size.height / 2 };
          const flowFrom = relation.type === 'mentor' || !selected || relation.from === selected ? a : b;
          const flowPath = flowFrom === a ? d : edgePath(b, a).d;
          const faded = focus !== null && relation.from !== focus && relation.to !== focus;
          const scene = evidenceScene(relation.from, relation.to, relation);
          const active = !!selected && (relation.from === selected || relation.to === selected) && !hidden;
          const entering = enteredRelations.has(relation.id) && !reduceMotion;
            return { relation, index, hidden, d, size, label, labelCenter, flowPath, faded, scene, active, entering };
          }).filter((item): item is NonNullable<typeof item> => item !== null);
          const groupProps = ({ relation, hidden, faded, entering, scene }: (typeof items)[number]) => ({
            className: `rel rel-${relation.type}${hidden ? ' is-hidden' : ''}${entering ? ' rel-entering' : ''}`,
            opacity: hidden ? 0 : faded ? 0.12 : 1,
            onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),
            onClick: () => scene && onJumpToScene(scene),
          });
          return <>
            {items.map((item) => { const { relation, index, d, label, flowPath, active, entering } = item; return <g key={relation.id} {...groupProps(item)}>
              <title>{`${relation.from} — ${relation.to}：${label}${relation.sinceScene ? `（第 ${sinceIndex(relation) + 1} 場起）` : ''}，點一下跳到該場`}</title>
              <path className="rel-path" d={d} pathLength={1} style={{ ['--edge-delay' as string]: `${(nodes.length * 0.055) + index * 0.08}s`, animationPlayState: reduceMotion ? 'paused' : undefined }} />
              {entering && <path className="rel-glow" d={d} />}
              {active && flowEnabled && !reduceMotion && <circle className="rel-particle" r="3.2"><animateMotion dur="2.8s" repeatCount="indefinite" path={flowPath} /></circle>}
            </g>; })}
            {items.map((item) => { const { relation, label, size, labelCenter } = item; return <g key={`${relation.id}-label`} {...groupProps(item)}>
              <title>{`${relation.from} — ${relation.to}：${label}${relation.sinceScene ? `（第 ${sinceIndex(relation) + 1} 場起）` : ''}，點一下跳到該場`}</title>
              <g className="rel-label" transform={`translate(${labelCenter.x},${labelCenter.y})`}><rect x={-size.width / 2} y={-size.height / 2} width={size.width} height={size.height} rx={11} /><text dominantBaseline="central">{size.lines.map((line, lineIndex) => <tspan key={lineIndex} x={0} dominantBaseline="central" y={(lineIndex - (size.lines.length - 1) / 2) * LABEL_LINE_HEIGHT}>{line}</tspan>)}</text></g>
            </g>; })}
          </>;
        })()}
        {nodes.map((node, index) => {
          const lead = index < 3 && node.info.lines > 0;
          const hidden = !!visible && !visible.people.has(node.id);
          const arriving = !reduceMotion && arrivedNodes.has(node.id);
          const speaking = at !== null && !!analysis.scenes[at]?.speakers.includes(node.id);
          return <g key={node.id} className={`g-node${selected === node.id ? ' selected' : ''}${lead ? ' lead' : ''}${hidden ? ' is-hidden' : ''}${arriving ? ' is-arriving' : ''}`} transform={`translate(${node.x},${node.y})`} opacity={hidden ? 0 : dim(node.id) ? 0.22 : 1}
            onPointerDown={(event) => onPointerDown(event, node.id)} onPointerEnter={() => setHover(node.id)} onPointerLeave={() => setHover(null)}>
            <g className="g-pop" style={{ ['--i' as string]: index }}>
            <circle className="g-avatar-core" r={node.r} fill={avatarFill(resolveAvatarHue(node.id, project.bible?.[node.id]))} />
            <circle className="g-ring" r={node.r - 2.5} />
            {selected === node.id && <circle className="g-halo" r={node.r + 9} />}
            <circle className={`g-speaking-ring${speaking ? ' is-speaking' : ''}`} r={node.r + 5} aria-hidden="true" />
            <text className="g-initial" textAnchor="middle" dominantBaseline="central" fontSize={Math.max(14, node.r * 0.62)}>{Array.from(node.id)[0]}</text>
            <text className="g-name" y={node.r + 20}>{node.id}</text>
            {showStats && node.info.lines > 0 && <text className="g-meta" y={node.r + 37}>{node.info.lines} 句 · {node.info.scenes.length} 場</text>}
            </g>
          </g>;
        })}
      </g>
    </svg>
    {analysis.scenes.length > 1 && <div className="graph-timeline" aria-label="時間軸">
      <button type="button" className="icon-button" aria-label={playing ? '暫停' : '播放關係變化'} onClick={() => {
        if (playing) { setPlaying(false); return; }
        if (!playbackStartedRef.current || at === null || at >= lastScene) {
          playbackStartedRef.current = true;
          arrivedNodesRef.current.clear();
          enteredRelationsRef.current.clear();
          setArrivedNodes(new Set());
          setEnteredRelations(new Set());
          setPlaybackRun((run) => run + 1);
          setAt(at === null || at >= lastScene ? 0 : at);
        }
        setPlaying(true);
      }}>
        {playing ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10M13 5v10" /></svg> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l8 5-8 5z" /></svg>}
      </button>
      <div className="gt-track-wrap">
        <span key={at === null ? 'all' : analysis.scenes[at]?.id ?? at} className="gt-caption" aria-live="polite">{at === null ? '全劇總覽・按播放從第 1 場開始' : `第 ${at + 1} 場・${analysis.scenes[at]?.title ?? ''}`}</span>
        <input type="range" min={0} max={lastScene} step="any" value={progress ?? lastScene} data-custom-range style={{ '--pct': `${lastScene > 0 ? ((progress ?? lastScene) / lastScene) * 100 : 100}%` } as import('react').CSSProperties} aria-label="故事進度（場次）" aria-valuetext={at === null ? '全劇' : `第 ${at + 1} 場`} onChange={(event) => { setPlaying(false); playbackStartedRef.current = false; setAt(Number(event.target.value)); }} />
      </div>
      <div className="gt-speed" role="group" aria-label="播放速度">
        {([0.5, 1, 2] as const).map((speed) => <button type="button" key={speed} className={playbackSpeed === speed ? 'active' : ''} aria-pressed={playbackSpeed === speed} onClick={() => setPlaybackSpeed(speed)}>{speed}×</button>)}
      </div>
      <button type="button" className={`toolbar-button${at === null ? ' active' : ''}`} onClick={() => { setPlaying(false); playbackStartedRef.current = false; setAt(null); }}>全劇</button>
    </div>}

    <aside className="graph-panel">
      {info ? <>
        <div className="gp-head">
          <span className="gp-avatar" style={avatarStyle(info.name, project.bible?.[info.name])}>{Array.from(info.name)[0]}</span>
          <div><h3>{info.name}</h3><p>{info.aliases.length ? `其他稱呼：${info.aliases.join('、')}` : info.description || '角色'}</p></div>
          <button className="dialog-close" aria-label="取消選取" onClick={() => selectCharacter(null)}>×</button>
        </div>
        <dl className="gp-stats">
          <div><dt>台詞</dt><dd>{info.lines}</dd></div>
          <div><dt>字數</dt><dd>{info.words}</dd></div>
          <div><dt>出場</dt><dd>{info.scenes.length}</dd></div>
        </dl>
        {info.scenes.length > 0 && <Disclosure className="gp-scenes" title="出場場次" badge={`${info.scenes.length} 場`} open={sceneDisclosureOpen} onToggle={() => setSceneDisclosureOpen((open) => !open)}>
          <div className="gp-scene-list">{info.scenes.map((index) => <button type="button" key={index} title={analysis.scenes[index]?.title} onClick={() => onJumpToScene(analysis.scenes[index].id)}>{index + 1}</button>)}</div>
        </Disclosure>}
        <Disclosure className="gp-form-disclosure" title="新增關係" badge={`${relations.filter((relation) => relation.from === info.name || relation.to === info.name).length} 條`} open={addRelationOpen} onToggle={() => setAddRelationOpen((open) => !open)}>
          <form className="gp-form" onSubmit={(event) => { event.preventDefault(); if (!linkTarget || linkTarget === info.name) return; onAddRelation({ from: info.name, to: linkTarget, type: linkType, ...(linkLabel.trim() ? { label: linkLabel.trim() } : {}), ...(linkSince ? { sinceScene: linkSince } : {}) }); setLinkLabel(''); }}>
            <Select ariaLabel="對象" placeholder="選擇對象…" value={linkTarget} options={analysis.characters.filter((item) => item.name !== info.name).map((item) => ({ value: item.name, label: item.name, hint: `${item.lines} 句` }))} onChange={setLinkTarget} />
            <div className="gp-types" role="group" aria-label="關係類型" data-seg-ignore>{RELATION_TYPES.map((type) => <button type="button" key={type} className={`rel-chip rel-${type}${linkType === type ? ' active' : ''}`} aria-pressed={linkType === type} onClick={() => setLinkType(type)}><span className="gp-chip-dot" aria-hidden="true" />{RELATION_LABELS[type]}</button>)}</div>
            <input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="補充描述（選填），如：青梅竹馬" maxLength={40} />
            <Select ariaLabel="從哪一場開始" value={linkSince} options={sinceSceneOptions} onChange={setLinkSince} collapsibleGroups preview={(option) => option.value ? <ScenePreview project={project} sceneId={option.value} /> : null} />
            <ul className="gp-help-list" aria-label="關係說明">
              <li><strong>多段關係</strong><span>可在不同場次轉變</span></li>
              <li><strong>例如</strong><span>第 5 場：同盟→敵對</span></li>
              <li><strong>時間軸</strong><span>拖曳查看變化</span></li>
            </ul>
            <button className="button-primary" type="submit" disabled={!linkTarget}>建立關係</button>
          </form>
        </Disclosure>
        <h4>關係</h4>
        <ul className="gp-relations" style={{ ['--gp-name-col' as string]: `${Math.min(5, Math.max(2, ...relations.filter((relation) => relation.from === info.name || relation.to === info.name).map((relation) => Array.from(relation.from === info.name ? relation.to : relation.from).reduce((width, char) => width + (/[ -ÿ]/.test(char) ? 0.6 : 1), 0))))}em` }}>
          {relations.filter((relation) => relation.from === info.name || relation.to === info.name).map((relation) => <li key={relation.id}>
            <span className={`rel-dot rel-${relation.type}`} />
            <span className="gp-relation-name" title={Array.from(relation.from === info.name ? relation.to : relation.from).length > 4 ? (relation.from === info.name ? relation.to : relation.from) : undefined}>{relation.from === info.name ? relation.to : relation.from}</span>
            <span className="gp-relation-text"><em>{relation.label || RELATION_LABELS[relation.type]}</em>{relation.sinceScene && <small>第 {sinceIndex(relation) + 1} 場起</small>}</span>
            <button aria-label="刪除關係" onClick={() => onRemoveRelation(relation.id)}>×</button>
          </li>)}
          {(neighbours.get(info.name)?.size ?? 0) === 0 && <li className="gp-muted">尚無連結</li>}
        </ul>
      </> : <>
        <h3 className="gp-title">角色星圖</h3>
        <ol className="gp-rank">
          {analysis.characters.slice(0, 12).map((item) => <li key={item.name}><button onClick={() => selectCharacter(item.name)}><span className="gp-rank-name">{item.name}</span><span className="gp-bar"><i style={{ width: `${(item.lines / maxLines) * 100}%` }} /></span><span className="gp-rank-n">{item.lines} 句</span></button></li>)}
        </ol>
      </>}
    </aside>
  </div>;
}
