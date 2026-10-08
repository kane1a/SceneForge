import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import './mindmap.css';
import { mindmapFromProject } from './story-analysis';
import { syncSegmentThumbs } from './segmented';
import { askConfirm } from './confirm';
import { Select, Switch } from './ui-controls';
import { exportGraphPng } from './graph-export';
import { useWheelZoom } from './graph-zoom';
import { ScenePreview, buildSceneSelectOptions } from './scene-select';
import { duplicateMindMapNode, fitMindMapToolbar, hasEditedGeneratedNodes, layoutMindMap, mergeRegeneratedMindMap, MindMapHistory, moveMindMapNode, pasteMindMapSubtree, readMindMapTogglePreference, reorderMindMapSibling, writeMindMapTogglePreference, type MindMapLayout, type PlacedMindNode } from './mindmap-model';
import type { MindNode, MindMapMarker, Project } from './types';

interface Props {
  project: Project;
  onChange: (tree: MindNode | undefined) => void;
  focusBranch?: string;
  onOpenScene?: (blockId: string) => void;
  onLeave?: () => void;
}

type Placed = PlacedMindNode;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const BRANCHES = 8;
const preferenceStorage = () => {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
};

let measureCanvas: HTMLCanvasElement | null = null;
function textWidth(text: string, font: string): number {
  measureCanvas ??= document.createElement('canvas');
  const context = measureCanvas.getContext('2d')!;
  context.font = font;
  return context.measureText(text || '　').width;
}
let fontUi = '';
const levelFont = (depth: number) => {
  fontUi ||= getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'sans-serif';
  return depth === 0 ? `600 21px ${fontUi}` : depth === 1 ? `600 14px ${fontUi}` : `400 13px ${fontUi}`;
};
const countDescendants = (node: MindNode): number => node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
const nodeSize = (node: MindNode, depth: number, folded = false) => {
  const pad = depth === 0 ? [26, 16] : depth === 1 ? [16, 10] : [8, 7];
  const text = Math.min(depth === 0 ? 360 : 280, textWidth(node.text, levelFont(depth)));
  const decoration = (node.marker ? 18 : 0) + (node.sceneId ? 42 : 0) + (node.note?.trim() ? 16 : 0);
  const w = text + pad[0] * 2 + decoration + (node.children.length && folded ? 30 : 0);
  const h = (depth === 0 ? 26 : depth === 1 ? 20 : 19) + pad[1] * 2 + (node.sceneId ? 7 : 0);
  return { w, h };
};

/** `depthLimit` folds everything deeper than N levels for display only — the saved tree is untouched. */
function layoutTree(root: MindNode, depthLimit: number, layout: MindMapLayout): Placed[] {
  return layoutMindMap(root, layout, (node, depth, folded) => nodeSize(node, depth, folded), depthLimit);
}

function mapTree(root: MindNode, id: string, change: (node: MindNode) => MindNode | null): MindNode {
  const visit = (node: MindNode): MindNode | null => {
    if (node.id === id) return change(node);
    const children = node.children.map(visit).filter((child): child is MindNode => child !== null);
    return children.length === node.children.length && children.every((child, index) => child === node.children[index]) ? node : { ...node, children };
  };
  return visit(root) ?? root;
}

function findParent(root: MindNode, id: string): MindNode | null {
  for (const child of root.children) {
    if (child.id === id) return root;
    const found = findParent(child, id);
    if (found) return found;
  }
  return null;
}

function findNode(root: MindNode, id: string): MindNode | null {
  if (root.id === id) return root;
  for (const child of root.children) { const found = findNode(child, id); if (found) return found; }
  return null;
}
const contains = (node: MindNode, id: string): boolean => node.children.some((child) => child.id === id || contains(child, id));
type DropMode = 'before' | 'after' | 'child';
const MARKERS: { value: MindMapMarker; label: string; glyph: string }[] = [
  { value: 'todo', label: '待辦', glyph: '○' },
  { value: 'done', label: '完成', glyph: '✓' },
  { value: 'important', label: '重要', glyph: '◆' },
  { value: 'question', label: '疑問', glyph: '?' },
  { value: 'foreshadow', label: '伏筆', glyph: '⋯' },
  { value: 'turn', label: '轉折', glyph: '↗' },
];

export default function MindMap({ project, onChange, focusBranch, onOpenScene, onLeave }: Props) {
  const tree = project.mindmap;
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [depthLimit, setDepthLimit] = useState<number>(Infinity);
  const [layout, setLayout] = useState<MindMapLayout>('both');
  const [inspectorOpen, setInspectorOpen] = useState(() => readMindMapTogglePreference(preferenceStorage(), 'inspector', true));
  const [outlineMode, setOutlineMode] = useState(() => readMindMapTogglePreference(preferenceStorage(), 'outline', false));
  const [minimapEnabled, setMinimapEnabled] = useState(() => readMindMapTogglePreference(preferenceStorage(), 'minimap', true));
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchAnchor, setSearchAnchor] = useState<'button' | 'more'>('button');
  const [searchPosition, setSearchPosition] = useState<{ left: number; top: number } | null>(null);
  const [toolbarOverflow, setToolbarOverflow] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  useLayoutEffect(() => { syncSegmentThumbs(wrapRef.current ?? document); });
  useEffect(() => { writeMindMapTogglePreference(preferenceStorage(), 'inspector', inspectorOpen); }, [inspectorOpen]);
  useEffect(() => { writeMindMapTogglePreference(preferenceStorage(), 'outline', outlineMode); }, [outlineMode]);
  useEffect(() => { writeMindMapTogglePreference(preferenceStorage(), 'minimap', minimapEnabled); }, [minimapEnabled]);
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (focusBranch !== undefined) {
      const target = focusBranch || null;
      setFocusId(target);
      setSelected(target);
      if (target) setDepthLimit(Infinity);
    }
  }, [focusBranch]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  useWheelZoom(svgRef, setView, 0.25, 2.5);
  const searchRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const searchPopoverRef = useRef<HTMLDivElement>(null);
  const leaveRef = useRef(onLeave);
  const leaveTimerRef = useRef<number | null>(null);
  const finishedEditRef = useRef<string | null>(null);
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const historyRef = useRef(new MindMapHistory<MindNode>(100));
  const copiedRef = useRef<MindNode | null>(null);
  const outlineSkipBlurRef = useRef<string | null>(null);
  useEffect(() => { leaveRef.current = onLeave; }, [onLeave]);
  useEffect(() => {
    if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
    return () => {
      leaveTimerRef.current = window.setTimeout(() => { leaveRef.current?.(); leaveTimerRef.current = null; }, 0);
    };
  }, []);
  useEffect(() => {
    if (!moreOpen && !searchOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (moreOpen && !moreWrapRef.current?.contains(target as Node)) setMoreOpen(false);
      const searchTrigger = searchAnchor === 'more'
        ? moreWrapRef.current?.querySelector('.mm-more-button')
        : toolbarRef.current?.querySelector('.mm-search-trigger');
      if (searchOpen && !searchPopoverRef.current?.contains(target as Node) && !searchTrigger?.contains(target as Node)) setSearchOpen(false);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMoreOpen(false);
      setSearchOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
    };
  }, [moreOpen, searchOpen, searchAnchor]);
  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);
  useLayoutEffect(() => {
    if (!searchOpen) { setSearchPosition(null); return; }
    const updatePosition = () => {
      const toolbar = toolbarRef.current;
      const anchor = searchAnchor === 'more'
        ? moreWrapRef.current?.querySelector<HTMLElement>('.mm-more-button')
        : toolbar?.querySelector<HTMLElement>('.mm-search-trigger');
      if (!toolbar || !anchor) return;
      const toolbarRect = toolbar.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      setSearchPosition({ left: anchorRect.left - toolbarRect.left, top: anchorRect.bottom - toolbarRect.top + 8 });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [searchOpen, searchAnchor, inspectorOpen, toolbarOverflow]);
  useEffect(() => { historyRef.current.clear(); copiedRef.current = null; }, [project.id]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  // Dragging a topic onto another: middle = becomes its child, top/bottom edge = goes before/after it.
  const dragRef = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; target?: { id: string; mode: DropMode } } | null>(null);
  const path = useMemo(() => {
    if (!tree || !focusId) return [] as MindNode[];
    const walk = (node: MindNode, trail: MindNode[]): MindNode[] | null => {
      if (node.id === focusId) return [...trail, node];
      for (const child of node.children) { const found = walk(child, [...trail, node]); if (found) return found; }
      return null;
    };
    return walk(tree, []) ?? [];
  }, [tree, focusId]);
  const displayRoot = path.at(-1) ?? tree;
  const pathKey = path.map((node) => node.id).join('>');
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const measure = () => {
      const bounds = toolbar.getBoundingClientRect();
      if (bounds.width < 1) return;
      const computed = getComputedStyle(toolbar);
      const available = bounds.width - parseFloat(computed.paddingLeft || '0') - parseFloat(computed.paddingRight || '0');
      const moreWidth = moreWrapRef.current?.getBoundingClientRect().width ?? 72;
      const items = Array.from(toolbar.querySelectorAll<HTMLElement>('[data-mm-toolbar-item]')).map((element) => ({
        id: element.dataset.mmToolbarItem ?? '',
        width: element.getBoundingClientRect().width,
        priority: Number(element.dataset.priority ?? 0),
      })).filter((item) => item.id);
      const fitted = fitMindMapToolbar(items, available, moreWidth, parseFloat(computed.columnGap || computed.gap || '5'));
      setToolbarOverflow((current) => current.length === fitted.overflow.length && current.every((id, index) => id === fitted.overflow[index]) ? current : fitted.overflow);
    };
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(toolbar);
    toolbar.querySelectorAll<HTMLElement>('[data-mm-toolbar-item]').forEach((element) => observer?.observe(element));
    if (moreWrapRef.current) observer?.observe(moreWrapRef.current);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [inspectorOpen, layout, outlineMode, pathKey, view.k]);
  const placed = useMemo(() => displayRoot ? layoutTree(displayRoot, depthLimit, layout) : [], [displayRoot, depthLimit, layout]);
  const byId = useMemo(() => new Map(placed.map((item) => [item.node.id, item])), [placed]);
  const selectedNode = tree && selected ? findNode(tree, selected) : null;
  const scenes = useMemo(() => {
    let act = '故事';
    let actNumber = 0;
    let sceneNumber = 0;
    const result: { id: string; label: string; title: string }[] = [];
    for (const block of project.blocks) {
      if (block.type === 'act') { actNumber += 1; sceneNumber = 0; act = block.text.trim() || `第 ${actNumber} 幕`; }
      if (block.type === 'scene') {
        sceneNumber += 1;
        result.push({ id: block.id, label: `${act} → 第 ${sceneNumber} 場`, title: block.text });
      }
    }
    return result;
  }, [project.blocks]);
  const sceneById = useMemo(() => new Map(scenes.map((scene) => [scene.id, scene])), [scenes]);
  const sceneSelectOptions = useMemo(() => buildSceneSelectOptions(project.blocks, '未連結'), [project.blocks]);
  const searchMatches = useMemo(() => {
    if (!tree || !searchQuery.trim()) return [] as MindNode[];
    const needle = searchQuery.trim().toLocaleLowerCase();
    const found: MindNode[] = [];
    const visit = (node: MindNode) => {
      if (node.text.toLocaleLowerCase().includes(needle) || node.note?.toLocaleLowerCase().includes(needle)) found.push(node);
      node.children.forEach(visit);
    };
    visit(tree);
    return found;
  }, [tree, searchQuery]);
  useEffect(() => { setSearchIndex(0); }, [searchQuery]);
  useEffect(() => {
    if (!selectedNode) { setTitleDraft(''); setNoteDraft(''); return; }
    setTitleDraft(selectedNode.text);
    setNoteDraft(selectedNode.note ?? '');
  }, [selected]);
  useEffect(() => {
    if (tree && focusId && !path.length) {
      setFocusId(null);
      return;
    }
    if (tree && selected && !findNode(tree, selected)) setSelected(tree.id);
  }, [tree, focusId, path.length, selected]);
  useLayoutEffect(() => { requestAnimationFrame(() => center()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [depthLimit, focusId, layout, inspectorOpen]);

  const center = () => {
    const svg = svgRef.current;
    if (!svg || !placed.length) return;
    const { width, height } = svg.getBoundingClientRect();
    const minX = Math.min(...placed.map((p) => p.x)) - 40, maxX = Math.max(...placed.map((p) => p.x + p.w)) + 40;
    const minY = Math.min(...placed.map((p) => p.y)) - 40, maxY = Math.max(...placed.map((p) => p.y + p.h)) + 40;
    const top = 76, bottom = 64;
    const k = Math.min(1.25, Math.max(0.3, Math.min(width / (maxX - minX), (height - top - bottom) / (maxY - minY))));
    setView({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: top + (height - top - bottom) / 2 - ((minY + maxY) / 2) * k });
  };
  const centerNode = (id: string) => {
    const item = byId.get(id);
    const svg = svgRef.current;
    if (!item || !svg) return;
    const { width, height } = svg.getBoundingClientRect();
    setView((current) => ({ ...current, x: width / 2 - (item.x + item.w / 2) * current.k, y: height / 2 - (item.y + item.h / 2) * current.k }));
  };
  const zoomBy = (amount: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    const k = Math.min(2.5, Math.max(0.25, view.k * amount));
    const px = width / 2, py = height / 2;
    setView((current) => ({ k, x: px - ((px - current.x) / current.k) * k, y: py - ((py - current.y) / current.k) * k }));
  };
  const worldBounds = useMemo(() => {
    if (!placed.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    const minX = Math.min(...placed.map((item) => item.x));
    const maxX = Math.max(...placed.map((item) => item.x + item.w));
    const minY = Math.min(...placed.map((item) => item.y));
    const maxY = Math.max(...placed.map((item) => item.y + item.h));
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }, [placed]);
  const minimapVisible = minimapEnabled && !outlineMode && (worldBounds.width * view.k > canvasSize.width - 24 || worldBounds.height * view.k > canvasSize.height - 24);
  useLayoutEffect(() => {
    if (!tree) return;
    const frame = requestAnimationFrame(() => center());
    return () => cancelAnimationFrame(frame);
    // A newly mounted map always returns to the full-map fit view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, tree?.id]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(svg);
    return () => observer.disconnect();
  }, [tree !== undefined, outlineMode, inspectorOpen]);



  const commit = (next: MindNode) => {
    if (tree && next === tree) return;
    if (tree) historyRef.current.push(tree);
    onChange(next);
  };
  const startEdit = (id: string) => { const node = byId.get(id)?.node; if (!node) return; finishedEditRef.current = null; setSelected(id); setEditing(id); setDraft(node.text); };
  const finishEdit = () => {
    if (!tree || !editing || finishedEditRef.current === editing) return;
    const id = editing;
    finishedEditRef.current = id;
    setEditing(null);
    commit(mapTree(tree, id, (node) => {
      const text = draft.trim() || node.text || '主題';
      return { ...node, text, edited: node.generated ? node.edited || text !== node.text : node.edited };
    }));
    requestAnimationFrame(() => wrapRef.current?.focus());
  };
  const cancelEdit = (id: string) => {
    finishedEditRef.current = id;
    setEditing(null);
    requestAnimationFrame(() => wrapRef.current?.focus());
  };
  const saveTitle = (id: string, value = titleDraft) => {
    if (!tree) return;
    const current = findNode(tree, id);
    if (!current) return;
    const text = value.trim() || current.text || '主題';
    if (text === current.text) return;
    commit(mapTree(tree, id, (node) => ({ ...node, text, edited: node.generated ? node.edited || text !== node.text : node.edited })));
  };
  const saveNote = (id: string, value = noteDraft) => {
    if (!tree) return;
    const current = findNode(tree, id);
    const note = value || undefined;
    if (!current || current.note === note) return;
    commit(mapTree(tree, id, (node) => ({ ...node, note, edited: node.generated ? true : node.edited })));
  };
  const editNode = (id: string, change: (node: MindNode) => MindNode) => {
    if (!tree) return;
    const current = findNode(tree, id);
    if (!current) return;
    const changed = change(current);
    if (changed.text === current.text && changed.note === current.note && changed.sceneId === current.sceneId && changed.marker === current.marker && changed.color === current.color && changed.side === current.side && changed.collapsed === current.collapsed) return;
    commit(mapTree(tree, id, () => current.generated ? { ...changed, edited: true } : changed));
  };
  const addChild = (id: string) => {
    if (!tree) return;
    const child: MindNode = { id: newId(), text: '新主題', children: [] };
    commit(mapTree(tree, id, (node) => ({ ...node, collapsed: false, children: [...node.children, child] })));
    setSelected(child.id); setEditing(child.id); setDraft('新主題');
    const currentDepth = byId.get(id)?.depth ?? 0;
    setDepthLimit((limit) => limit === Infinity ? limit : Math.max(limit, currentDepth + 2));
  };
  const addSibling = (id: string) => {
    if (!tree) return;
    const parent = findParent(tree, id);
    if (!parent) { addChild(id); return; }
    const sibling: MindNode = { id: newId(), text: '新主題', children: [] };
    commit(mapTree(tree, parent.id, (node) => {
      const index = node.children.findIndex((child) => child.id === id);
      const children = [...node.children];
      children.splice(index + 1, 0, sibling);
      return { ...node, children };
    }));
    if (displayRoot?.id === id) setFocusId(parent.id === tree.id ? null : parent.id);
    setSelected(sibling.id); setEditing(sibling.id); setDraft('新主題');
  };
  const remove = (id: string) => {
    if (!tree || id === tree.id) return;
    const parent = findParent(tree, id);
    commit(mapTree(tree, id, () => null));
    setSelected(parent?.id ?? tree.id);
  };
  const toggle = (id: string) => { if (tree) commit(mapTree(tree, id, (node) => node.children.length ? { ...node, collapsed: !node.collapsed } : node)); };
  const moveNode = (id: string, targetId: string, mode: DropMode) => {
    if (!tree) return;
    const next = moveMindMapNode(tree, id, targetId, mode);
    if (next !== tree) { commit(next); setSelected(id); }
  };
  const shift = (id: string, delta: number) => { if (tree) commit(reorderMindMapSibling(tree, id, delta)); };
  const expandAll = () => {
    if (!tree) return;
    const visit = (node: MindNode): MindNode => ({ ...node, collapsed: false, children: node.children.map(visit) });
    commit(visit(tree)); setDepthLimit(Infinity);
  };
  const collapseAll = () => {
    if (!tree) return;
    const visit = (node: MindNode, root = false): MindNode => ({ ...node, collapsed: !root && node.children.length > 0, children: node.children.map((child) => visit(child)) });
    commit(visit(tree, true)); setDepthLimit(Infinity);
  };
  const setBranchColor = (id: string, color: number) => {
    if (!tree || id === tree.id) return;
    const branch = tree.children.find((child) => child.id === id || contains(child, id));
    if (branch) editNode(branch.id, (node) => ({ ...node, color }));
  };
  const copySelected = () => { if (selectedNode) copiedRef.current = selectedNode; };
  const pasteSelected = () => {
    if (!tree || !copiedRef.current) return;
    const target = selectedNode?.id ?? tree.id;
    const pasted = pasteMindMapSubtree(tree, target, copiedRef.current, newId);
    commit(pasted);
    const parent = findNode(pasted, target);
    const inserted = parent?.children.at(-1);
    if (inserted) setSelected(inserted.id);
  };
  const duplicateSelected = () => {
    if (!tree || !selected || selected === tree.id) return;
    const duplicated = duplicateMindMapNode(tree, selected, newId);
    const parent = findParent(duplicated, selected);
    const originalIndex = parent?.children.findIndex((child) => child.id === selected) ?? -1;
    commit(duplicated);
    if (parent && originalIndex >= 0) setSelected(parent.children[originalIndex + 1]?.id ?? selected);
  };
  const undo = () => { if (!tree) return; const previous = historyRef.current.undo(tree); if (previous) onChange(previous); };
  const redo = () => { if (!tree) return; const next = historyRef.current.redo(tree); if (next) onChange(next); };
  const regenerate = async () => {
    if (!tree) return;
    const fresh = mindmapFromProject(project);
    if (hasEditedGeneratedNodes(tree)) {
      const ok = await askConfirm({ title: '更新已修改的自動分支？', message: '您編輯過由劇本生成的主題；確認後將以最新劇本內容更新，個人備註與手動新增主題會保留。', confirmLabel: '更新分支' });
      if (!ok) return;
    }
    commit(mergeRegeneratedMindMap(tree, fresh));
  };
  const cycleSearch = (direction = 1) => {
    if (!searchMatches.length) return;
    const currentIndex = searchMatches.findIndex((match) => match.id === selected);
    const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : searchMatches.length - 1) : (currentIndex + direction + searchMatches.length) % searchMatches.length;
    const match = searchMatches[nextIndex];
    setSearchIndex(nextIndex);
    setSelected(match.id);
    setDepthLimit(Infinity);
    if (tree) {
      const expandPath = (node: MindNode): { node: MindNode; found: boolean } => {
        if (node.id === match.id) return { node, found: true };
        for (let index = 0; index < node.children.length; index += 1) {
          const result = expandPath(node.children[index]);
          if (result.found) {
            const children = [...node.children]; children[index] = result.node;
            return { node: { ...node, collapsed: false, children }, found: true };
          }
        }
        return { node, found: false };
      };
      const expanded = expandPath(tree).node;
      if (expanded !== tree) commit(expanded);
    }
  };
  const openScene = (sceneId?: string) => { if (sceneId && sceneById.has(sceneId)) onOpenScene?.(sceneId); };
  useEffect(() => { if (selected && searchMatches.some((match) => match.id === selected)) requestAnimationFrame(() => centerNode(selected)); }, [selected, searchMatches, placed]);
  const toWorld = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };
  const dropTarget = (clientX: number, clientY: number, id: string): { id: string; mode: DropMode } | undefined => {
    const point = toWorld(clientX, clientY);
    const moving = tree ? findNode(tree, id) : null;
    const hit = placed.find((item) => item.node.id !== id && !(moving && contains(moving, item.node.id)) && point.x >= item.x - 6 && point.x <= item.x + item.w + 6 && point.y >= item.y - 6 && point.y <= item.y + item.h + 6);
    if (!hit) return undefined;
    if (hit.depth === 0) return { id: hit.node.id, mode: 'child' };
    const ratio = (point.y - hit.y) / hit.h;
    return { id: hit.node.id, mode: ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'child' };
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!tree || editing) return;
    const target = event.target as HTMLElement;
    const isField = target.closest('input, textarea, select, [contenteditable="true"]');
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'f' && !isField) {
      event.preventDefault(); event.stopPropagation(); setMoreOpen(false); setSearchAnchor(toolbarOverflow.includes('search') ? 'more' : 'button'); setSearchOpen(true); requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); }); return;
    }
    if (command && !isField) {
      const key = event.key.toLowerCase();
      if (key === 'z' || key === 'y' || key === 'c' || key === 'v' || key === 'd') {
        event.preventDefault(); event.stopPropagation();
        if (key === 'z' && event.shiftKey || key === 'y') redo();
        else if (key === 'z') undo();
        else if (key === 'c') copySelected();
        else if (key === 'v') pasteSelected();
        else duplicateSelected();
        return;
      }
    }
    if (target !== wrapRef.current && isField) return;
    if ((event.key === 'Escape' || event.key === 'Backspace') && path.length > 1) {
      event.preventDefault();
      const previous = path[path.length - 2];
      setFocusId(previous.id === tree.id ? null : previous.id);
      setDepthLimit(Infinity);
      setSelected(previous.id);
      return;
    }
    const current = selected ? byId.get(selected) : undefined;
    if (!current) { if (event.key.startsWith('Arrow') || event.key === 'Enter') { setSelected(tree.id); event.preventDefault(); } return; }
    const id = current.node.id;
    const spatial = (direction: 'left' | 'right' | 'up' | 'down') => {
      const sign = direction === 'left' || direction === 'up' ? -1 : 1;
      const horizontal = direction === 'left' || direction === 'right';
      const cx = current.x + current.w / 2, cy = current.y + current.h / 2;
      const candidates = placed.filter((item) => item.node.id !== id).map((item) => {
        const dx = item.x + item.w / 2 - cx, dy = item.y + item.h / 2 - cy;
        const primary = (horizontal ? dx : dy) * sign;
        const cross = Math.abs(horizontal ? dy : dx);
        return { item, primary, score: primary + cross * 1.35 };
      }).filter((candidate) => candidate.primary > 2).sort((a, b) => a.score - b.score);
      if (candidates[0]) setSelected(candidates[0].item.node.id);
    };
    switch (event.key) {
      case 'Tab': event.preventDefault(); addChild(id); break;
      case 'Enter': event.preventDefault(); addSibling(id); break;
      case 'F2': event.preventDefault(); startEdit(id); break;
      case 'Delete': event.preventDefault(); remove(id); break;
      case ' ': event.preventDefault(); toggle(id); break;
      case 'ArrowUp': event.preventDefault(); if (event.altKey) shift(id, -1); else spatial('up'); break;
      case 'ArrowDown': event.preventDefault(); if (event.altKey) shift(id, 1); else spatial('down'); break;
      case 'ArrowLeft': event.preventDefault(); spatial('left'); break;
      case 'ArrowRight': event.preventDefault(); spatial('right'); break;
      default:
        if (event.key.length === 1 && !command && !event.altKey) { event.preventDefault(); setEditing(id); setSelected(id); setDraft(event.key); }
    }
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if ((event.target as Element).closest('.mm-node, foreignObject')) return;
    pan.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const dragging = dragRef.current;
    if (dragging) {
      const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
      if (!dragging.active && Math.hypot(dx, dy) < 5) return;
      if (!dragging.active) svgRef.current?.setPointerCapture(event.pointerId);
      dragging.active = true;
      setDrag({ id: dragging.id, dx: dx / view.k, dy: dy / view.k, target: dropTarget(event.clientX, event.clientY, dragging.id) });
      return;
    }
    const state = pan.current;
    if (state) setView((current) => ({ ...current, x: state.ox + event.clientX - state.x, y: state.oy + event.clientY - state.y }));
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    pan.current = null;
    const dragging = dragRef.current;
    dragRef.current = null;
    if (dragging?.active && drag?.target) moveNode(dragging.id, drag.target.id, drag.target.mode);
    else if (dragging?.active && displayRoot) placeOnSide(dragging.id, toWorld(event.clientX, event.clientY).x);
    setDrag(null);
  };
  // Dropped on empty space: becomes (or stays) a main branch on that side of the centre topic.
  const placeOnSide = (id: string, worldX: number) => {
    if (!tree || !displayRoot || id === displayRoot.id) return;
    const rootItem = byId.get(displayRoot.id);
    const side: 'left' | 'right' = rootItem && worldX < rootItem.x + rootItem.w / 2 ? 'left' : 'right';
    const moving = findNode(tree, id);
    if (!moving || contains(moving, displayRoot.id)) return;
    const withoutIt = mapTree(tree, id, () => null);
    commit(mapTree(withoutIt, displayRoot.id, (node) => ({ ...node, collapsed: false, children: [...node.children, { ...moving, side }] })));
    setSelected(id);
  };

  const exportPng = () => exportGraphPng(svgRef.current, `${project.title}-心智圖.png`, [...Array(BRANCHES).keys()].map((i) => `--mm-${i}`).concat(['--ink', '--paper', '--raised', '--muted', '--line', '--desk', '--font-ui', '--primary', '--primary-ink']));

  if (!tree) {
    return <div className="graph-empty">
      <div className="mm-empty-art" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <h2>心智圖</h2>
      <p>從劇本一鍵生成故事結構、角色與故事線的心智圖，或從一張白紙開始發想。</p>
      <div className="graph-empty-actions">
        <button className="button-primary" onClick={() => onChange(mindmapFromProject(project))}>從劇本生成</button>
        <button className="button-ghost" onClick={() => onChange({ id: newId(), text: project.title || '我的故事', children: [] })}>空白心智圖</button>
      </div>
    </div>;
  }

  const branchVar = (item: Placed) => item.branch < 0 ? 'var(--ink)' : `var(--mm-${item.branch})`;

  const selectedBranch = selectedNode && selectedNode.id !== tree.id ? tree.children.find((child) => child.id === selectedNode.id || contains(child, selectedNode.id)) : undefined;
  const colorIndex = selectedBranch?.color ?? (selectedBranch ? tree.children.indexOf(selectedBranch) % BRANCHES : -1);
  const outlineItems: { node: MindNode; depth: number; parentId?: string }[] = [];
  const outlineWalk = (node: MindNode, depth: number, parentId?: string) => { outlineItems.push({ node, depth, parentId }); node.children.forEach((child) => outlineWalk(child, depth + 1, node.id)); };
  outlineWalk(tree, 0);
  const saveOutlineTitle = (id: string, value: string) => mapTree(tree, id, (node) => {
    const text = value.trim() || node.text || '主題';
    if (text === node.text) return node;
    return { ...node, text, edited: node.generated ? node.edited || text !== node.text : node.edited };
  });
  const outlineIndent = (id: string, outdent: boolean, value: string) => {
    let next = saveOutlineTitle(id, value);
    const parent = findParent(next, id);
    if (!parent) { commit(next); setEditing(null); return; }
    if (outdent) {
      const grandparent = findParent(next, parent.id);
      if (grandparent) next = moveMindMapNode(next, id, parent.id, 'after');
    } else {
      const index = parent.children.findIndex((child) => child.id === id);
      if (index > 0) next = moveMindMapNode(next, id, parent.children[index - 1].id, 'child');
    }
    commit(next);
    setEditing(null);
  };
  const outlineAddSibling = (id: string, value: string) => {
    let next = saveOutlineTitle(id, value);
    const parent = findParent(next, id);
    const sibling: MindNode = { id: newId(), text: '新主題', children: [] };
    if (!parent) {
      next = mapTree(next, id, (node) => ({ ...node, children: [...node.children, sibling] }));
      commit(next); setSelected(sibling.id); setEditing(sibling.id); setDraft(sibling.text); return;
    }
    next = mapTree(next, parent.id, (node) => {
      const children = [...node.children];
      children.splice(children.findIndex((child) => child.id === id) + 1, 0, sibling);
      return { ...node, children };
    });
    commit(next); setSelected(sibling.id); setEditing(sibling.id); setDraft(sibling.text);
  };
  const minimapClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix || !svgRef.current) return;
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const world = point.matrixTransform(matrix.inverse());
    const { width, height } = svgRef.current.getBoundingClientRect();
    setView((current) => ({ ...current, x: width / 2 - world.x * current.k, y: height / 2 - world.y * current.k }));
  };

  return <div className="graph-wrap mm-wrap" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="心智圖；方向鍵移動，Alt+方向鍵調整順序，拖曳主題重新歸類，Tab 新增子主題，Enter 新增同級，F2 編輯，Delete 刪除，空白鍵收合">
    <div className="graph-toolbar" ref={toolbarRef}>
      {path.length > 1 && <div className="mm-toolbar-item" data-mm-toolbar-item="crumbs" data-priority="3" data-overflowed={toolbarOverflow.includes('crumbs')} aria-hidden={toolbarOverflow.includes('crumbs') || undefined} inert={toolbarOverflow.includes('crumbs')}>
        <nav className="mm-crumbs" aria-label="心智圖路徑">
          {path.map((node, index) => <span key={node.id}>{index > 0 && <i aria-hidden="true">›</i>}<button type="button" className={index === path.length - 1 ? 'here' : ''} aria-current={index === path.length - 1 ? 'page' : undefined} onClick={() => { setFocusId(index === 0 ? null : node.id); setDepthLimit(Infinity); }}>{index === 0 ? '全圖' : node.text || '主題'}</button></span>)}
        </nav>
      </div>}
      <div className="mm-toolbar-item" data-mm-toolbar-item="layouts" data-priority="7" data-overflowed={toolbarOverflow.includes('layouts')} aria-hidden={toolbarOverflow.includes('layouts') || undefined} inert={toolbarOverflow.includes('layouts')}>
        <div className="mm-toolbar-group mm-layouts" role="group" aria-label="心智圖版面" data-seg-ignore>
          {([['both', '兩側展開'], ['right', '向右展開'], ['org', '組織圖']] as [MindMapLayout, string][]).map(([value, label]) => <button type="button" key={value} className={layout === value ? 'active' : ''} aria-pressed={layout === value} onClick={() => setLayout(value)}>{label}</button>)}
        </div>
      </div>
      <div className="mm-toolbar-item" data-mm-toolbar-item="levels" data-priority="6" data-overflowed={toolbarOverflow.includes('levels')} aria-hidden={toolbarOverflow.includes('levels') || undefined} inert={toolbarOverflow.includes('levels')}>
        <div className="mm-levels" role="group" aria-label="顯示層級" data-seg-ignore>
          {[1, 2, 3].map((level) => <button key={level} title={`顯示到第 ${level} 層`} className={depthLimit === level ? 'active' : ''} aria-pressed={depthLimit === level} onClick={() => setDepthLimit(level)}>{level}</button>)}
          <button title="顯示全部層級" className={depthLimit === Infinity ? 'active' : ''} aria-pressed={depthLimit === Infinity} onClick={expandAll}>全部</button>
        </div>
      </div>
      <div className="mm-toolbar-item" data-mm-toolbar-item="zoom" data-priority="10" data-overflowed={toolbarOverflow.includes('zoom')} aria-hidden={toolbarOverflow.includes('zoom') || undefined} inert={toolbarOverflow.includes('zoom')}>
        <div className="mm-zoom" aria-label="縮放控制">
          <button type="button" title="縮小" aria-label="縮小" onClick={() => zoomBy(1 / 1.15)}>−</button>
          <span aria-live="polite">{Math.round(view.k * 100)}%</span>
          <button type="button" title="放大" aria-label="放大" onClick={() => zoomBy(1.15)}>＋</button>
          <button type="button" title="縮放至適合畫面" aria-label="縮放至適合畫面" onClick={center}>適合</button>
        </div>
      </div>
      <div className="mm-toolbar-item mm-search-trigger-wrap" data-mm-toolbar-item="search" data-priority="8" data-overflowed={toolbarOverflow.includes('search')} aria-hidden={toolbarOverflow.includes('search') || undefined} inert={toolbarOverflow.includes('search')}>
        <button type="button" className="mm-search-trigger" aria-label="搜尋心智圖" title="搜尋主題與備註（Ctrl+F）" aria-expanded={searchOpen} onClick={() => { setMoreOpen(false); setSearchAnchor('button'); setSearchOpen((value) => !value); }}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg></button>
      </div>
      <div className="mm-toolbar-item" data-mm-toolbar-item="outline" data-priority="4" data-overflowed={toolbarOverflow.includes('outline')} aria-hidden={toolbarOverflow.includes('outline') || undefined} inert={toolbarOverflow.includes('outline')}>
        <Switch checked={outlineMode} onChange={setOutlineMode} label="大綱" title="切換可編輯大綱模式" className="mm-toolbar-switch" />
      </div>
      <div className="mm-toolbar-item" data-mm-toolbar-item="inspector" data-priority="5" data-overflowed={toolbarOverflow.includes('inspector')} aria-hidden={toolbarOverflow.includes('inspector') || undefined} inert={toolbarOverflow.includes('inspector')}>
        <Switch checked={inspectorOpen} onChange={setInspectorOpen} label="檢查器" title="顯示或隱藏右側主題檢查器" className="mm-toolbar-switch" />
      </div>
      <div className="mm-more-wrap" ref={moreWrapRef}>
        <button type="button" className="toolbar-button mm-more-button" aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => { setSearchOpen(false); setMoreOpen((value) => !value); }}>更多 ▾</button>
        {moreOpen && <div className="mm-more-menu" role="menu" aria-label="更多心智圖工具">
          {toolbarOverflow.length > 0 && <>
            <div className="mm-menu-label">工具列</div>
            {toolbarOverflow.includes('crumbs') && path.map((node, index) => <button key={`crumb-${node.id}`} role="menuitem" onClick={() => { setFocusId(index === 0 ? null : node.id); setDepthLimit(Infinity); setMoreOpen(false); }}>{index === 0 ? '全圖' : `聚焦：${node.text || '主題'}`}</button>)}
            {toolbarOverflow.includes('layouts') && <div className="mm-overflow-control"><small>版面</small>{([['both', '兩側展開'], ['right', '向右展開'], ['org', '組織圖']] as [MindMapLayout, string][]).map(([value, label]) => <button key={value} role="menuitemradio" aria-checked={layout === value} onClick={() => { setLayout(value); setMoreOpen(false); }}>{label}</button>)}</div>}
            {toolbarOverflow.includes('levels') && <div className="mm-overflow-control"><small>顯示層級</small>{[1, 2, 3].map((level) => <button key={level} role="menuitemradio" aria-checked={depthLimit === level} onClick={() => { setDepthLimit(level); setMoreOpen(false); }}>第 {level} 層</button>)}<button role="menuitemradio" aria-checked={depthLimit === Infinity} onClick={() => { expandAll(); setMoreOpen(false); }}>全部</button></div>}
            {toolbarOverflow.includes('zoom') && <div className="mm-overflow-control"><small>縮放</small><div className="mm-menu-zoom"><button role="menuitem" onClick={() => { zoomBy(1 / 1.15); setMoreOpen(false); }}>− 縮小</button><span>{Math.round(view.k * 100)}%</span><button role="menuitem" onClick={() => { zoomBy(1.15); setMoreOpen(false); }}>＋ 放大</button><button role="menuitem" onClick={() => { center(); setMoreOpen(false); }}>適合</button></div></div>}
            {toolbarOverflow.includes('search') && <button role="menuitem" onClick={() => { setMoreOpen(false); setSearchAnchor('more'); setSearchOpen(true); }}>搜尋心智圖…</button>}
            {toolbarOverflow.includes('outline') && <button role="menuitemcheckbox" aria-checked={outlineMode} onClick={() => { setOutlineMode((value) => !value); setMoreOpen(false); }}>大綱：{outlineMode ? '開啟' : '關閉'}</button>}
            {toolbarOverflow.includes('inspector') && <button role="menuitemcheckbox" aria-checked={inspectorOpen} onClick={() => { setInspectorOpen((value) => !value); setMoreOpen(false); }}>檢查器：{inspectorOpen ? '顯示' : '隱藏'}</button>}
          </>}
          <div className="mm-menu-label">編輯主題</div>
          <button role="menuitem" disabled={!selectedNode} title={!selectedNode ? '先選取一個主題' : '新增子主題'} onClick={() => { if (selected) addChild(selected); setMoreOpen(false); }}>子主題</button>
          <button role="menuitem" disabled={!selectedNode} title={!selectedNode ? '先選取一個主題' : '新增同級主題'} onClick={() => { if (selected) addSibling(selected); setMoreOpen(false); }}>同級</button>
          <button role="menuitem" disabled={!selectedNode} title={!selectedNode ? '先選取一個主題' : '編輯主題標題'} onClick={() => { if (selected) startEdit(selected); setMoreOpen(false); }}>編輯文字</button>
          <button role="menuitem" disabled={!selectedNode || selected === tree.id} title={selected === tree.id ? '中心主題不能刪除' : !selectedNode ? '先選取要刪除的主題' : '刪除主題及其子題'} onClick={() => { if (selected) remove(selected); setMoreOpen(false); }}>刪除</button>
          <div className="mm-menu-label">檢視與整理</div>
          <button role="menuitem" disabled={!selectedNode || selected === displayRoot?.id} title={!selectedNode ? '先選取分支' : '聚焦選取分支'} onClick={() => { if (selected) { setFocusId(selected); setDepthLimit(Infinity); } setMoreOpen(false); }}>聚焦分支</button>
          <button role="menuitem" onClick={() => { center(); setMoreOpen(false); }}>置中目前畫面</button>
          <button role="menuitem" onClick={() => { expandAll(); setMoreOpen(false); }}>全部展開</button>
          <button role="menuitem" onClick={() => { collapseAll(); setMoreOpen(false); }}>全部收合</button>
          <Switch checked={minimapEnabled} onChange={(value) => { setMinimapEnabled(value); setMoreOpen(false); }} label="小地圖" title="顯示或隱藏小地圖" className="mm-more-switch" />
          <div className="mm-menu-label">匯出與更新</div>
          <button role="menuitem" onClick={() => { void regenerate(); setMoreOpen(false); }}>從劇本重新生成</button>
          <button role="menuitem" onClick={() => { void exportPng(); setMoreOpen(false); }}>匯出 PNG</button>
        </div>}
      </div>
      {searchOpen && <div className="mm-search-popover" ref={searchPopoverRef} style={searchPosition ?? undefined}>
        <label className="mm-search" title="搜尋主題與備註（Ctrl+F）">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>
          <input ref={searchRef} type="search" placeholder="搜尋心智圖…" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); } else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); cycleSearch(event.shiftKey ? -1 : 1); } }} />
          {searchQuery && <small>{searchMatches.length ? `${Math.min(searchIndex + 1, searchMatches.length)} / ${searchMatches.length}` : '0 項'}</small>}
        </label>
      </div>}
    </div>
    <div className={`mm-workspace ${inspectorOpen ? 'inspector-open' : ''}`}>
      {outlineMode ? <div className="mm-outline" role="tree" aria-label="心智圖大綱" onClick={(event) => { const target = event.target; if (target instanceof Element && !target.closest('.mm-outline-row, button, input, [role="dialog"], [role="menu"]')) setSelected(null); }}>
        {outlineItems.map(({ node, depth, parentId }) => <div className={`mm-outline-row${selected === node.id ? ' selected' : ''}`} key={node.id} role="treeitem" aria-level={depth + 1} aria-selected={selected === node.id} style={{ ['--outline-depth' as string]: depth }} onClick={() => setSelected(node.id)}>
          <span className="mm-outline-branch" aria-hidden="true">{depth ? '↳' : '•'}</span>
          {node.marker && <span className="mm-outline-marker" title={MARKERS.find((marker) => marker.value === node.marker)?.label}>{MARKERS.find((marker) => marker.value === node.marker)?.glyph}</span>}
          <input aria-label={`編輯${node.text}`} value={editing === node.id ? draft : node.text} onFocus={() => { setSelected(node.id); setEditing(node.id); setDraft(node.text); }} onChange={(event) => setDraft(event.target.value)} onBlur={(event) => {
            if (outlineSkipBlurRef.current === node.id) { outlineSkipBlurRef.current = null; return; }
            if (editing === node.id && tree) { commit(saveOutlineTitle(node.id, event.currentTarget.value)); setEditing(null); }
          }} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.stopPropagation();
            if (event.key === 'Tab') { event.preventDefault(); outlineSkipBlurRef.current = node.id; outlineIndent(node.id, event.shiftKey, event.currentTarget.value); }
            else if (event.key === 'Enter') { event.preventDefault(); outlineSkipBlurRef.current = node.id; outlineAddSibling(node.id, event.currentTarget.value); }
            else if (event.key === 'Escape') { event.preventDefault(); outlineSkipBlurRef.current = node.id; setEditing(null); setDraft(node.text); event.currentTarget.blur(); }
          }} />
          {node.sceneId && <button type="button" className="mm-outline-scene" title={sceneById.get(node.sceneId)?.label ?? '開啟連結場次'} onClick={(event) => { event.stopPropagation(); openScene(node.sceneId); }}>{sceneById.get(node.sceneId)?.label ?? '場次'}</button>}
          {parentId && <button type="button" className="mm-outline-add" title="新增子主題" onClick={(event) => { event.stopPropagation(); addChild(node.id); }}>＋</button>}
        </div>)}
      </div> : <div className="mm-stage">
        <svg ref={svgRef} className="graph-canvas mm-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => { if (!dragRef.current) pan.current = null; }} onClick={(event) => { if (!(event.target as Element).closest('.mm-node')) setSelected(null); }}>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {placed.filter((item) => item.parent).map((item) => {
              const parent = item.parent!;
              const sourceX = layout === 'org' ? parent.x + parent.w / 2 : item.side === 1 ? parent.x + parent.w : parent.x;
              const sourceY = layout === 'org' ? parent.y + parent.h : parent.y + parent.h / 2;
              const endX = layout === 'org' ? item.x + item.w / 2 : item.side === 1 ? item.x : item.x + item.w;
              const endY = layout === 'org' ? item.y : item.depth >= 2 ? item.y + item.h : item.y + item.h / 2;
              const middle = layout === 'org' ? sourceY + (endY - sourceY) / 2 : (sourceX + endX) / 2;
              const d = layout === 'org' ? `M${sourceX},${sourceY} C${sourceX},${middle} ${endX},${middle} ${endX},${endY}` : `M${sourceX},${sourceY} C${middle},${sourceY} ${middle},${endY} ${endX},${endY}${item.depth >= 2 ? ` L${item.side === 1 ? item.x + item.w : item.x},${endY}` : ''}`;
              return <path key={`e-${item.node.id}`} className="mm-edge" d={d} stroke={branchVar(item)} strokeWidth={item.depth === 1 ? 3 : 1.6} />;
            })}
            {placed.map((item) => {
              const isSelected = selected === item.node.id;
              const isMatch = searchMatches.some((match) => match.id === item.node.id);
              const hiddenCount = item.folded ? countDescendants(item.node) : 0;
              const dragged = drag?.id === item.node.id;
              const dropMode = drag?.target?.id === item.node.id ? drag.target.mode : '';
              const marker = MARKERS.find((option) => option.value === item.node.marker);
              const linkedScene = item.node.sceneId ? sceneById.get(item.node.sceneId) : undefined;
              const hasDecoration = !!(marker || item.node.sceneId || item.node.note?.trim());
              const textStart = 8 + (marker ? 18 : 0);
              const editorWidth = Math.max(item.w, Math.min(260, textWidth(draft || item.node.text, levelFont(item.depth)) + 22));
              const editorX = item.side === -1 ? item.w - editorWidth : 0;
              return <g key={item.node.id} className={`mm-node mm-d${Math.min(item.depth, 2)}${item.depth === 0 ? ' mm-root' : ''}${isSelected ? ' selected' : ''}${isMatch ? ' search-match' : ''}${dragged ? ' dragging' : ''}${dropMode ? ` drop-${dropMode}` : ''}`}
                style={{ ['--branch' as string]: branchVar(item), transform: `translate(${item.x + (dragged ? drag.dx : 0)}px, ${item.y + (dragged ? drag.dy : 0)}px)` }}
                onPointerDown={(event) => { if (item.depth === 0 || editing === item.node.id || event.button !== 0) return; dragRef.current = { id: item.node.id, x: event.clientX, y: event.clientY, active: false }; }}
                onClick={(event) => { event.stopPropagation(); setSelected(item.node.id); wrapRef.current?.focus(); }}
                onDoubleClick={(event) => { event.stopPropagation(); if (item.node.id === displayRoot?.id) return; setFocusId(item.node.id); setDepthLimit(Infinity); }}>
                <rect className="mm-box" width={item.w} height={item.h} rx={item.depth === 0 ? item.h / 2 : item.depth === 1 ? 10 : 6} />
                {dropMode && dropMode !== 'child' && <rect className="mm-drop-line" x={0} y={dropMode === 'before' ? -5 : item.h + 3} width={item.w} height={2.5} rx={1.25} />}
                {editing !== item.node.id && <text className="mm-text" x={hasDecoration ? textStart : item.depth >= 2 ? 8 : item.w / 2 - (hiddenCount ? 15 : 0)} y={item.h / 2 - (linkedScene ? 3 : 0)} dominantBaseline="central" textAnchor={hasDecoration || item.depth >= 2 ? 'start' : 'middle'}>{item.node.text}</text>}
                {marker && <text className="mm-marker-glyph" x="8" y={item.h / 2} dominantBaseline="central" aria-label={marker.label}>{marker.glyph}</text>}
                {item.node.note?.trim() && <g className="mm-note-indicator" transform={`translate(${item.w - 12},11)`} aria-label="有備註"><path d="M-4,-6 H2 L5,-3 V6 H-4 Z M2,-6 V-3 H5 M-2,0 H3 M-2,3 H2" /></g>}
                {item.node.sceneId && <g className={`mm-scene-chip${linkedScene ? '' : ' stale'}`} role="button" tabIndex={0} aria-label={linkedScene ? `開啟${linkedScene.label}` : '連結場次不存在'} transform={`translate(${item.w - 39},${item.h - 1})`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); openScene(item.node.sceneId); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openScene(item.node.sceneId); } }}><rect x="-20" y="-10" width="40" height="19" rx="7" /><text dominantBaseline="central">{linkedScene ? linkedScene.label.split('→').at(-1)?.trim() : '失效'}</text></g>}
                {hiddenCount > 0 && <g className="mm-badge" role="button" tabIndex={0} aria-label={`展開 ${hiddenCount} 個隱藏主題`} transform={`translate(${item.w - 22},${item.h / 2})`} onClick={(event) => { event.stopPropagation(); if (item.node.collapsed) toggle(item.node.id); if (depthLimit !== Infinity && item.depth >= depthLimit) setDepthLimit(item.depth + 1); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (item.node.collapsed) toggle(item.node.id); if (depthLimit !== Infinity && item.depth >= depthLimit) setDepthLimit(item.depth + 1); } }}><rect x={-13} y={-9} width={26} height={18} rx={9} /><text dominantBaseline="central">{hiddenCount > 99 ? '99+' : hiddenCount}</text></g>}
                {!item.folded && item.node.children.length > 0 && item.depth > 0 && <g className="mm-fold" role="button" tabIndex={0} aria-label={`收合${item.node.text}`} aria-expanded="true" transform={`translate(${item.side === 1 ? item.w + 8 : -8},${item.depth >= 2 ? item.h : item.h / 2})`} onClick={(event) => { event.stopPropagation(); toggle(item.node.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggle(item.node.id); } }}><circle r="6" /><path d="M-3,0 H3" /></g>}
                {editing === item.node.id && <foreignObject x={editorX} y={0} width={editorWidth} height={item.h}>
                  <input className={`mm-input mm-input-d${Math.min(item.depth, 2)}`} style={{ font: levelFont(item.depth), letterSpacing: item.depth === 0 ? '.06em' : item.depth === 1 ? '.025em' : 'normal', textAlign: item.depth < 2 ? 'center' : 'left' }} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onFocus={(event) => { if (event.currentTarget.value === item.node.text) event.currentTarget.select(); }}
                    onBlur={finishEdit} onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); finishEdit(); }
                      if (event.key === 'Escape') { event.preventDefault(); cancelEdit(item.node.id); }
                      event.stopPropagation();
                    }} />
                </foreignObject>}
              </g>;
            })}
          </g>
        </svg>
        <div className="mm-help" aria-label="操作說明"><span>拖曳：移動／排序　滾輪：縮放</span><span>Tab 子題 · Enter 同級 · F2 編輯</span><span>Alt+↑↓ 排序 · Ctrl+Z/Y 復原</span></div>
        {minimapVisible && <div className="mm-minimap"><div>小地圖</div><svg viewBox={`${worldBounds.minX - 12} ${worldBounds.minY - 12} ${Math.max(1, worldBounds.width + 24)} ${Math.max(1, worldBounds.height + 24)}`} role="button" tabIndex={0} aria-label="小地圖，點擊移動畫面" onPointerDown={(event) => event.stopPropagation()} onClick={minimapClick}>
          {placed.map((item) => <rect key={item.node.id} className={item.depth === 0 ? 'mm-mini-root' : 'mm-mini-node'} x={item.x} y={item.y} width={Math.max(3, item.w)} height={Math.max(3, item.h)} />)}
          <rect className="mm-mini-viewport" x={-view.x / view.k} y={-view.y / view.k} width={canvasSize.width / view.k} height={canvasSize.height / view.k} />
        </svg></div>}
      </div>}
      {inspectorOpen && <aside className="mm-inspector" aria-label="主題檢查器">
        <header><div><small>編劇工作區</small><h3>主題檢查器</h3></div></header>
        {!selectedNode ? <p className="mm-inspector-empty">選取一個主題以編輯標題、備註與場次連結。</p> : <div className="mm-inspector-form">
          <label>標題<input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => saveTitle(selectedNode.id)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveTitle(selectedNode.id); event.currentTarget.blur(); } }} /></label>
          <label>備註<textarea rows={5} value={noteDraft} placeholder="記錄人物動機、場面意象、編劇問題…" onChange={(event) => setNoteDraft(event.target.value)} onBlur={() => saveNote(selectedNode.id)} /></label>
          <label>連結場次<Select value={selectedNode.sceneId ?? ''} options={sceneSelectOptions} onChange={(sceneId) => editNode(selectedNode.id, (node) => ({ ...node, sceneId: sceneId || undefined }))} ariaLabel="連結場次" className="mm-inspector-select" style={{ width: '100%' }} collapsibleGroups preview={(option) => option.value ? <ScenePreview project={project} sceneId={option.value} /> : null} /></label>
          <button type="button" className="mm-open-scene" disabled={!selectedNode.sceneId || !sceneById.has(selectedNode.sceneId) || !onOpenScene} title={!selectedNode.sceneId ? '先連結一場劇本場次' : !sceneById.has(selectedNode.sceneId) ? '連結場次已不存在' : !onOpenScene ? '尚未接上劇本跳轉功能' : '跳至此場劇本'} onClick={() => openScene(selectedNode.sceneId)}>開啟此場</button>
          <label>標記<Select value={selectedNode.marker ?? ''} options={[{ value: '', label: '無標記' }, ...MARKERS.map((marker) => ({ value: marker.value, label: `${marker.glyph}　${marker.label}` }))]} onChange={(value) => editNode(selectedNode.id, (node) => ({ ...node, marker: (value || undefined) as MindMapMarker | undefined }))} ariaLabel="標記" className="mm-inspector-select" style={{ width: '100%' }} /></label>
          <fieldset className="mm-color-field"><legend>分支顏色</legend><div className="mm-color-swatches">{Array.from({ length: BRANCHES }, (_, index) => <button type="button" key={index} className={`mm-swatch${colorIndex === index ? ' active' : ''}`} style={{ ['--swatch' as string]: `var(--mm-${index})` }} aria-label={`分支色 ${index + 1}`} aria-pressed={colorIndex === index} disabled={!selectedBranch} title={selectedBranch ? `將整個分支設為色彩 ${index + 1}` : '中心主題不使用分支色彩'} onClick={() => selected && setBranchColor(selected, index)} />)}</div><small>子主題會沿用上層分支色彩。</small></fieldset>
          <p className="mm-inspector-hint">場次標籤可直接跳回劇本；備註與標記會隨專案儲存。</p>
        </div>}
      </aside>}
    </div>
  </div>;
}
