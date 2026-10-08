import type { Block, Project, ProjectKind, SceneMeta } from './types';

const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export type TemplateId = 'blank' | 'film' | 'series' | 'short';

export const TEMPLATES: { id: TemplateId; name: string; hint: string }[] = [
  { id: 'film', name: '電影', hint: '首幕與一個空白場景；幕標題預設隱藏' },
  { id: 'series', name: '影集', hint: '第一集與一個空白場景；未預填集大綱' },
  { id: 'short', name: '微短劇', hint: '第一集與一個空白場景；含每集大綱提示（目標 1–3 分鐘）' },
  { id: 'blank', name: '空白', hint: '只有一個空白場景' },
];

export const KIND_LABELS: Record<ProjectKind, string> = { film: '電影', series: '影集', short: '微短劇' };

/** What an act block is called for this kind of project: 幕 for film, 集 for episodic work. */
export const unitName = (kind?: ProjectKind) => kind === 'series' || kind === 'short' ? '集' : '幕';

/** Target length per episode, in minutes, used to flag episodes that run long. */
export const EPISODE_TARGET: Partial<Record<ProjectKind, [number, number]>> = { short: [1, 3], series: [40, 60] };

export function templateContent(template: TemplateId): Pick<Project, 'blocks' | 'kind' | 'sceneMeta'> {
  const blocks: Block[] = [];
  const sceneMeta: Record<string, SceneMeta> = {};
  const block = (type: Block['type'], text = '') => { const item = { id: newId(), type, text }; blocks.push(item); return item; };
  // Start with the first act / episode only; the writer adds the next one when they get there.
  if (template === 'film') {
    const act = block('act', '第一幕');
    sceneMeta[act.id] = { summary: '' };
    block('scene');
    return { blocks, kind: 'film', sceneMeta };
  }
  if (template === 'series' || template === 'short') {
    const act = block('act', '第1集');
    sceneMeta[act.id] = { summary: template === 'short' ? '開場 3 秒內抛出衝突；結尾留一個懸念，讓觀眾滑到下一集。' : '' };
    block('scene');
    return { blocks, kind: template, sceneMeta };
  }
  block('scene');
  return { blocks, kind: 'film', sceneMeta };
}
