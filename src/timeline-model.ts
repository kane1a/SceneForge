export type StoryTimeAxis = 'year' | 'day' | 'relative-day' | 'daypart' | 'unparsed';
export interface StoryTimeAnchor {
  axis: StoryTimeAxis;
  value: number;
  groupLabel: string;
  sortKey: number;
  dayPart?: number;
  absolute?: boolean;
  label: string;
}
export interface TimelineSceneOrder {
  id: string;
  number: number;
  storyTime?: string;
  storyOrder?: number;
}
export interface BraidConnector {
  sceneId: string;
  narrativeIndex: number;
  chronologicalIndex: number;
  direction: '倒敘' | '預敘' | '';
}
export interface ChronologyDecoration {
  sceneId: string;
  groupLabel: string;
  gapBefore: string;
  anchor: StoryTimeAnchor | null;
}

const NUMBER_TOKEN = '[0-9,]+|[零〇○一二兩三四五六七八九十百千]+';
const DIGITS: Record<string, number> = { 零: 0, 〇: 0, '○': 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function readNumber(value: string): number | null {
  const normalized = value.replaceAll(',', '').trim();
  if (/^\d+$/u.test(normalized)) return Number(normalized);
  if (!normalized || !/^[零〇○一二兩三四五六七八九十百千]+$/u.test(normalized)) return null;
  let total = 0;
  let current = 0;
  for (const character of normalized) {
    if (character in DIGITS) current = DIGITS[character];
    else {
      const unit = SMALL_UNITS[character];
      total += (current || 1) * unit;
      current = 0;
    }
  }
  return total + current;
}

function dayPartOf(text: string): number | undefined {
  const cues: [RegExp, number][] = [
    [/午夜|子夜/u, 0],
    [/凌晨/u, 3],
    [/清晨|拂曉|黎明|dawn/iu, 6],
    [/早晨|早上/u, 7],
    [/上午|晨/u, 9],
    [/中午|正午/u, 12],
    [/午後|下午/u, 15],
    [/黃昏|傍晚/u, 18],
    [/晚上|夜晚|夜間/u, 20],
    [/深夜/u, 23],
    [/夜/u, 21],
  ];
  return cues.find(([pattern]) => pattern.test(text))?.[1];
}

function numberLabel(value: number): string {
  const small: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十' };
  return small[value] ?? String(value);
}

/** Parse common writer-entered story-time anchors without guessing arbitrary prose. */
export function parseStoryTime(input: string | undefined | null): StoryTimeAnchor | null {
  const label = input?.trim() ?? '';
  if (!label) return null;
  const dayPart = dayPartOf(label);
  const number = `(${NUMBER_TOKEN})`;

  const relativeYear = new RegExp(`${number}\\s*年\\s*(前|後|后)`, 'u').exec(label);
  if (relativeYear) {
    const amount = readNumber(relativeYear[1]);
    if (amount !== null) {
      const value = relativeYear[2] === '前' ? -amount : amount;
      return { axis: 'year', value, groupLabel: label, sortKey: value * 24 + (dayPart ?? 0), dayPart, absolute: false, label };
    }
  }
  if (/現在|此刻|當下|現今/u.test(label)) return { axis: 'year', value: 0, groupLabel: '現在', sortKey: dayPart ?? 0, dayPart, absolute: false, label };

  const absoluteYear = /(1[89]\d{2}|20\d{2}|21\d{2})\s*年?\s*(春|夏|秋|冬)?/u.exec(label);
  if (absoluteYear) {
    const season = ({ 春: 0, 夏: 1, 秋: 2, 冬: 3 } as Record<string, number>)[absoluteYear[3] ?? '春'] ?? 0;
    const year = Number(absoluteYear[1]);
    return { axis: 'year', value: year, groupLabel: `${year} 年${absoluteYear[3] ?? ''}`, sortKey: year * 4 + season, dayPart, absolute: true, label };
  }

  const relativeDay = new RegExp(`${number}\\s*天\\s*(前|後|后)`, 'u').exec(label);
  if (relativeDay) {
    const amount = readNumber(relativeDay[1]);
    if (amount !== null) {
      const value = relativeDay[2] === '前' ? -amount : amount;
      return { axis: 'relative-day', value, groupLabel: label, sortKey: value * 24 + (dayPart ?? 0), dayPart, absolute: false, label };
    }
  }

  const numberedDay = new RegExp(`(?:第\\s*)?${number}\\s*(?:天|日)`, 'u').exec(label);
  const englishDay = /\bday\s*(\d+)\b/iu.exec(label);
  const dayValue = numberedDay ? readNumber(numberedDay[1]) : englishDay ? Number(englishDay[1]) : null;
  if (dayValue !== null) {
    return { axis: 'day', value: dayValue, groupLabel: `第 ${dayValue} 天`, sortKey: dayValue * 24 + (dayPart ?? 0), dayPart, absolute: true, label };
  }

  if (dayPart !== undefined) return { axis: 'daypart', value: dayPart, groupLabel: label, sortKey: dayPart, label };
  return { axis: 'unparsed', value: 0, groupLabel: label, sortKey: 0, label };
}

function comparable(a: StoryTimeAnchor | null, b: StoryTimeAnchor | null): boolean {
  return !!a && !!b && a.axis === b.axis && (a.axis !== 'year' || a.absolute === b.absolute);
}

/** Parsed times establish a default order; a saved storyOrder always reflects the writer's drag order. */
export function orderTimelineScenes<T extends TimelineSceneOrder>(scenes: T[]): T[] {
  const hasManualOrder = scenes.some((scene) => Number.isFinite(scene.storyOrder));
  if (hasManualOrder) return [...scenes].sort((a, b) => (a.storyOrder ?? a.number) - (b.storyOrder ?? b.number) || a.number - b.number);
  const anchors = scenes.map((scene) => parseStoryTime(scene.storyTime));
  if (anchors.length > 1 && anchors.every((anchor) => comparable(anchors[0], anchor))) {
    return [...scenes].sort((a, b) => {
      const left = parseStoryTime(a.storyTime)!;
      const right = parseStoryTime(b.storyTime)!;
      return left.sortKey - right.sortKey || a.number - b.number;
    });
  }
  return [...scenes].sort((a, b) => a.number - b.number);
}

/** Connect every scene across the two axes and label chronology/narrative displacement. */
export function buildBraidConnectors(narrativeIds: string[], chronologicalIds: string[]): BraidConnector[] {
  const chronologicalRank = new Map(chronologicalIds.map((id, index) => [id, index]));
  return narrativeIds.flatMap((sceneId, narrativeIndex) => {
    const chronologicalIndex = chronologicalRank.get(sceneId);
    if (chronologicalIndex === undefined) return [];
    return [{
      sceneId,
      narrativeIndex,
      chronologicalIndex,
      direction: chronologicalIndex < narrativeIndex ? '倒敘' as const : chronologicalIndex > narrativeIndex ? '預敘' as const : '' as const,
    }];
  });
}

function gapBefore(previous: StoryTimeAnchor | null, current: StoryTimeAnchor | null): string {
  if (!comparable(previous, current) || !previous || !current || previous.axis === 'daypart' || previous.axis === 'unparsed') return '';
  const delta = Math.abs(current.value - previous.value);
  if (delta <= 1) return '';
  if (previous.axis === 'year') return `… ${numberLabel(delta)}年 …`;
  if (previous.axis === 'day' || previous.axis === 'relative-day') return `… ${delta} 天 …`;
  return '';
}

/** Group labels and visual time gaps follow the already ordered chronology row. */
export function buildChronologyDecorations(scenes: { id: string; storyTime?: string }[]): ChronologyDecoration[] {
  let previous: StoryTimeAnchor | null = null;
  return scenes.map((scene) => {
    const anchor = parseStoryTime(scene.storyTime);
    const result: ChronologyDecoration = {
      sceneId: scene.id,
      groupLabel: anchor?.groupLabel ?? '',
      gapBefore: gapBefore(previous, anchor),
      anchor,
    };
    if (anchor) previous = anchor;
    return result;
  });
}

function storySpan(scenes: { storyTime?: string }[]): string {
  const anchors = scenes.map((scene) => parseStoryTime(scene.storyTime)).filter((anchor): anchor is StoryTimeAnchor => !!anchor);
  if (anchors.length < 2 || !anchors.every((anchor) => comparable(anchors[0], anchor))) return '';
  const first = anchors[0];
  const values = anchors.map((anchor) => anchor.value);
  const span = Math.max(...values) - Math.min(...values);
  if (span <= 0) return '';
  if (first.axis === 'year') return `故事橫跨 ${span} 年`;
  if (first.axis === 'day' || first.axis === 'relative-day') return `故事橫跨 ${span} 天`;
  return '';
}

export function summarizeTimeline(
  scenes: { id: string; storyTime?: string }[],
  connectors: { direction: string }[],
): string {
  const flashbacks = connectors.filter((connector) => connector.direction === '倒敘').length;
  const flashforwards = connectors.filter((connector) => connector.direction === '預敘').length;
  const parts: string[] = [];
  if (flashbacks) parts.push(`${flashbacks} 場倒敘`);
  if (flashforwards) parts.push(`${flashforwards} 場預敘`);
  const span = storySpan(scenes);
  if (span) parts.push(span);
  return parts.join('・') || '敘事順序與故事時序一致';
}

export function sceneBlockCounts(blocks: { type: string; id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  let currentScene: string | null = null;
  for (const block of blocks) {
    if (block.type === 'scene') {
      currentScene = block.id;
      counts.set(currentScene, 0);
    } else if (currentScene) counts.set(currentScene, (counts.get(currentScene) ?? 0) + 1);
  }
  return counts;
}
