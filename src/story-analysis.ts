import { autoTiers, resolveTier } from './character-tier';
import { speakerKey } from './smart-import';
import type { MindNode, Project, Relation } from './types';

export interface SceneInfo { id: string; index: number; title: string; speakers: string[]; present: string[] }
export interface CharacterInfo { name: string; lines: number; words: number; scenes: number[]; firstScene: number; entityId?: string; description?: string; aliases: string[] }
export interface CoLink { a: string; b: string; weight: number }
export interface StoryAnalysis { scenes: SceneInfo[]; characters: CharacterInfo[]; links: CoLink[] }

const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

/** A single canonical name for every declared character name and alias. */
export function buildCharacterAliasMap(project: Pick<Project, 'entities'>): Map<string, string> {
  const aliasTo = new Map<string, string>();
  for (const entity of project.entities) {
    const name = speakerKey(entity.name.trim());
    if (!name) continue;
    aliasTo.set(name, name);
    for (const alias of entity.aliases) {
      const key = speakerKey(alias);
      if (key) aliasTo.set(key, name);
    }
  }
  return aliasTo;
}

/** Structured script → cast, scene presence and co-appearance. No guessing: speakers come from character blocks, presence from exact name/alias mentions. */
export function analyzeStory(project: Project): StoryAnalysis {
  const aliasTo = buildCharacterAliasMap(project);
  const canonical = (raw: string) => { const key = speakerKey(raw); return aliasTo.get(key) ?? key; };

  const scenes: SceneInfo[] = [];
  let current: SceneInfo | null = null;
  const sceneText = new Map<SceneInfo, string[]>();
  const stats = new Map<string, CharacterInfo>();
  const ensure = (name: string) => {
    let info = stats.get(name);
    if (!info) { info = { name, lines: 0, words: 0, scenes: [], firstScene: Number.POSITIVE_INFINITY, aliases: [] }; stats.set(name, info); }
    return info;
  };
  let speaker = '';
  for (const block of project.blocks) {
    if (!current && block.type !== 'scene' && (block.type === 'act' || block.type === 'note' || block.type === 'transition' || !block.text.trim())) continue;
    if (block.type === 'scene' || !current) {
      current = { id: block.id, index: scenes.length, title: block.type === 'scene' ? (block.text.trim() || '未命名場景') : '開場', speakers: [], present: [] };
      scenes.push(current);
      sceneText.set(current, []);
      if (block.type === 'scene') continue;
    }
    if (block.type === 'character') {
      speaker = canonical(block.text);
      if (speaker && !current.speakers.includes(speaker)) current.speakers.push(speaker);
      if (speaker) ensure(speaker);
    } else if (block.type === 'dialogue' && speaker) {
      const info = ensure(speaker);
      info.lines += 1;
      info.words += Array.from(block.text.replace(/\s/g, '')).length;
    } else if (block.type !== 'parenthetical') {
      speaker = '';
    }
    if (block.type === 'action' || block.type === 'dialogue' || block.type === 'shot') sceneText.get(current)!.push(block.text);
  }

  const names = new Set<string>([...stats.keys(), ...aliasTo.values()]);
  const mentionKeys = [...aliasTo.keys(), ...stats.keys()].filter((key) => Array.from(key).length >= 2 || /^[A-Z]/.test(key));
  for (const scene of scenes) {
    const present = new Set(scene.speakers);
    const body = sceneText.get(scene)!.join('\n');
    for (const key of mentionKeys) if (body.includes(key)) present.add(aliasTo.get(key) ?? key);
    scene.present = [...present].filter((name) => names.has(name));
    for (const name of scene.present) {
      const info = ensure(name);
      if (!info.scenes.includes(scene.index)) info.scenes.push(scene.index);
      info.firstScene = Math.min(info.firstScene, scene.index);
    }
  }
  for (const entity of project.entities) {
    const info = stats.get(entity.name.trim());
    if (info) { info.entityId = entity.id; info.description = entity.description; info.aliases = entity.aliases; }
  }
  const relationNames = new Set((project.relations ?? []).flatMap((relation) => [canonical(relation.from), canonical(relation.to)]));
  const characters = [...stats.values()]
    .filter((info) => info.lines > 0 || info.scenes.length > 0 || relationNames.has(info.name) || project.entities.some((entity) => entity.name === info.name && entity.description))
    .sort((a, b) => b.lines - a.lines || b.scenes.length - a.scenes.length || a.firstScene - b.firstScene);
  for (const name of relationNames) if (!characters.some((info) => info.name === name)) characters.push({ name, lines: 0, words: 0, scenes: [], firstScene: Number.POSITIVE_INFINITY, aliases: [] });

  const pair = new Map<string, CoLink>();
  for (const scene of scenes) {
    const cast = scene.present.filter((name) => characters.some((info) => info.name === name)).sort();
    for (let i = 0; i < cast.length; i += 1) for (let j = i + 1; j < cast.length; j += 1) {
      const key = `${cast[i]}\u0000${cast[j]}`;
      const link = pair.get(key) ?? { a: cast[i], b: cast[j], weight: 0 };
      link.weight += 1;
      pair.set(key, link);
    }
  }
  return { scenes, characters, links: [...pair.values()] };
}

export const RELATION_LABELS: Record<Relation['type'], string> = {
  family: '家人', love: '戀人', friend: '朋友', ally: '同盟', mentor: '師徒', work: '同事', rival: '競爭', enemy: '敵對', other: '其他',
};

/** Build a first-draft mind map from what the script already knows. */
/**
 * Keep hand-kept mind map character nodes in step with identity merges: a node reading
 * 「男孩」 or 「男孩（21 句）」 becomes the canonical name with the merged line count, and
 * duplicate siblings that now point at the same person are folded together.
 */
export function syncMindMapIdentities(project: Project): Project {
  if (!project.mindmap) return project;
  const aliasTo = buildCharacterAliasMap(project);
  const lines = new Map(analyzeStory(project).characters.map((info) => [info.name, info.lines] as const));
  const resolve = (text: string): { name: string; counted: boolean } | null => {
    const match = /^(.+?)（\d+ 句）$/u.exec(text.trim());
    const raw = (match ? match[1] : text).trim();
    const key = speakerKey(raw);
    const canonical = aliasTo.get(key) ?? (lines.has(raw) ? raw : undefined);
    return canonical ? { name: canonical, counted: Boolean(match) } : null;
  };
  let changed = false;
  const walk = (node: MindNode): MindNode => {
    const kids: MindNode[] = [];
    const seen = new Map<string, number>();
    for (const child of node.children.map(walk)) {
      const hit = resolve(child.text);
      if (!hit) { kids.push(child); continue; }
      const text = hit.counted && lines.get(hit.name) ? `${hit.name}（${lines.get(hit.name)} 句）` : hit.name;
      if (text !== child.text) changed = true;
      const at = seen.get(hit.name);
      if (at !== undefined) { changed = true; kids[at] = { ...kids[at], children: [...kids[at].children, ...child.children] }; continue; }
      seen.set(hit.name, kids.length);
      kids.push({ ...child, text });
    }
    return { ...node, children: kids };
  };
  const mindmap = walk(project.mindmap);
  return changed ? { ...project, mindmap } : project;
}

export function mindmapFromProject(project: Project): MindNode {
  const analysis = analyzeStory(project);
  const aliasTo = buildCharacterAliasMap(project);
  const node = (text: string, children: MindNode[] = []): MindNode => ({ id: newId(), text, children, generated: true });
  const branches: MindNode[] = [];

  const acts: MindNode[] = [];
  let bucket: MindNode | null = null;
  // Scenes carry no children here: the cast lives in its own branch, so a long act stays one level deep.
  const sceneNodes = new Map(analysis.scenes.map((scene) => [scene.id, { ...node(`${scene.index + 1}. ${scene.title}`), sceneId: scene.id }]));
  for (const block of project.blocks) {
    if (block.type === 'act') { bucket = node(block.text.trim() || '幕'); acts.push(bucket); }
    const scene = sceneNodes.get(block.id);
    if (scene) (bucket ?? (acts[0] ??= node('故事開始'))).children.push(scene);
  }
  const structure = acts.length > 1 || (acts.length === 1 && acts[0].text !== '故事開始') ? acts : acts[0]?.children ?? [];
  // Long acts get a sequence level (≤ 8 scenes each) so no node fans out into dozens of children.
  const chunk = (act: MindNode): MindNode => {
    if (act.children.length <= 10) return act;
    const groups: MindNode[] = [];
    for (let start = 0; start < act.children.length; start += 8) {
      const slice = act.children.slice(start, start + 8);
      const first = slice[0].text.split('.')[0];
      const last = slice[slice.length - 1].text.split('.')[0];
      groups.push({ ...node(`第 ${first}–${last} 場`), children: slice, collapsed: true });
    }
    return { ...act, children: groups };
  };
  const totalScenes = analysis.scenes.length;
  const shaped = structure.map((item) => item.children.length ? chunk(item) : item);
  if (shaped.length) branches.push({ ...node('結構'), children: shaped.map((item) => ({ ...item, collapsed: totalScenes > 16 && item.children.length > 0 })) });

  const relationSet = new Map<string, Relation>();
  for (const relation of project.relations ?? []) {
    const from = aliasTo.get(speakerKey(relation.from)) ?? speakerKey(relation.from);
    const to = aliasTo.get(speakerKey(relation.to)) ?? speakerKey(relation.to);
    if (!from || !to || from === to) continue;
    const key = JSON.stringify([from, to, relation.type, relation.label ?? '', relation.sinceScene ?? '']);
    if (!relationSet.has(key)) relationSet.set(key, { ...relation, from, to });
  }
  const relations = [...relationSet.values()];
  if (analysis.characters.length) {
    // 路人（自動分級或人物設定手動指定）收進「其他角色」並預設收合，主幹只留主要與次要角色。
    const tiers = autoTiers(analysis.characters);
    const related = new Set(relations.flatMap((relation) => [relation.from, relation.to]));
    const characterNode = (info: CharacterInfo) => node(
      info.lines ? `${info.name}（${info.lines} 句）` : info.name,
      relations.filter((relation) => relation.from === info.name || relation.to === info.name).map((relation) => {
        const other = relation.from === info.name ? relation.to : relation.from;
        return node(`${RELATION_LABELS[relation.type]}${relation.label ? `・${relation.label}` : ''} → ${other}`);
      }),
    );
    const isExtra = (info: CharacterInfo) => resolveTier(info.name, tiers, project.bible?.[info.name]) === 'extra' && !related.has(info.name);
    const mains = analysis.characters.filter((info) => !isExtra(info));
    const extras = analysis.characters.filter(isExtra);
    const children = mains.slice(0, 16).map(characterNode);
    const overflow = [...mains.slice(16), ...extras];
    if (overflow.length) children.push({ ...node('其他角色', overflow.map(characterNode)), collapsed: true });
    branches.push(node('角色', children));
  }
  const documentOrder = new Map((project.recordOrder ?? []).map((id, index) => [id, index]));
  const inDocumentOrder = <T extends { id: string }>(items: T[]) => items
    .map((item, index) => ({ item, index, order: documentOrder.get(item.id) ?? Number.POSITIVE_INFINITY }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ item }) => item);
  const storyRecords = [
    ...inDocumentOrder(project.threads).map((thread) => node(thread.title)),
    ...inDocumentOrder(project.claims.filter((claim) => claim.status !== 'archived')).map((claim) => node(claim.text)),
  ];
  if (storyRecords.length) branches.push(node('伏筆與設定', storyRecords));
  if (!branches.length) branches.push(node('主題'), node('角色'), node('衝突'), node('結局'));
  return { id: newId(), text: project.title || '我的故事', children: branches, generated: true };
}

/** 左側人物清單的共用排序：出場場次多的在前；同場次數比台詞句數，再比首次出場。沒出場的（只在設定裡）排最後。 */
export function sortByAppearance<T extends string>(names: T[], characters: CharacterInfo[]): T[] {
  const info = new Map(characters.map((item) => [item.name, item] as const));
  const order = new Map(names.map((name, index) => [name, index] as const));
  return [...names].sort((a, b) => {
    const x = info.get(a), y = info.get(b);
    return (y?.scenes.length ?? -1) - (x?.scenes.length ?? -1)
      || (y?.lines ?? 0) - (x?.lines ?? 0)
      || (x?.firstScene ?? Number.POSITIVE_INFINITY) - (y?.firstScene ?? Number.POSITIVE_INFINITY)
      || (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
}
