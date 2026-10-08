export type SceneCompletionStage = 'interior-exterior' | 'location' | 'separator' | 'time' | null;

export interface SceneCompletion {
  stage: SceneCompletionStage;
  ghost: string;
  candidates: string[];
  candidateIndex: number;
}

const TIMES = ['DAY', 'NIGHT', 'DAWN', 'DUSK', 'CONTINUOUS', 'LATER', 'SAME TIME', 'MOMENTS LATER'] as const;
const CN_TIMES = ['日', '夜', '晨', '昏', '清晨', '傍晚', '深夜', '凌晨', '午後', '上午', '下午', '日外', '夜外', '日出', '日落'] as const;
const PREFIXES = ['INT.', 'EXT.', '內景', '外景', 'INT./EXT.', '內外景'];
const SCENE_PREFIX = /^(INT(?:\/EXT)?|EXT|EST|I\/E|內外景|內景|外景|內|外)\.?\s*(.*)$/i;
const isChinesePrefix = (prefix: string) => /\p{Script=Han}/u.test(prefix);

function choose(candidates: string[], index: number): string {
  return candidates.length ? candidates[((index % candidates.length) + candidates.length) % candidates.length] : '';
}

export type SceneStyle = 'hollywood' | 'taiwan';
const ZH_PREFIXES = ['內景', '外景', '內外景'];
const ZH_TIMES = ['日', '夜', '晨', '昏', '清晨', '傍晚', '深夜'];

/** 台式 headings: 「內景 阿強家客廳 夜」 — Chinese interior/exterior, location, time, separated by spaces. */
function getTaiwanCompletion(text: string, locations: readonly string[], index: number): SceneCompletion {
  const none: SceneCompletion = { stage: null, ghost: '', candidates: [], candidateIndex: 0 };
  const value = text.replace(/^\s+/, '');
  if (!value.trim()) return { stage: 'interior-exterior', ghost: `${choose(ZH_PREFIXES, index)} `, candidates: ZH_PREFIXES, candidateIndex: index % ZH_PREFIXES.length };
  const prefix = /^(內外景|內景|外景)(\s*)(.*)$/u.exec(value);
  if (!prefix) {
    const typed = ZH_PREFIXES.filter((item) => item.startsWith(value.trim()) && item !== value.trim());
    return typed.length ? { stage: 'interior-exterior', ghost: `${choose(typed, index).slice(value.trim().length)} `, candidates: typed, candidateIndex: index % typed.length } : none;
  }
  const rest = prefix[3];
  if (!rest.trim()) {
    const unique = [...new Set(locations.map((item) => item.trim()).filter(Boolean))];
    if (!unique.length) return none;
    return { stage: 'location', ghost: `${prefix[2] ? '' : ' '}${choose(unique, index)} `, candidates: unique, candidateIndex: index % unique.length };
  }
  const tokens = rest.trim().split(/\s+/u);
  if (tokens.length === 1 && !/\s$/u.test(rest)) return none; // still typing the location
  const partial = tokens.length >= 2 ? tokens[tokens.length - 1] : '';
  if (ZH_TIMES.includes(partial)) return none;
  const candidates = partial ? ZH_TIMES.filter((time) => time.startsWith(partial)) : ZH_TIMES;
  if (!candidates.length) return none;
  return { stage: 'time', ghost: choose(candidates, index).slice(partial.length), candidates, candidateIndex: index % candidates.length };
}
function acceptTaiwan(text: string, candidate: string): { text: string; stage: SceneCompletionStage } {
  const completion = getTaiwanCompletion(text, [candidate], 0);
  const value = text.replace(/\s+$/u, '');
  if (completion.stage === 'interior-exterior') return { text: `${candidate} `, stage: completion.stage };
  if (completion.stage === 'location') return { text: `${value} ${candidate} `, stage: completion.stage };
  if (completion.stage === 'time') {
    const tokens = value.split(/\s+/u);
    const endsWithSpace = /\s$/u.test(text);
    const head = endsWithSpace || tokens.length < 3 ? value : tokens.slice(0, -1).join(' ');
    return { text: `${head} ${candidate}`, stage: completion.stage };
  }
  return { text, stage: null };
}

export function getSceneCompletion(text: string, rememberedLocations: readonly string[], candidateIndex = 0, style: SceneStyle = 'hollywood'): SceneCompletion {
  const safeIndex = Math.max(0, Math.floor(candidateIndex));
  if (style === 'taiwan') return getTaiwanCompletion(text, rememberedLocations, safeIndex);
  if (!text.trim()) {
    const candidates = PREFIXES;
    return { stage: 'interior-exterior', ghost: `${choose(candidates, safeIndex)} `, candidates, candidateIndex: safeIndex % candidates.length };
  }
  const prefix = SCENE_PREFIX.exec(text.trimStart());
  if (!prefix) {
    if (/^(?:I|E|IN|EX|INT\/)$/i.test(text.trim())) {
      const typed = text.trim().toUpperCase();
      const candidates = PREFIXES.filter((item) => item.startsWith(typed)).concat(typed.startsWith('I') ? [] : []);
      return { stage: 'interior-exterior', ghost: `${choose(candidates, safeIndex)} `, candidates, candidateIndex: safeIndex % candidates.length };
    }
    return { stage: null, ghost: '', candidates: [], candidateIndex: 0 };
  }

  const rest = prefix[2] ?? '';
  if (!rest.trim()) {
    const locations = [...new Set(rememberedLocations.map((value) => value.trim()).filter(Boolean))];
    // Only offer places this script already uses; never a placeholder word the writer would have to delete.
    if (!locations.length) return { stage: null, ghost: '', candidates: [], candidateIndex: 0 };
    return { stage: 'location', ghost: `${choose(locations, safeIndex)} - `, candidates: locations, candidateIndex: safeIndex % locations.length };
  }

  const separator = rest.lastIndexOf('-');
  if (separator < 0) {
    if (!rest.trim()) {
      const locations = [...new Set(rememberedLocations.map((value) => value.trim()).filter(Boolean))];
      if (!locations.length) return { stage: null, ghost: '', candidates: [], candidateIndex: 0 };
      return { stage: 'location', ghost: `${choose(locations, safeIndex)} - `, candidates: locations, candidateIndex: safeIndex % locations.length };
    }
    const candidates = isChinesePrefix(prefix[1]) ? [...CN_TIMES] : [...TIMES];
    return { stage: 'separator', ghost: ` - ${choose(candidates, safeIndex)}`, candidates, candidateIndex: safeIndex % candidates.length };
  }

  const timePart = rest.slice(separator + 1).trim();
  const timePrefix = timePart.toUpperCase();
  const times: string[] = isChinesePrefix(prefix[1]) ? [...CN_TIMES] : [...TIMES];
  if (times.some((time) => time === timePrefix)) return { stage: null, ghost: '', candidates: [], candidateIndex: 0 };
  const candidates = timePart ? times.filter((time) => time.startsWith(timePrefix)) : times;
  if (!candidates.length) return { stage: null, ghost: '', candidates: [], candidateIndex: 0 };
  const selected = choose(candidates, safeIndex);
  return { stage: 'time', ghost: selected.slice(timePrefix.length), candidates, candidateIndex: safeIndex % candidates.length };
}

export function acceptSceneCompletion(text: string, candidate: string, style: SceneStyle = 'hollywood'): { text: string; stage: SceneCompletionStage } {
  if (style === 'taiwan') return acceptTaiwan(text, candidate);
  const completion = getSceneCompletion(text, [candidate], 0);
  if (!completion.stage || !candidate) return { text, stage: null };
  const value = text.trimEnd();
  if (completion.stage === 'interior-exterior') {
    const partialPrefix = /^(?:I|E|INT|EXT|EST|I\/E|INT\/EXT)\.?$/i.test(value);
    return { text: `${partialPrefix || !value ? '' : `${value} `}${candidate.trim()} `, stage: completion.stage };
  }
  if (completion.stage === 'location') return { text: `${value} ${candidate.trim()} - `, stage: completion.stage };
  if (completion.stage === 'separator') return { text: `${value} - ${candidate.trim()}`, stage: completion.stage };
  if (completion.stage === 'time') {
    const match = /^(.*-\s*)([A-Z\p{Script=Han}]*)$/iu.exec(value);
    return { text: match ? `${match[1].replace(/\s*$/, ' ')}${candidate.trim()}` : `${value} ${candidate.trim()}`, stage: completion.stage };
  }
  return { text, stage: null };
}

const SCENE_NUMBER_PREFIX = /^(?:(?:第\s*\d+\s*場)|(?:S\s*\d+)|(?:\d+[.、]))\s*/iu;
const HEADING_PREFIX = /^(?:INT(?:\/EXT)?|EXT|EST|I\/E|內外景|內景|外景|內|外)\.?\s+/iu;
const CN_LOCATION_TIMES = ['凌晨', '午後', '上午', '下午', '日外', '夜外', '日出', '日落', '黃昏', '傍晚', '清晨', '深夜', '白天', '晚上', '早晨', '夜晚', '日', '夜', '晨', '昏'];
const US_LOCATION_TIMES = ['MOMENTS LATER', 'SAME TIME', 'CONTINUOUS', '清晨前', '凌晨', '午後', '上午', '下午', '日外', '夜外', '日出', '日落', '黃昏', '傍晚', '清晨', '深夜', '白天', '晚上', '早晨', '夜晚', 'NIGHT', 'DAWN', 'DUSK', 'LATER', 'DAY', '夜', '晨', '昏', '日'];

function stripHeadingNumber(value: string): string {
  let heading = value.normalize('NFKC').trim().replace(SCENE_NUMBER_PREFIX, '');
  // Traditional scene numbers are sometimes written as "2 INT." without punctuation.
  heading = heading.replace(/^\d+\s+(?=(?:INT(?:\/EXT)?|EXT|EST|I\/E|內外景|內景|外景|內|外)(?:\.|\s))/iu, '');
  return heading.trim();
}

function locationWithoutSceneNumber(value: string): string | null {
  const place = value.trim().replace(/\s+\d+[.、]?$/u, '').trim();
  return place && !/^\d+[.、]*$/u.test(place) ? place : null;
}

function trailingTime(value: string, times: readonly string[]): { place: string; time: string } | null {
  const escaped = [...times].sort((a, b) => b.length - a.length).map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const match = new RegExp(`^(.*?)\\s+(${escaped.join('|')})\\s*$`, 'iu').exec(value.trim());
  return match ? { place: match[1].trim(), time: match[2] } : null;
}

export function extractRememberedLocation(text: string): string | null {
  const heading = stripHeadingNumber(text);
  if (!heading || /^\d+[.、]*$/u.test(heading)) return null;

  const prefix = HEADING_PREFIX.exec(heading);
  if (!prefix) return null;
  const rest = heading.slice(prefix[0].length).trim();
  if (!rest) return null;

  if (/\p{Script=Han}/u.test(prefix[0])) {
    const parsed = trailingTime(rest, CN_LOCATION_TIMES);
    return parsed ? locationWithoutSceneNumber(parsed.place) : null;
  }
  const match = /^(.*?)\s+-\s+(.+)$/u.exec(rest);
  if (!match || !US_LOCATION_TIMES.some((time) => time === match[2].trim().toUpperCase())) return null;
  return locationWithoutSceneNumber(match[1]);
}
