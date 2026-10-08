import type { Project } from './types';

export interface StoryOccurrence { sceneId: string; sceneNumber: number; blockId: string; excerpt: string }
export interface StoryCandidate { key: string; text: string; sourceBlockId: string; occurrences: StoryOccurrence[]; score: number }
export interface IdentitySuggestion { key: string; names: [string, string]; reason: string }

type ScriptScene = { id: string; number: number; heading: string; blocks: Project['blocks'] };

function scriptScenes(project: Project): ScriptScene[] {
  const scenes: ScriptScene[] = [];
  let current: ScriptScene | undefined;
  for (const block of project.blocks) {
    if (block.type === 'scene') {
      current = { id: block.id, number: scenes.length + 1, heading: block.text, blocks: [] };
      scenes.push(current);
    } else if (current) current.blocks.push(block);
  }
  return scenes;
}

const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
const STOPWORDS = new Set(['的人', '一個', '一件', '這個', '那個', '我們', '你們', '他們', '她們', '自己', '東西', '事情', '地方', '時候', '現在', '今天', '明天', '晚上', '早上', '前面', '後面', '裡面', '外面', '然後', '因為', '所以', '但是', '如果', '正在', '就是', '不是', '沒有', '可以', '知道', '看到', '看著', '走到', '回到', '說著', '想到', '一樣', '突然', '慢慢', '房間', '客廳', '公司', '學校', '醫院', '家裡']);

function excludedTerms(project: Project, scenes: ScriptScene[]): Set<string> {
  const excluded = new Set<string>();
  for (const entity of project.entities) {
    for (const item of [entity.name, ...entity.aliases]) if (item.trim()) excluded.add(normalize(item));
  }
  for (const block of project.blocks) if (block.type === 'character') { const name = block.text.trim().replace(/[：:]$/u, ''); if (name) excluded.add(normalize(name)); }
  for (const scene of scenes) {
    const heading = scene.heading;
    for (const item of heading.match(/[\u3400-\u9fff]{2,8}/gu) ?? []) excluded.add(normalize(item));
  }
  return excluded;
}

/** Deterministic, deliberately conservative candidate detection; nothing is added automatically. */
export function detectForeshadowCandidates(project: Project): StoryCandidate[] {
  const scenes = scriptScenes(project);
  if (scenes.length < 2) return [];
  const maxDistance = Math.max(1, scenes.length - 1);
  const excluded = excludedTerms(project, scenes);
  const occurrences = new Map<string, StoryOccurrence[]>();
  for (const scene of scenes) {
    for (const block of scene.blocks) {
      if (!['action', 'dialogue', 'shot'].includes(block.type)) continue;
      const raw = block.text;
      const excerpt = raw.replace(/\s+/gu, ' ').trim();
      const found = new Set<string>();
      for (const run of raw.match(/[\u3400-\u9fff]{2,}/gu) ?? []) {
        const chars = Array.from(run);
        for (let length = 2; length <= Math.min(6, chars.length); length += 1) {
          for (let start = 0; start + length <= chars.length; start += 1) found.add(chars.slice(start, start + length).join(''));
        }
      }
      for (const quoted of raw.match(/[「『“"]([^」』”"]{2,30})[」』”"]/gu) ?? []) {
        const value = quoted.replace(/^[「『“"]|[」』”"]$/gu, '').trim();
        if (value) found.add(value);
      }
      for (const english of raw.match(/\b[A-Z][A-Za-z0-9'-]{1,24}\b/gu) ?? []) found.add(english);
      for (const term of found) {
        const key = normalize(term);
        if (term.length < 2 || STOPWORDS.has(term) || STOPWORDS.has(key) || excluded.has(key)) continue;
        const list = occurrences.get(key) ?? [];
        if (!list.some((item) => item.sceneId === scene.id)) list.push({ sceneId: scene.id, sceneNumber: scene.number, blockId: block.id, excerpt });
        occurrences.set(key, list);
      }
    }
  }
  const candidates: StoryCandidate[] = [];
  for (const [key, hits] of occurrences) {
    if (hits.length < 2) continue;
    const first = Math.min(...hits.map((item) => item.sceneNumber));
    const last = Math.max(...hits.map((item) => item.sceneNumber));
    const distance = (last - first) / maxDistance;
    if (distance < 0.25) continue;
    const text = [...occurrences.entries()].find(([candidateKey]) => candidateKey === key)?.[1]
      ? hits.map((hit) => {
        const block = project.blocks.find((item) => item.id === hit.blockId);
        if (!block) return '';
        const match = block.text.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
        return match?.[0] ?? '';
      }).find(Boolean) ?? key : key;
    const rarity = 1 / hits.length;
    candidates.push({ key, text, sourceBlockId: hits[0].blockId, occurrences: hits, score: distance * 100 + rarity * 10 + Math.min(Array.from(text).length, 6) });
  }
  const sceneSig = (item: StoryCandidate) => item.occurrences.map((hit) => hit.sceneId).sort().join('|');
  const kept = candidates.filter((item) => !candidates.some((other) => other !== item && other.key.length > item.key.length && other.key.includes(item.key) && sceneSig(other) === sceneSig(item)));
  return kept.sort((a, b) => b.score - a.score || b.text.length - a.text.length).slice(0, 24);
}

/** Find short, rule-matched statements that may be useful as setting notes. */
export function detectSettingCandidates(project: Project): StoryCandidate[] {
  const patterns = [
    /[^。！？\n]{1,36}(?:\d{1,3}\s*歲|歲數|年齡)[^。！？\n]{0,36}/gu,
    /[^。！？\n]{1,36}(?:是|叫做|名叫|姓|來自|住在|出生於|擔任)[^。！？\n]{1,36}/gu,
    /[^，。！？\n]{2,20}[，,]\s*\d{1,3}\s*歲(?:[，,][^，。！？\n]{2,24})?/gu,
    /[（(][^）)\n]{2,28}(?:歲|司機|老師|醫生|警察|學生|店員|老闆|護士|律師|工程師)[^）)\n]*[）)]/gu,
  ];
  const scenes = scriptScenes(project);
  const candidates = new Map<string, StoryCandidate>();
  for (const scene of scenes) for (const block of scene.blocks) {
    if (!['action', 'dialogue'].includes(block.type)) continue;
    for (const [patternIndex, pattern] of patterns.entries()) {
      if (patternIndex === 1 && block.type !== 'action') continue;
      pattern.lastIndex = 0;
      for (const match of block.text.matchAll(pattern)) {
        const text = match[0].trim().replace(/[，,；;：:\s]+$/u, '');
        if (Array.from(text).length < 4 || /[？?]$/u.test(match[0].trim())) continue;
        if ([...candidates.values()].some((item) => item.sourceBlockId === block.id && (item.text.includes(text) || text.includes(item.text)))) {
          const existing = [...candidates.entries()].find(([, item]) => item.sourceBlockId === block.id && text.includes(item.text) && text !== item.text);
          if (existing) candidates.delete(existing[0]); else continue;
        }
        const key = `${block.id}:${normalize(text)}`;
        if (!candidates.has(key)) candidates.set(key, {
          key, text, sourceBlockId: block.id,
          occurrences: [{ sceneId: scene.id, sceneNumber: scene.number, blockId: block.id, excerpt: block.text.replace(/\s+/gu, ' ').trim() }],
          score: text.length,
        });
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 40);
}

const GENERIC_NAMES = new Set(['男孩', '女孩', '老人', '男人', '女人', '少年', '少女', '陌生人', '小男孩', '小女孩', '老婦人', '老男人', '男孩兒', '女孩兒', '小孩', '孩子', '司機', '店員', '警察']);
const containsCjk = (value: string) => /[\u3400-\u9fff]/u.test(value);
const asciiName = (value: string) => /^[A-Za-z][A-Za-z0-9 .'-]*$/u.test(value.trim());

/** Suggest (never apply) speaker-name merges using non-overlap and conservative name-shape clues. */
export function suggestSamePerson(project: Project): IdentitySuggestion[] {
  const appearances = new Map<string, Set<number>>();
  let scene = 0;
  let inScene = false;
  for (const block of project.blocks) {
    if (block.type === 'scene') { scene += 1; inScene = true; }
    if (block.type !== 'character') continue;
    const name = block.text.trim().replace(/[：:]$/u, '');
    if (!name) continue;
    const set = appearances.get(name) ?? new Set<number>();
    set.add(inScene ? scene : 0);
    appearances.set(name, set);
  }
  const aliasPairs = new Set<string>();
  for (const entity of project.entities) for (const alias of entity.aliases) aliasPairs.add([normalize(entity.name), normalize(alias)].sort().join('\u0000'));
  const names = [...appearances.keys()];
  const result: IdentitySuggestion[] = [];
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
    const a = names[i], b = names[j];
    const pair = [normalize(a), normalize(b)].sort().join('\u0000');
    if (aliasPairs.has(pair)) continue;
    const aScenes = [...appearances.get(a)!];
    const bScenes = [...appearances.get(b)!];
    if (aScenes.some((value) => appearances.get(b)!.has(value))) continue;
    const aEnd = Math.max(...aScenes), bEnd = Math.max(...bScenes);
    const aStart = Math.min(...aScenes), bStart = Math.min(...bScenes);
    const sequential = aEnd < bStart || bEnd < aStart;
    const aGeneric = GENERIC_NAMES.has(a), bGeneric = GENERIC_NAMES.has(b);
    const crossScript = (asciiName(a) && containsCjk(b)) || (asciiName(b) && containsCjk(a));
    // Both clues are needed: never speak in overlapping stretches of the script AND one name looks like a placeholder or a different-script name.
    if (!sequential || !(aGeneric || bGeneric || crossScript)) continue;
    const ordered = [a, b].sort((left, right) => aGeneric === GENERIC_NAMES.has(left) ? -1 : 1) as [string, string];
    const reason = `${aGeneric || bGeneric ? '其中一個像是暫稱' : '一個中文名、一個英文名'}，而且兩人從未在同一段落出場`;
    result.push({ key: pair, names: ordered, reason });
  }
  return result.slice(0, 20);
}

/** Profiles list every speaker, manually entered profile, and legacy entity, including orphan settings. */
export function profileNames(project: Project): string[] {
  const aliasTo = new Map<string, string>();
  for (const entity of project.entities ?? []) for (const alias of entity.aliases ?? []) if (alias.trim()) aliasTo.set(normalize(alias), entity.name.trim());
  const speakers = project.blocks.filter((block) => block.type === 'character').map((block) => block.text.trim().replace(/[：:]$/u, '')).filter(Boolean).map((name) => aliasTo.get(normalize(name)) ?? name);
  return [...new Set([
    ...speakers,
    ...(project.entities ?? []).map((entity) => entity.name.trim()).filter(Boolean),
    ...Object.keys(project.bible ?? {}),
    ...(project.relations ?? []).flatMap((relation) => [relation.from, relation.to]),
  ])];
}

export function identitySuggestionKey(names: string[]): string {
  return names.map(normalize).sort().join('\u0000');
}
