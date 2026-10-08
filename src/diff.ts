import type { Block, Project } from './types';

export type ChangeKind = 'added' | 'removed' | 'changed' | 'retyped';
export interface BlockChange { kind: ChangeKind; before?: Block; after?: Block; scene: string }
export interface DiffSegment { text: string; op: 'same' | 'ins' | 'del' }

/** Paragraph-level comparison. Block ids survive edits, so matching by id is exact. */
export function diffProjects(older: Project, newer: Project): BlockChange[] {
  const oldById = new Map(older.blocks.map((block) => [block.id, block]));
  const newIds = new Set(newer.blocks.map((block) => block.id));
  const changes: BlockChange[] = [];
  let scene = '開場';
  for (const block of newer.blocks) {
    if (block.type === 'scene') scene = block.text || '未命名場景';
    const before = oldById.get(block.id);
    if (!before) { if (block.text.trim()) changes.push({ kind: 'added', after: block, scene }); continue; }
    if (before.text !== block.text) changes.push({ kind: 'changed', before, after: block, scene });
    else if (before.type !== block.type) changes.push({ kind: 'retyped', before, after: block, scene });
  }
  scene = '開場';
  for (const block of older.blocks) {
    if (block.type === 'scene') scene = block.text || '未命名場景';
    if (!newIds.has(block.id) && block.text.trim()) changes.push({ kind: 'removed', before: block, scene });
  }
  return changes;
}

/** Blocks that differ from the baseline — these carry revision marks (*). */
export function revisedBlockIds(baseline: Project, current: Project): string[] {
  const oldById = new Map(baseline.blocks.map((block) => [block.id, block]));
  return current.blocks.filter((block) => { const before = oldById.get(block.id); return !before ? block.text.trim() !== '' : before.text !== block.text || before.type !== block.type; }).map((block) => block.id);
}

/** Character-level diff (LCS). Falls back to whole replacement for very long paragraphs. */
export function charDiff(a: string, b: string): DiffSegment[] {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length * y.length > 2_000_000) return [{ text: a, op: 'del' }, { text: b, op: 'ins' }];
  const rows = x.length + 1;
  const cols = y.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = x[i] === y[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const out: DiffSegment[] = [];
  const push = (text: string, op: DiffSegment['op']) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text; else out.push({ text, op });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { push(x[i], 'same'); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { push(x[i], 'del'); i += 1; }
    else { push(y[j], 'ins'); j += 1; }
  }
  while (i < x.length) push(x[i++], 'del');
  while (j < y.length) push(y[j++], 'ins');
  return out;
}
