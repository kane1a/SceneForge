import type { PageStart } from './api';
import type { Block, BlockType } from './types';

/**
 * Page breaks estimated from the editor's own line wrapping, for when the print-layout
 * engine is not available (the browser demo). Uses the same spacing, keep-with-next and
 * page geometry rules as server/pdf-layout.mjs, but not its dialogue splitting, so it can
 * be off by a line or two near a break.
 */
const BEFORE: Record<Exclude<BlockType, 'note'>, number> = { scene: 2, action: 1, character: 1, parenthetical: 0, dialogue: 0, transition: 1, shot: 1, act: 2, message: 1, titlecard: 1 };
const PT = 72;
const PAPERS = { letter: { height: 11 * PT, top: PT, bottom: PT }, a4: { height: 841.89, top: 25 / 25.4 * PT, bottom: 25 / 25.4 * PT } };

export interface PageEstimate { pageStarts: PageStart[]; sceneEighths: Record<string, number>; pages: number }

export function estimatePages(blocks: Block[], lineCount: (block: Block) => number, format: { paper: 'letter' | 'a4'; fontPt: number; lineSpacing: number; paragraphSpacing: number }): PageEstimate {
  const paper = PAPERS[format.paper === 'a4' ? 'a4' : 'letter'];
  const size = Math.min(16, Math.max(9, format.fontPt || 12));
  const lineHeight = size * Math.max(1, format.lineSpacing || 1);
  const gap = Math.max(0, format.paragraphSpacing ?? 1);
  const perPage = Math.floor((paper.height - paper.top - paper.bottom - lineHeight) / lineHeight);
  const items: { block: Block; lines: number; before: number; sceneId: string }[] = [];
  let sceneId = '';
  for (const block of blocks) {
    if (block.type === 'note' || !block.text.trim()) continue;
    if (block.type === 'scene') sceneId = block.id;
    items.push({ block, lines: Math.max(1, lineCount(block)), before: Math.round(BEFORE[block.type] * gap), sceneId });
  }
  const pageStarts: PageStart[] = [];
  const sceneLines: Record<string, number> = {};
  let page = 1;
  let used = 0;
  items.forEach((item, index) => {
    const next = items[index + 1];
    const keep = item.block.type === 'scene' || item.block.type === 'act' ? Math.min(2, next?.lines ?? 0) + (next?.before ?? 0)
      : item.block.type === 'character' || item.block.type === 'parenthetical' ? Math.min(1, next?.lines ?? 0) : 0;
    const before = used === 0 ? 0 : item.before;
    if (used > 0 && used + before + item.lines + keep > perPage) {
      page += 1;
      used = 0;
      pageStarts.push({ blockId: item.block.id, page, continued: false });
    } else used += before;
    let remaining = item.lines;
    while (remaining > 0) {
      const room = perPage - used;
      const take = Math.min(room, remaining);
      used += take;
      remaining -= take;
      if (remaining > 0) { page += 1; used = 0; pageStarts.push({ blockId: item.block.id, page, continued: true }); }
    }
    if (item.sceneId) sceneLines[item.sceneId] = (sceneLines[item.sceneId] ?? 0) + item.lines + before;
  });
  const sceneEighths: Record<string, number> = {};
  for (const [id, lines] of Object.entries(sceneLines)) sceneEighths[id] = Math.max(1, Math.round(lines / perPage * 8));
  return { pageStarts, sceneEighths, pages: page };
}

/** Visual line count of a paragraph's textarea in the editor. */
export function editorLineCount(block: Block): number {
  const el = document.getElementById(`editor-${block.id}`) as HTMLTextAreaElement | null;
  if (!el) return Math.max(1, block.text.split('\n').length);
  const style = getComputedStyle(el);
  const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
  const inner = el.scrollHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
  return Math.max(1, Math.round(inner / lh));
}
