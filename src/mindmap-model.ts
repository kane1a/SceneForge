import type { MindNode } from './types';

export type MindMapLayout = 'both' | 'right' | 'org';
export type MindMapDropMode = 'before' | 'after' | 'child';
export interface MindMapSize { w: number; h: number }
export interface PlacedMindNode {
  node: MindNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  side: 1 | -1;
  branch: number;
  parent?: PlacedMindNode;
  folded?: boolean;
}
export type MindMapSizeOf = (node: MindNode, depth: number, folded: boolean) => MindMapSize;

const V_GAP = 14;
const H_GAP = 64;
const BRANCH_COUNT = 8;
const defaultSize: MindMapSizeOf = (node, depth) => ({
  w: Math.min(depth === 0 ? 360 : 280, Math.max(24, Array.from(node.text || '　').length * (depth === 0 ? 13 : 9)) + (depth === 0 ? 52 : depth === 1 ? 36 : 16)),
  h: depth === 0 ? 58 : depth === 1 ? 40 : 34,
});

/** Pure layout calculation; screen pan/zoom never enters this function. */
export function layoutMindMap(root: MindNode, layout: MindMapLayout = 'both', sizeOf: MindMapSizeOf = defaultSize, depthLimit = Infinity): PlacedMindNode[] {
  const placed: PlacedMindNode[] = [];
  const heightOf = new Map<string, number>();
  const folded = (node: MindNode, depth: number) => depth > 0 && node.children.length > 0 && (node.collapsed === true || depth >= depthLimit);
  const shownChildren = (node: MindNode, depth: number) => folded(node, depth) ? [] : node.children;
  const measure = (node: MindNode, depth: number): number => {
    const kids = shownChildren(node, depth);
    const size = sizeOf(node, depth, kids.length === 0 && node.children.length > 0);
    const total = kids.reduce((sum, child) => sum + measure(child, depth + 1), 0) + Math.max(0, kids.length - 1) * (depth === 0 ? V_GAP * 2 : V_GAP);
    const h = Math.max(size.h, total);
    heightOf.set(node.id, h);
    return h;
  };
  measure(root, 0);
  const rootSize = sizeOf(root, 0, false);

  if (layout === 'org') {
    const subtreeWidth = (node: MindNode, depth: number): number => {
      const kids = shownChildren(node, depth);
      if (!kids.length) return sizeOf(node, depth, node.children.length > 0).w;
      return Math.max(sizeOf(node, depth, false).w, kids.reduce((sum, child) => sum + subtreeWidth(child, depth + 1), 0) + Math.max(0, kids.length - 1) * H_GAP);
    };
    const rootItem: PlacedMindNode = { node: root, x: -rootSize.w / 2, y: 0, w: rootSize.w, h: rootSize.h, depth: 0, side: 1, branch: -1 };
    placed.push(rootItem);
    const place = (node: MindNode, depth: number, centerX: number, y: number, parent: PlacedMindNode, branch: number) => {
      const kids = shownChildren(node, depth);
      const size = sizeOf(node, depth, !kids.length && node.children.length > 0);
      const item: PlacedMindNode = { node, x: centerX - size.w / 2, y, w: size.w, h: size.h, depth, side: 1, branch, parent, folded: !kids.length && node.children.length > 0 };
      placed.push(item);
      if (!kids.length) return;
      const totalWidth = kids.reduce((sum, child) => sum + subtreeWidth(child, depth + 1), 0) + Math.max(0, kids.length - 1) * H_GAP;
      let cursor = centerX - totalWidth / 2;
      for (const child of kids) {
        const childWidth = subtreeWidth(child, depth + 1);
        const childBranch = depth === 0 ? (child.color === undefined ? Math.max(0, root.children.indexOf(child)) % BRANCH_COUNT : Math.max(0, child.color) % BRANCH_COUNT) : branch;
        place(child, depth + 1, cursor + childWidth / 2, y + size.h + H_GAP, item, childBranch);
        cursor += childWidth + H_GAP;
      }
    };
    const rootKids = shownChildren(root, 0);
    const totalWidth = rootKids.reduce((sum, child) => sum + subtreeWidth(child, 1), 0) + Math.max(0, rootKids.length - 1) * H_GAP;
    let cursor = -totalWidth / 2;
    rootKids.forEach((child, index) => {
      const childWidth = subtreeWidth(child, 1);
      const branch = child.color === undefined ? index % BRANCH_COUNT : Math.max(0, child.color) % BRANCH_COUNT;
      place(child, 1, cursor + childWidth / 2, rootSize.h + H_GAP, rootItem, branch);
      cursor += childWidth + H_GAP;
    });
    return placed;
  }

  const rootItem: PlacedMindNode = { node: root, x: -rootSize.w / 2, y: -rootSize.h / 2, w: rootSize.w, h: rootSize.h, depth: 0, side: 1, branch: -1 };
  placed.push(rootItem);
  const rootKids = shownChildren(root, 0);
  const place = (node: MindNode, depth: number, side: 1 | -1, top: number, parent: PlacedMindNode, branch: number) => {
    const size = sizeOf(node, depth, shownChildren(node, depth).length === 0 && node.children.length > 0);
    const kids = shownChildren(node, depth);
    const height = heightOf.get(node.id) ?? size.h;
    const x = layout === 'both' && side === -1 ? parent.x - H_GAP - size.w : parent.x + parent.w + H_GAP;
    const item: PlacedMindNode = { node, x, y: top + height / 2 - size.h / 2, w: size.w, h: size.h, depth, side, branch, parent, folded: !kids.length && node.children.length > 0 };
    placed.push(item);
    let cursor = top + (height - (kids.reduce((sum, child) => sum + (heightOf.get(child.id) ?? 0), 0) + Math.max(0, kids.length - 1) * V_GAP)) / 2;
    for (const child of kids) {
      place(child, depth + 1, side, cursor, item, branch);
      cursor += (heightOf.get(child.id) ?? 0) + V_GAP;
    }
  };
  if (layout === 'right') {
    const totalHeight = rootKids.reduce((sum, child) => sum + (heightOf.get(child.id) ?? 0), 0) + Math.max(0, rootKids.length - 1) * V_GAP * 2;
    let cursor = -totalHeight / 2;
    rootKids.forEach((child, index) => {
      const branch = child.color === undefined ? index % BRANCH_COUNT : Math.max(0, child.color) % BRANCH_COUNT;
      place(child, 1, 1, cursor, rootItem, branch);
      cursor += (heightOf.get(child.id) ?? 0) + V_GAP * 2;
    });
  } else {
    const right: MindNode[] = [];
    const left: MindNode[] = [];
    const totalHeight = rootKids.reduce((sum, child) => sum + (heightOf.get(child.id) ?? 0) + V_GAP, 0);
    let accumulated = 0;
    rootKids.forEach((child) => {
      if (child.side === 'left') left.push(child);
      else if (child.side === 'right') right.push(child);
      else (accumulated < totalHeight / 2 || rootKids.length < 3 ? right : left).push(child);
      accumulated += (heightOf.get(child.id) ?? 0) + V_GAP;
    });
    for (const [side, list] of [[1, right], [-1, left]] as const) {
      const total = list.reduce((sum, child) => sum + (heightOf.get(child.id) ?? 0), 0) + Math.max(0, list.length - 1) * V_GAP * 2;
      let cursor = -total / 2;
      for (const child of list) {
        const index = rootKids.indexOf(child);
        const branch = child.color === undefined ? index % BRANCH_COUNT : Math.max(0, child.color) % BRANCH_COUNT;
        place(child, 1, side, cursor, rootItem, branch);
        cursor += (heightOf.get(child.id) ?? 0) + V_GAP * 2;
      }
    }
  }
  return placed;
}

export function findMindMapNode(root: MindNode, id: string): MindNode | null {
  if (root.id === id) return root;
  for (const child of root.children) { const found = findMindMapNode(child, id); if (found) return found; }
  return null;
}

export function findMindMapParent(root: MindNode, id: string): MindNode | null {
  for (const child of root.children) {
    if (child.id === id) return root;
    const found = findMindMapParent(child, id);
    if (found) return found;
  }
  return null;
}

function containsId(node: MindNode, id: string): boolean { return node.children.some((child) => child.id === id || containsId(child, id)); }
function updateNode(root: MindNode, id: string, change: (node: MindNode) => MindNode | null): MindNode {
  const visit = (node: MindNode): MindNode | null => {
    if (node.id === id) return change(node);
    const children = node.children.map(visit).filter((child): child is MindNode => child !== null);
    return children.length === node.children.length && children.every((child, index) => child === node.children[index]) ? node : { ...node, children };
  };
  return visit(root) ?? root;
}

export function moveMindMapNode(root: MindNode, id: string, targetId: string, mode: MindMapDropMode): MindNode {
  if (id === root.id || id === targetId) return root;
  const moving = findMindMapNode(root, id);
  if (!moving || containsId(moving, targetId)) return root;
  const without = updateNode(root, id, () => null);
  if (mode === 'child' || targetId === root.id) {
    if (!findMindMapNode(without, targetId)) return root;
    return updateNode(without, targetId, (node) => ({ ...node, collapsed: false, children: [...node.children, moving] }));
  }
  const parent = findMindMapParent(without, targetId);
  if (!parent) return root;
  return updateNode(without, parent.id, (node) => {
    const index = node.children.findIndex((child) => child.id === targetId);
    if (index < 0) return node;
    const insertAt = index + (mode === 'after' ? 1 : 0);
    const item = parent.id === root.id ? { ...moving, side: node.children[index].side ?? moving.side } : moving;
    const children = [...node.children];
    children.splice(insertAt, 0, item);
    return { ...node, children };
  });
}

export function reorderMindMapSibling(root: MindNode, id: string, delta: number): MindNode {
  const parent = findMindMapParent(root, id);
  if (!parent || !Number.isInteger(delta) || delta === 0) return root;
  const from = parent.children.findIndex((child) => child.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= parent.children.length) return root;
  return updateNode(root, parent.id, (node) => {
    const children = [...node.children];
    const [moving] = children.splice(from, 1);
    children.splice(to, 0, moving);
    return { ...node, children };
  });
}

export class MindMapHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private readonly limit = 100) {}
  push(snapshot: T): void {
    this.past.push(snapshot);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.future = [];
  }
  undo(current: T): T | undefined {
    const snapshot = this.past.pop();
    if (snapshot === undefined) return undefined;
    this.future.push(current);
    return snapshot;
  }
  redo(current: T): T | undefined {
    const snapshot = this.future.pop();
    if (snapshot === undefined) return undefined;
    this.past.push(current);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    return snapshot;
  }
  clear(): void { this.past = []; this.future = []; }
}

export function cloneMindMapSubtree(root: MindNode, makeId: () => string): MindNode {
  return { ...root, id: makeId(), generated: false, edited: undefined, children: root.children.map((child) => cloneMindMapSubtree(child, makeId)) };
}
export function pasteMindMapSubtree(root: MindNode, targetId: string, source: MindNode, makeId: () => string): MindNode {
  const copy = cloneMindMapSubtree(source, makeId);
  if (!findMindMapNode(root, targetId)) return root;
  return updateNode(root, targetId, (node) => ({ ...node, collapsed: false, children: [...node.children, copy] }));
}
export function duplicateMindMapNode(root: MindNode, id: string, makeId: () => string): MindNode {
  if (id === root.id) return root;
  const parent = findMindMapParent(root, id);
  const source = findMindMapNode(root, id);
  if (!parent || !source) return root;
  const copy = cloneMindMapSubtree(source, makeId);
  return updateNode(root, parent.id, (node) => {
    const index = node.children.findIndex((child) => child.id === id);
    const children = [...node.children];
    children.splice(index + 1, 0, copy);
    return { ...node, children };
  });
}

function nodeKey(node: MindNode): string { return node.sceneId ? `scene:${node.sceneId}` : `id:${node.id}`; }
function hasWriterData(node: MindNode): boolean {
  if (node.note?.trim() || node.marker || node.color !== undefined || node.side || node.edited) return true;
  return node.children.some((child) => child.generated !== true || hasWriterData(child));
}
function preserveOrphan(node: MindNode): MindNode {
  return { ...node, generated: false, edited: undefined, children: node.children.map(preserveOrphan) };
}
function mergeGeneratedNode(previous: MindNode, fresh: MindNode): MindNode {
  const oldGenerated = previous.children.filter((child) => child.generated === true);
  const manual = previous.children.filter((child) => child.generated !== true);
  const used = new Set<MindNode>();
  const generated = fresh.children.map((child, index) => {
    const match = oldGenerated.find((old) => !used.has(old) && (nodeKey(old) === nodeKey(child) || old.text === child.text)) ?? oldGenerated[index];
    if (!match || used.has(match)) return child;
    used.add(match);
    return mergeGeneratedNode(match, child);
  });
  const orphaned = oldGenerated.filter((child) => !used.has(child) && hasWriterData(child)).map(preserveOrphan);
  return { ...fresh, id: previous.id, note: previous.note ?? fresh.note, marker: previous.marker ?? fresh.marker, color: previous.color ?? fresh.color, side: previous.side ?? fresh.side, collapsed: previous.collapsed ?? fresh.collapsed, children: [...generated, ...manual, ...orphaned] };
}
export function mergeRegeneratedMindMap(current: MindNode, generated: MindNode): MindNode {
  const currentGenerated = current.children.filter((child) => child.generated === true);
  const userBranches = current.children.filter((child) => child.generated !== true);
  const used = new Set<MindNode>();
  const refreshed = generated.children.map((fresh) => {
    const previous = currentGenerated.find((old) => !used.has(old) && old.text === fresh.text);
    if (!previous) return fresh;
    used.add(previous);
    return mergeGeneratedNode(previous, fresh);
  });
  const orphaned = currentGenerated.filter((child) => !used.has(child) && hasWriterData(child)).map(preserveOrphan);
  return { ...generated, id: current.id, note: current.note ?? generated.note, marker: current.marker ?? generated.marker, color: current.color ?? generated.color, side: current.side ?? generated.side, children: [...refreshed, ...userBranches, ...orphaned] };
}
export function markLegacyGeneratedNodes(current: MindNode, fresh: MindNode): MindNode {
  const identity = (node: MindNode) => node.text.replace(/（\d+\s*句）$/u, '').replace(/\s+/g, ' ').trim();
  const visit = (node: MindNode, source: MindNode | undefined): MindNode => {
    if (!source || node.generated === false) return node;
    const generated = node.generated === true || (node.generated === undefined && (node.sceneId && source.sceneId ? node.sceneId === source.sceneId : identity(node) === identity(source)));
    if (!generated) return node;
    const editedContent = !!node.note?.trim() || node.marker !== undefined || node.color !== undefined || node.side !== undefined || (!!node.sceneId && !!source.sceneId && node.sceneId === source.sceneId && node.text !== source.text);
    const used = new Set<MindNode>();
    const children = node.children.map((child) => {
      const match = source.children.find((candidate) => !used.has(candidate) && (child.sceneId && candidate.sceneId ? child.sceneId === candidate.sceneId : identity(child) === identity(candidate)));
      if (match) used.add(match);
      return visit(child, match);
    });
    return { ...node, generated: true, ...(editedContent ? { edited: true } : {}), children };
  };
  return visit(current, fresh);
}

export function hasEditedGeneratedNodes(root: MindNode): boolean {
  const editedHere = root.edited === true || !!root.note?.trim() || root.marker !== undefined || root.color !== undefined || root.side !== undefined;
  if (root.generated === true && editedHere) return true;
  return root.children.some(hasEditedGeneratedNodes);
}

const markerLabels: Record<string, string> = { todo: '待辦', done: '完成', important: '重要', question: '疑問', foreshadow: '伏筆', turn: '轉折' };
function quoteNote(note: string, indent: string): string { return note.split(/\r?\n/).map((line) => `${indent}> ${line}`).join('\n'); }
export function mindMapToMarkdown(root: MindNode): string {
  const lines = [`# ${root.text.replace(/\r?\n/g, ' ').trim() || '未命名心智圖'}`];
  if (root.note?.trim()) lines.push('', quoteNote(root.note.trim(), ''));
  const visit = (node: MindNode, depth: number) => {
    const indent = '  '.repeat(depth);
    const marker = node.marker && markerLabels[node.marker] ? `［${markerLabels[node.marker]}］` : '';
    lines.push(`${indent}- ${marker}${node.text.replace(/\r?\n/g, ' ').trim()}`);
    if (node.note?.trim()) lines.push(quoteNote(node.note.trim(), `${indent}  `));
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const child of root.children) visit(child, 0);
  return `${lines.join('\n')}\n`;
}

export interface MindMapToolbarItem { id: string; width: number; priority: number }

/** Greedily reserve the More trigger, keeping the most useful toolbar controls visible first. */
export function fitMindMapToolbar(items: MindMapToolbarItem[], availableWidth: number, moreWidth: number, gap = 5): { visible: string[]; overflow: string[] } {
  const selected = new Set<string>();
  const priorities = [...items].sort((a, b) => b.priority - a.priority || a.width - b.width);
  let used = Math.max(0, moreWidth);
  for (const item of priorities) {
    const nextGap = selected.size ? Math.max(0, gap) : Math.max(0, gap);
    if (used + nextGap + Math.max(0, item.width) <= availableWidth) {
      selected.add(item.id);
      used += nextGap + Math.max(0, item.width);
    }
  }
  return {
    visible: items.filter((item) => selected.has(item.id)).map((item) => item.id),
    overflow: items.filter((item) => !selected.has(item.id)).map((item) => item.id),
  };
}

export type MindMapToggleKey = 'outline' | 'inspector' | 'minimap';

/** Read a persisted mind-map toggle, falling back safely if storage is unavailable. */
export function readMindMapTogglePreference(
  storage: Pick<Storage, 'getItem'> | null,
  key: MindMapToggleKey,
  fallback: boolean,
): boolean {
  try {
    const value = storage?.getItem(`sceneforge-mindmap-${key}`);
    return value === null || value === undefined ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

/** Persist a mind-map toggle without allowing storage errors to break the view. */
export function writeMindMapTogglePreference(
  storage: Pick<Storage, 'setItem'> | null,
  key: MindMapToggleKey,
  value: boolean,
): void {
  try {
    storage?.setItem(`sceneforge-mindmap-${key}`, String(value));
  } catch {
    // Preferences are best-effort when browser storage is blocked or full.
  }
}
