import type { Block, BlockType } from './types';
import { markMessages } from './document';

/**
 * 智慧匯入：把任何格式的文字（Fountain、Markdown、中文劇本慣例、小說式散文、
 * 亂排的筆記）轉成 SceneForge 的結構化段落。
 *
 * 兩個「學習」來源：
 *  1. 檔內自我學習——先掃一遍全文，出現兩次以上的「名字：台詞」即視為角色。
 *  2. 跨檔記憶——使用者在預覽中修正的分類會寫入 ImportMemory（角色、非角色、
 *     行首規則），下一次匯入直接套用。所有規則可檢視、可刪除。
 */

export interface ImportRule { prefix: string; type: BlockType; hits?: number }
export interface ImportMemory {
  characters: string[];
  notCharacters: string[];
  rules: ImportRule[];
  corrections: number;
}
export const EMPTY_MEMORY: ImportMemory = { characters: [], notCharacters: [], rules: [], corrections: 0 };

export type Confidence = 'high' | 'medium' | 'low';
export interface SmartBlock extends Block {
  confidence: Confidence;
  reason: string;
  line: number;
  /** Stable key for per-block overrides: source line + ordinal among blocks from that line. */
  key: string;
  source: string;
  speaker?: string;
}
export interface SmartImportResult {
  blocks: SmartBlock[];
  metadata: Record<string, string>;
  characters: { name: string; lines: number }[];
  format: string;
  stats: { scenes: number; characters: number; dialogues: number; lowConfidence: number; sourceLines: number };
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

const CN_NUM = '0-9０-９一二三四五六七八九十百千零〇兩';
const TERMINAL = /[。！？!?…」』”"）)．.~～]$/u;
const INT_EXT = /^(?:INT\.?\s*\/\s*EXT|I\s*\/\s*E|INT|EXT|EST)(?:[.\s]|$)/i;
const CN_PLACE_TOKEN = /(?:^|[\s　、，,·・．.\-—–/／|｜【\[（(])(內景|外景|內外景|內\/外|內／外|内景|外景|室內|室外|內|外|内)(?=$|[\s　、，,·・．.\-—–/／|｜】\]）)])/u;
const CN_TIME_TOKEN = /(?:^|[\s　、，,·・．.\-—–/／|｜【\[（(])(日|夜|晨|昏|早|晚|白天|夜晚|晚上|清晨|黃昏|黄昏|傍晚|午後|午后|深夜|凌晨|黎明|下午|上午|中午|早上|日景|夜景|日內|日外|夜內|夜外|日内|夜内|DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|CONTINUOUS|LATER)(?=$|[\s　、，,·・．.\-—–/／|｜】\]）)])/iu;
const SCENE_NUMBER = new RegExp(`^(?:第\\s*[${CN_NUM}]+\\s*[場场](?:\\s*戲)?|[場场]景?\\s*[${CN_NUM}]+|S(?:C|CENE)?\\s*\\.?\\s*[0-9]+[A-Z]?|[0-9０-９]+(?:\\s*[-－.．]\\s*[0-9０-９]+)?)(?=[\\s\\u3000.、．:：|｜\\-—–]|$)[\\s\\u3000.、．:：|｜\\-—–]*`, 'iu');
const SCENE_MARKER = /^[○◎●◉■□◆◇★☆]\s*/u;
const ACTION_MARKER = /^[△▲▵＊✱]\s*/u;
const NOTE_MARKER = /^(?:※|\/\/|#\s|NB[:：])\s*/u;
const ACT_LINE = new RegExp(`^(?:第\\s*[${CN_NUM}]+\\s*[幕集章回卷](?:\\s|$|[：:、．.]).{0,24}|第\\s*[${CN_NUM}]+\\s*[幕集章回卷]|序幕|序章|序場|楔子|尾聲|终幕|終幕|結局|ACT\\s+(?:[IVX0-9]+|ONE|TWO|THREE|FOUR|FIVE|SIX)\\b.*|END\\s+OF\\s+ACT.*|PROLOGUE|EPILOGUE|TEASER|COLD\\s+OPEN|TAG)$`, 'iu');
const TRANSITION_LINE = /^(?:(?:CUT|FADE|DISSOLVE|SMASH\s+CUT|MATCH\s+CUT|JUMP\s+CUT|WIPE|IRIS)\b[A-Z .]*(?:TO|IN|OUT|BLACK)[:.]?|FADE\s+(?:IN|OUT)[:.]?|[A-Z ]+\sTO:|(?:切至|切到|切入|切出|切換|轉場|转场|淡入|淡出|漸隱|漸顯|溶接|溶至|疊化|叠化|黑場|黑屏|閃回|閃白|跳切|化入|化出)(?:[:：。.\s].{0,10})?|[—\-－=]{2,}\s*(?:切|轉|完)\s*[—\-－=]*|[（(](?:切|轉場|淡出|淡入|完)[）)])$/iu;
const SHOT_LINE = /^(?:大特寫|特寫|近景|中近景|中景|遠景|全景|大遠景|空鏡|空镜|鏡頭|镜头|俯拍|仰拍|主觀鏡頭|航拍|跟拍|POV|CLOSE\s+(?:ON|UP)|ANGLE\s+ON|WIDE\s+(?:ON|SHOT)|INSERT|BACK\s+TO\s+SCENE|INTERCUT|ESTABLISHING)(?=$|[\s:：—\-，,、])/iu;
const NOTE_LINE = /^(?:註|注|備註|备注|附註|筆記|笔记|NOTE|TODO|FIXME|編按|作者按)\s*[:：]/iu;
const CAST_LINE = /^(?:出場人物|出场人物|人物|角色|登場人物|登场人物|主要人物|CAST|CHARACTERS)\s*[:：]\s*(.+)$/iu;
const META_LINE = /^(?:劇名|剧名|片名|標題|标题|集數|集数|編劇|编剧|導演|导演|作者|版本|日期|類型|类型|片長|片长|TITLE|AUTHOR|DRAFT|DATE|CREDIT|SOURCE|CONTACT)\s*[:：]\s*(.+)$/iu;
const SCENE_FIELD = /^(?:場景|场景|地點|地点|時間|时间|景別|场次|場次)\s*[:：]\s*(.+)$/u;
const CAPTION_LINE = /^(?:字幕|字卡|畫面|画面|螢幕|屏幕|SUPER|TITLE\s+CARD|CHYRON)\s*[:：]/iu;

/** Words that look like `名字：` but never name a speaker. */
const NOT_SPEAKERS = new Set([
  '時間', '时间', '地點', '地点', '人物', '角色', '場景', '场景', '備註', '备注', '註', '注', '說明', '说明', '劇名', '剧名', '集數', '集数',
  '編劇', '编剧', '導演', '导演', '內容', '内容', '主題', '主题', '大綱', '大纲', '簡介', '简介', '梗概', '標題', '标题', '版本', '日期', '作者',
  '字幕', '字卡', '畫面', '画面', '結果', '原因', '問題', '问题', '答案', '重點', '重点', '目的', '例如', '比如', '總之', '总之', '注意', '提示',
  '第一', '第二', '第三', '首先', '其次', '最後', '最后', '另外', '然後', '然后', '但是', '所以', '因為', '因为', '於是', '于是', '同時', '同时',
  'NOTE', 'TITLE', 'AUTHOR', 'DRAFT', 'DATE', 'TODO', 'HTTP', 'HTTPS', 'URL', 'EMAIL', 'TEL', 'PS', 'P.S',
]);
const VOICE_EXT = /(?<=\S)\s*[（(]?\s*(V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT['’]?D|畫外音|画外音|旁白|OS|VO)\s*[）)]?\s*$/iu;

export function speakerKey(name: string): string {
  return name.replace(VOICE_EXT, '').replace(/[（(][^）)]*[）)]/gu, '').replace(/^[@*_\s]+|[*_\s:：]+$/gu, '').trim();
}

function isPlausibleName(raw: string): boolean {
  const name = speakerKey(raw);
  if (!name || NOT_SPEAKERS.has(name) || NOT_SPEAKERS.has(name.toUpperCase())) return false;
  if (/[，。！？、；,.!?;「」『』"“”<>《》=+]/u.test(name)) return false;
  if (/^\d+$/.test(name)) return false;
  const cjk = (name.match(/\p{Script=Han}/gu) ?? []).length;
  if (cjk > 0) return Array.from(name).length <= 8 && !/^(?:他|她|它|我|你|我們|他們|她們|大家|有人|這|那)$/u.test(name);
  return /^[\p{L}][\p{L}\p{M}\p{N} .'’·・-]{0,24}$/u.test(name);
}

function isAllCapsName(text: string): boolean {
  const core = text.replace(VOICE_EXT, '').trim();
  return core.length >= 2 && core.length <= 30 && /^[A-Z][A-Z0-9 .'’-]*$/.test(core) && !INT_EXT.test(core) && !TRANSITION_LINE.test(core);
}

interface CleanLine { text: string; heading: number; bold: boolean; raw: string; line: number; blank: boolean; forced?: BlockType }

function stripInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2').replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function preprocess(source: string, metadata: Record<string, string>): CleanLine[] {
  let text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let start = 0;
  if (/^---\s*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^([\w一-鿿-]+)\s*:\s*(.*)$/.exec(line);
        if (match && match[2].trim()) metadata[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
      start = end + 1;
    }
  }
  // Fountain title page: leading "Key: value" lines followed by a blank line.
  if (start === 0 && /^(?:Title|Credit|Author|Source|Draft date|Contact)\s*:/i.test(lines[0] ?? '')) {
    let index = 0;
    while (index < lines.length && lines[index].trim()) {
      const match = /^([A-Za-z ]+):\s*(.*)$/.exec(lines[index]);
      if (match && match[2].trim()) metadata[match[1].trim()] = match[2].trim();
      index += 1;
    }
    start = index;
  }
  const out: CleanLine[] = [];
  let inComment = false;
  let inFence = false;
  for (let index = start; index < lines.length; index += 1) {
    let raw = lines[index];
    // HTML comments and Fountain boneyard become non-printing notes.
    if (inComment) {
      const close = raw.search(/-->|\*\//);
      if (close < 0) { if (raw.trim()) out.push({ text: raw.trim(), heading: 0, bold: false, raw, line: index + 1, blank: false, forced: 'note' }); continue; }
      const before = raw.slice(0, close).trim();
      if (before) out.push({ text: before, heading: 0, bold: false, raw, line: index + 1, blank: false, forced: 'note' });
      raw = raw.slice(close + 3);
      inComment = false;
    }
    const open = raw.search(/<!--|\/\*/);
    if (open >= 0) {
      const close = raw.slice(open + 4).search(/-->|\*\//);
      const body = close >= 0 ? raw.slice(open + 4, open + 4 + close) : raw.slice(open + 4);
      if (body.trim()) out.push({ text: body.trim(), heading: 0, bold: false, raw, line: index + 1, blank: false, forced: 'note' });
      if (close < 0) inComment = true;
      raw = raw.slice(0, open) + (close >= 0 ? raw.slice(open + 4 + close + 3) : '');
      if (!raw.trim()) continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (/^\s*([-*_=])\1{2,}\s*$/.test(raw) && !inFence) { out.push({ text: '', heading: 0, bold: false, raw, line: index + 1, blank: true }); continue; }
    if (/^\s*={3,}\s*$/.test(raw)) continue;
    let working = raw.replace(/\t/g, '    ');
    if (!working.trim()) { out.push({ text: '', heading: 0, bold: false, raw, line: index + 1, blank: true }); continue; }
    let heading = 0;
    const headingMatch = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(working);
    if (headingMatch) { heading = headingMatch[1].length; working = headingMatch[2].replace(/\s+#+\s*$/, ''); }
    working = working.replace(/^\s*(?:>\s?)+/, '');
    working = working.replace(/^\s*(?:[-*+•·]|\d{1,3}[.)](?=\s+\D))\s+/, (match) => /\d/.test(match) && /^\s*\d{1,3}[.)]\s+(?:日|夜|內|外|INT|EXT)/i.test(working) ? match : '');
    const bold = /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*(?:[:：].*)?$/.test(working);
    let forced: BlockType | undefined;
    const noteMatch = /^\s*\[\[(.*)\]\]\s*$/.exec(working);
    if (noteMatch) { working = noteMatch[1]; forced = 'note'; }
    out.push({ text: stripInline(working), heading, bold, raw, line: index + 1, blank: false, forced });
  }
  return out;
}

function sceneScore(text: string): number {
  if (INT_EXT.test(text)) return 9;
  if (text.length > 60) return 0;
  let score = 0;
  const numbered = SCENE_NUMBER.exec(text);
  const rest = numbered ? text.slice(numbered[0].length) : text;
  if (numbered && INT_EXT.test(rest)) return 9;
  if (numbered && /[場场]/u.test(numbered[0])) score += 3;
  else if (numbered && rest.trim()) score += 1;
  if (SCENE_MARKER.test(text)) score += 3;
  if (/^[【\[].{1,40}[】\]]$/u.test(text)) score += 1;
  if (CN_PLACE_TOKEN.test(rest)) score += 2;
  if (CN_TIME_TOKEN.test(rest)) score += 2;
  if (/^(?:日|夜)(?:[\s　、·]|$)/u.test(rest.trim())) score += 1;
  if (Array.from(text).length <= 14 && CN_TIME_TOKEN.test(rest) && !TERMINAL.test(text)) score += 1;
  if (TERMINAL.test(text) && !/[）)]$/u.test(text)) score -= 3;
  if (/[，,].{8,}/u.test(text)) score -= 2;
  if (/[:：]\s*\S{6,}/u.test(text) && !numbered) score -= 2;
  return score;
}

function cleanSceneText(text: string): string {
  let value = text.replace(SCENE_MARKER, '').replace(/^[【\[]\s*|\s*[】\]]$/gu, '');
  if (!INT_EXT.test(value)) value = value.replace(SCENE_NUMBER, '');
  value = value.replace(/^(?:SC(?:ENE)?\s*\d+[A-Z]?\s*)/i, '');
  return value.replace(/^[.．。、:：\s]+/u, '').replace(/\s{2,}/g, ' ').trim() || text.trim();
}

interface InlineSpeech { name: string; paren?: string; line: string }
function inlineSpeech(text: string): InlineSpeech | null {
  const match = /^(?:@)?([^\s：:（）()「」『』"“”，,。]{1,24}?(?:\s+(?:V\.?O\.?|O\.?S\.?))?)\s*(?:[（(]([^）)]{1,24})[）)])?\s*[:：]\s*(.*)$/u.exec(text);
  if (!match) {
    const quoted = /^([^\s：:（）()「」『』"“”，,。]{1,8}?)\s*(?:[（(]([^）)]{1,24})[）)])?\s*[「“『"](.+)[」”』"]$/u.exec(text);
    return quoted ? { name: quoted[1], paren: quoted[2], line: quoted[3] } : null;
  }
  return { name: match[1], paren: match[2], line: match[3] };
}

function splitCast(list: string): string[] {
  return list.split(/[、，,;；/／|｜\s]+/u).map((item) => speakerKey(item.replace(/[（(].*?[）)]/gu, ''))).filter((item) => item && isPlausibleName(item));
}

function matchRule(text: string, memory: ImportMemory): ImportRule | undefined {
  let best: ImportRule | undefined;
  for (const rule of memory.rules) if (rule.prefix && text.startsWith(rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) best = rule;
  return best;
}

/** The part of a line a correction should generalise to: a leading symbol run or a short `關鍵字：`. */
export function lineSignature(source: string): string | null {
  const text = stripInline(source.replace(/^\s*(?:>\s?|#{1,6}\s+)*/, ''));
  const symbol = /^[^\p{L}\p{N}\s（(「『"“]+/u.exec(text);
  if (symbol && symbol[0].length <= 4) return symbol[0];
  const keyword = /^([^\s：:]{1,4})[:：]/u.exec(text);
  if (keyword) return `${keyword[1]}：`.replace(/：$/, text.includes('：') ? '：' : ':');
  return null;
}

export function smartImport(source: string, memory: ImportMemory = EMPTY_MEMORY, overrides: Record<string, BlockType> = {}): SmartImportResult {
  const metadata: Record<string, string> = {};
  const lines = preprocess(source, metadata);
  const notCharacters = new Set(memory.notCharacters.map(speakerKey));

  // ——— Pass 1: learn the cast from the file itself. ———
  const colonCounts = new Map<string, number>();
  const standaloneCounts = new Map<string, number>();
  const cast = new Set<string>();
  lines.forEach((line, index) => {
    if (line.blank || line.forced) return;
    const castMatch = CAST_LINE.exec(line.text);
    if (castMatch) { splitCast(castMatch[1]).forEach((name) => cast.add(name)); return; }
    const speech = inlineSpeech(line.text);
    if (speech && isPlausibleName(speech.name) && speech.line.trim()) {
      const key = speakerKey(speech.name);
      colonCounts.set(key, (colonCounts.get(key) ?? 0) + 1);
    }
    const next = lines[index + 1];
    const prev = lines[index - 1];
    if (next && !next.blank && (!prev || prev.blank) && line.text.length <= 30 && !TERMINAL.test(line.text.replace(VOICE_EXT, '')) && sceneScore(line.text) < 3) {
      if (isAllCapsName(line.text) || (line.bold && isPlausibleName(line.text)) || (/\p{Script=Han}/u.test(line.text) && Array.from(speakerKey(line.text)).length <= 4 && isPlausibleName(line.text))) {
        const key = speakerKey(line.text);
        standaloneCounts.set(key, (standaloneCounts.get(key) ?? 0) + 1);
      }
    }
  });
  const known = new Set<string>();
  for (const name of memory.characters) known.add(speakerKey(name));
  for (const name of cast) known.add(name);
  for (const [name, count] of colonCounts) if (count >= 2) known.add(name);
  for (const [name, count] of standaloneCounts) if (count >= 2 || /^[A-Z]/.test(name)) known.add(name);
  for (const name of notCharacters) known.delete(name);
  const isKnown = (raw: string) => known.has(speakerKey(raw));

  // ——— Pass 2: classify. ———
  const blocks: SmartBlock[] = [];
  let blankSince = true;
  let inlineSpeaker = false;
  let lineOrdinal = new Map<number, number>();
  const push = (line: CleanLine, type: BlockType, text: string, confidence: Confidence, reason: string, speaker?: string) => {
    const ordinal = lineOrdinal.get(line.line) ?? 0;
    lineOrdinal.set(line.line, ordinal + 1);
    const key = `${line.line}:${ordinal}`;
    const finalType = overrides[key] ?? type;
    blocks.push({ id: newId(), type: finalType, text, confidence: overrides[key] ? 'high' : confidence, reason: overrides[key] ? '你的修正' : reason, line: line.line, key, source: line.raw.trim(), speaker });
    blankSince = false;
  };
  const last = () => blocks.at(-1);
  const inDialogue = () => !blankSince && ['character', 'dialogue', 'parenthetical'].includes(last()?.type ?? '');
  const appendTo = (block: SmartBlock, text: string) => {
    const joiner = /[\p{Script=Han}，、（「『]$/u.test(block.text) || /^[\p{Script=Han}，。、！？）」』]/u.test(text) ? '' : ' ';
    block.text = TERMINAL.test(block.text) && block.type === 'dialogue' ? `${block.text}\n${text}` : `${block.text}${joiner}${text}`;
  };
  const emitSpeech = (line: CleanLine, name: string, paren: string | undefined, speech: string, confidence: Confidence, reason: string) => {
    const voice = VOICE_EXT.exec(name);
    const character = voice ? `${speakerKey(name)} (${voice[1].toUpperCase().replace(/\./g, '').replace(/^VO$/, 'V.O.').replace(/^OS$/, 'O.S.')})` : speakerKey(name);
    push(line, 'character', character, confidence, reason, speakerKey(name));
    inlineSpeaker = true;
    let dialogue = speech.trim().replace(/^[「“『"]([\s\S]*)[」”』"]$/u, '$1');
    if (paren && !/^(?:V\.?O\.?|O\.?S\.?|OS|VO)$/i.test(paren.trim())) push(line, 'parenthetical', `（${paren.trim()}）`, confidence, reason);
    else if (paren) blocks[blocks.length - 1].text = `${speakerKey(name)} (${paren.trim().toUpperCase()})`;
    const lead = /^[（(]([^）)]{1,30})[）)]\s*(.*)$/u.exec(dialogue);
    if (lead) { push(line, 'parenthetical', `（${lead[1]}）`, confidence, reason); dialogue = lead[2]; }
    if (dialogue) push(line, 'dialogue', dialogue, confidence, reason);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.blank) { blankSince = true; continue; }
    const text = line.text;
    if (!text) continue;
    const next = lines[index + 1];

    if (line.forced) { push(line, line.forced, text, 'high', '註解'); continue; }

    const rawLead = stripInline(line.raw.replace(/^\s*(?:>\s?|#{1,6}\s+)*/, ''));
    const rule = matchRule(text, memory) ?? matchRule(rawLead, memory);
    if (rule) {
      const body = /^[^\p{L}\p{N}]+$/u.test(rule.prefix) && text.startsWith(rule.prefix) ? text.slice(rule.prefix.length).trim() : text;
      if (rule.type === 'character' || rule.type === 'dialogue') {
        const speech = inlineSpeech(text);
        if (speech) { emitSpeech(line, speech.name, speech.paren, speech.line, 'high', '學到的規則'); continue; }
      }
      push(line, rule.type, body || text, 'high', `學到的規則「${rule.prefix}」`);
      continue;
    }

    // Fountain forced elements.
    if (/^\.(?!\.)\S/.test(text) && line.heading === 0) { push(line, 'scene', text.slice(1).trim(), 'high', 'Fountain 強制場景'); continue; }
    if (/^!\S/.test(text)) { push(line, 'action', text.slice(1).trim(), 'high', 'Fountain 強制動作'); continue; }
    if (/^@\S/.test(text)) { push(line, 'character', speakerKey(text.slice(1)), 'high', 'Fountain 強制角色', speakerKey(text.slice(1))); continue; }
    if (/^=\s*\S/.test(text) && !/^={2,}/.test(text)) { push(line, 'note', text.replace(/^=\s*/, ''), 'high', 'Fountain 大綱'); continue; }
    if (/^>.*<$/.test(text)) { push(line, 'titlecard', text.replace(/^>\s*|\s*<$/g, ''), 'high', '置中字卡'); continue; }

    const metaMatch = META_LINE.exec(text);
    if (metaMatch && blocks.length === 0) { metadata[text.split(/[:：]/)[0].trim()] = metaMatch[1].trim(); continue; }
    if (line.heading === 1 && blocks.filter((block) => block.type !== 'note').length === 0 && sceneScore(text) < 3 && !ACT_LINE.test(text)) { metadata.title ??= text; continue; }

    if (ACT_LINE.test(text) && text.length <= 40) { push(line, 'act', text, 'high', '幕／集標記'); continue; }
    if (TRANSITION_LINE.test(text)) { push(line, 'transition', text.replace(/^[—\-－=（(]+\s*|\s*[—\-－=）)]+$/gu, '') || text, 'high', '轉場詞'); continue; }

    const castMatch = CAST_LINE.exec(text);
    if (castMatch) { push(line, 'note', text, 'high', '人物表（已學習角色）'); continue; }

    const fieldMatch = SCENE_FIELD.exec(text);
    if (fieldMatch) {
      const previous = last();
      const key = text.split(/[:：]/)[0];
      if (/場景|场景|地點|地点|場次|场次/u.test(key) && !(previous?.type === 'scene' && !blankSince)) push(line, 'scene', fieldMatch[1].trim(), 'high', `「${key}」欄位`);
      else if (previous?.type === 'scene') previous.text = `${previous.text} - ${fieldMatch[1].trim()}`;
      else push(line, 'note', text, 'medium', `「${key}」欄位`);
      continue;
    }

    const score = line.heading ? sceneScore(text) + 1 : sceneScore(text);
    if (score >= 4 || (score >= 3 && (blankSince || line.heading))) {
      push(line, 'scene', cleanSceneText(text), score >= 5 ? 'high' : 'medium', INT_EXT.test(text) ? 'INT./EXT. 場景標題' : '場次／內外景／日夜');
      continue;
    }
    if (line.heading) { push(line, line.heading <= 2 ? 'act' : 'note', text, 'medium', 'Markdown 標題'); continue; }

    if (NOTE_LINE.test(text) || NOTE_MARKER.test(text)) { push(line, 'note', text.replace(NOTE_MARKER, ''), 'high', '備註'); continue; }
    if (ACTION_MARKER.test(text)) { push(line, 'action', text.replace(ACTION_MARKER, ''), 'high', '△ 動作標記'); continue; }
    if (CAPTION_LINE.test(text)) { push(line, 'action', text, 'high', '字幕／畫面'); continue; }
    if (SHOT_LINE.test(text) && text.length <= 40) { push(line, 'shot', text, 'high', '鏡頭語言'); continue; }

    const speech = inlineSpeech(text);
    if (speech && speech.line.trim() && isPlausibleName(speech.name) && !notCharacters.has(speakerKey(speech.name))) {
      const confident = isKnown(speech.name);
      if (confident || (Array.from(speakerKey(speech.name)).length <= 4 && speech.line.length <= 400)) {
        emitSpeech(line, speech.name, speech.paren, speech.line, confident ? 'high' : 'medium', confident ? `角色「${speakerKey(speech.name)}」` : '疑似「名字：台詞」');
        continue;
      }
    }

    // Standalone speaker line followed by dialogue (Fountain / screenplay layout).
    const nextHasText = next && !next.blank;
    if (nextHasText && text.length <= 30 && !TERMINAL.test(text.replace(VOICE_EXT, '')) && !notCharacters.has(speakerKey(text))) {
      const standalone = isAllCapsName(text) || (line.bold && isPlausibleName(text)) || isKnown(text) && (blankSince || !inDialogue());
      if (standalone && sceneScore(text) < 3) {
        inlineSpeaker = false;
        push(line, 'character', isAllCapsName(text) ? text.trim() : speakerKey(text) + (VOICE_EXT.exec(text) ? ` (${VOICE_EXT.exec(text)![1].toUpperCase()})` : ''), isKnown(text) || isAllCapsName(text) ? 'high' : 'medium', '角色名獨立一行', speakerKey(text));
        continue;
      }
    }

    if (/^[（(][^）)]{1,60}[）)]$/u.test(text)) {
      push(line, inDialogue() ? 'parenthetical' : 'action', text, inDialogue() ? 'high' : 'medium', inDialogue() ? '對白中的括號指示' : '獨立括號');
      continue;
    }

    if (inDialogue() && !/^[^\p{L}\p{N}（(「『"“‘'…—]/u.test(text)) {
      const previous = last()!;
      const lead = /^[（(]([^）)]{1,30})[）)]\s*(.+)$/u.exec(text);
      // One-line `名字：台詞` style: a narrative sentence on the next line is action, not more dialogue.
      const narrative = inlineSpeaker && previous.type === 'dialogue' && TERMINAL.test(previous.text)
        && !/[？?！!」”』"]$/u.test(text) && Array.from(text).length > 8;
      if (narrative) { push(line, 'action', text, 'medium', '對白後的敘述'); continue; }
      if (lead && previous.type !== 'dialogue') {
        push(line, 'parenthetical', `（${lead[1]}）`, previous.confidence, '對白中的括號指示');
        push(line, 'dialogue', lead[2], previous.confidence, '接在角色之後');
      } else if (previous.type === 'dialogue') appendTo(previous, text);
      else push(line, 'dialogue', text.replace(/^[「“『"]([\s\S]*)[」”』"]$/u, '$1'), previous.confidence, '接在角色之後');
      continue;
    }

    const previous = last();
    if (previous?.type === 'action' && !blankSince && !TERMINAL.test(previous.text) && previous.line === line.line - 1) {
      appendTo(previous, text);
      continue;
    }
    const looksLikeSpeech = /^[^\s，。]{1,6}[:：]/u.test(text);
    push(line, 'action', text, looksLikeSpeech ? 'low' : 'high', looksLikeSpeech ? '可能是對白，請確認' : '敘述／動作');
  }

  // Drop characters with no following dialogue into action when they are plainly not speakers.
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== 'character') continue;
    const following = blocks[index + 1];
    if (!following || !['dialogue', 'parenthetical'].includes(following.type)) {
      if (block.confidence !== 'high') { block.type = 'action'; block.reason = '角色名後沒有對白'; block.confidence = 'low'; }
    }
  }

  const lineCounts = new Map<string, number>();
  let dialogues = 0;
  blocks.forEach((block, index) => {
    if (block.type === 'dialogue') {
      dialogues += 1;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (blocks[cursor].type === 'character') { const name = speakerKey(blocks[cursor].text); lineCounts.set(name, (lineCounts.get(name) ?? 0) + 1); break; }
        if (!['parenthetical', 'dialogue'].includes(blocks[cursor].type)) break;
      }
    }
  });
  for (const name of cast) if (!lineCounts.has(name)) lineCounts.set(name, 0);
  const characters = [...lineCounts].map(([name, count]) => ({ name, lines: count })).sort((a, b) => b.lines - a.lines);
  const scenes = blocks.filter((block) => block.type === 'scene').length;
  const format = /^\s*(?:INT|EXT)[.\s]/im.test(source) ? '美式劇本／Fountain'
    : scenes && dialogues ? '中文劇本'
      : dialogues ? '對白稿'
        : /^#{1,6}\s/m.test(source) ? 'Markdown 筆記' : '散文／大綱';
  return {
    blocks, metadata, characters, format,
    stats: { scenes, characters: characters.length, dialogues, lowConfidence: blocks.filter((block) => block.confidence === 'low').length, sourceLines: lines.filter((line) => !line.blank).length },
  };
}

const uniq = (list: string[]) => [...new Set(list.filter(Boolean))];

/** Fold one user correction into memory so that every similar line — now and in future files — follows it. */
export function learnFromCorrection(memory: ImportMemory, block: SmartBlock, type: BlockType): ImportMemory {
  let characters = memory.characters;
  let notCharacters = memory.notCharacters;
  let rules = memory.rules;
  const name = block.speaker ?? (block.type === 'character' ? speakerKey(block.text) : '');
  if (type === 'character') {
    const key = speakerKey(block.text);
    characters = uniq([...characters, key]);
    notCharacters = notCharacters.filter((item) => item !== key);
  } else if (name && (block.type === 'character' || block.speaker) && !['dialogue', 'parenthetical'].includes(type)) {
    notCharacters = uniq([...notCharacters, name]);
    characters = characters.filter((item) => item !== name);
  }
  const signature = lineSignature(block.source);
  if (signature && !(type === 'character' && block.speaker)) {
    rules = [...rules.filter((rule) => rule.prefix !== signature), { prefix: signature, type, hits: 0 }].slice(-500);
  }
  return { characters: characters.slice(-2000), notCharacters: notCharacters.slice(-2000), rules, corrections: memory.corrections + 1 };
}

/** After a confirmed import, remember the cast so the next file starts smarter. */
export function learnFromImport(memory: ImportMemory, result: SmartImportResult): ImportMemory {
  const confirmed = result.characters.filter((item) => item.lines >= 2).map((item) => item.name);
  return { ...memory, characters: uniq([...memory.characters, ...confirmed]).slice(-2000) };
}

export function toBlocks(result: SmartImportResult): Block[] {
  return markMessages(result.blocks.map(({ id, type, text }) => ({ id, type, text })));
}
