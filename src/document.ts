import type { Block, BlockType, Claim, Entity, Project, Thread } from './types';

const VALID_BLOCK_TYPES = ['scene', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'shot', 'act', 'note', 'message', 'titlecard'] as const;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export function parsePlainText(source: string): Block[] {
  return source
    .replace(/\r\n?/g, '\n')
    .split(/\n[\t ]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((text) => ({ id: newId(), type: 'action' as const, text }));
}

export type TextFormat = 'markdown' | 'fountain' | 'plain';

interface MarkdownParagraph {
  lines: string[];
  fenced: boolean;
}

function stripYamlFrontmatter(source: string): string[] {
  const lines = source.replace(/^\uFEFF/, '').split('\n');
  let firstContent = 0;
  while (firstContent < lines.length && !lines[firstContent].trim()) firstContent += 1;
  if (!/^[\t ]*---[\t ]*$/.test(lines[firstContent] ?? '')) return lines;

  const closing = lines.findIndex((line, index) => index > firstContent && /^[\t ]*(?:---|\.\.\.)[\t ]*$/.test(line));
  // An unclosed front matter prefix is not screenplay text; import UI keeps and warns on the original source.
  return closing < 0 ? [] : lines.slice(closing + 1);
}

function stripMarkdownComments(lines: string[]): string[] {
  const output: string[] = [];
  let inComment = false;
  let fence: string | null = null;

  for (const sourceLine of lines) {
    if (fence) {
      output.push(sourceLine);
      const marker = sourceLine.trim();
      const fenceCharacter = fence[0];
      if (marker.length >= fence.length && marker[0] === fenceCharacter && [...marker].every((character) => character === fenceCharacter)) fence = null;
      continue;
    }
    const openingFence = sourceLine.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (openingFence) {
      fence = openingFence[1];
      output.push(sourceLine);
      continue;
    }

    let line = sourceLine;
    if (inComment) {
      const close = line.indexOf('-->');
      if (close < 0) { output.push(''); continue; }
      line = line.slice(close + 3);
      inComment = false;
    }
    let clean = '';
    let cursor = 0;
    while (cursor < line.length) {
      const start = line.indexOf('<!--', cursor);
      if (start < 0) { clean += line.slice(cursor); break; }
      clean += line.slice(cursor, start);
      const close = line.indexOf('-->', start + 4);
      if (close < 0) { inComment = true; cursor = line.length; break; }
      cursor = close + 3;
    }
    output.push(clean);
  }
  return output;
}

function splitMarkdownParagraphs(lines: string[]): MarkdownParagraph[] {
  const paragraphs: MarkdownParagraph[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = (fenced = false) => {
    if (current.length) paragraphs.push({ lines: current, fenced });
    current = [];
  };

  for (const line of lines) {
    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!fence && opening) {
      flush();
      fence = opening[1];
      current = [line];
      continue;
    }
    if (fence) {
      current.push(line);
      const marker = line.trim();
      const fenceCharacter = fence[0];
      if (marker.length >= fence.length && marker[0] === fenceCharacter && [...marker].every((character) => character === fenceCharacter)) {
        flush(true);
        fence = null;
      }
      continue;
    }
    if (!line.trim()) flush();
    else current.push(line);
  }
  flush(fence !== null);
  return paragraphs;
}

function stripBlockquotePrefix(line: string): string {
  return line.replace(/^\s{0,3}(?:>\s?)+/, '').trim();
}

function stripMarkdownEmphasis(text: string): string {
  return text.replace(/(\*\*|__)(.*?)\1/g, '$2').trim();
}

const SCENE_LOCATION = /^(?:INT\.?\s*\/\s*EXT\.?|I\s*\/\s*E\.?|INT\.?|EXT\.?|EST\.?|內外景|內[\/／]外景|內景|外景|日內|夜內|日外|夜外|室內|室外)(?=$|[\s\u3000:：、，,.\/／\-—–（(])/iu;
const SCENE_NUMBER = /^(?:(?:SC(?:ENE)?\s*[\d０-９]+(?:[.-][\d０-９]+)?)|(?:第\s*[\d０-９一二三四五六七八九十百]+\s*場)|(?:場景\s*[\d０-９一二三四五六七八九十百]*))(?=[\s\u3000.、:：|｜\-—–]|$)[\s\u3000.、:：|｜\-—–]*/iu;

function isSceneHeading(text: string): boolean {
  const cleaned = stripMarkdownEmphasis(text).replace(/\s+#+\s*$/, '').trim();
  return SCENE_LOCATION.test(cleaned.replace(SCENE_NUMBER, '').trimStart());
}

function headingFromLine(line: string): { level: number; text: string } | null {
  const match = stripBlockquotePrefix(line).match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return null;
  return { level: match[1].length, text: stripMarkdownEmphasis(match[2]).trim() };
}

function isSpeakerName(value: string): boolean {
  const name = stripMarkdownEmphasis(value);
  return name.length > 0
    && Array.from(name).length <= 40
    && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\s.'’‘()_\/\-·・&]*$/u.test(name);
}

interface SpeakerLine {
  name: string;
  dialogue: string;
}

function speakerLine(line: string): SpeakerLine | null {
  const match = stripBlockquotePrefix(line).match(/^(?:\*\*([^*\n]+)\*\*|__([^_\n]+)__)\s*[:：]\s*(.*)$/u);
  if (!match) return null;
  const name = (match[1] ?? match[2] ?? '').trim();
  if (!isSpeakerName(name)) return null;
  return { name: stripMarkdownEmphasis(name), dialogue: match[3].trim() };
}

function standaloneBoldName(line: string): string | null {
  const match = stripBlockquotePrefix(line).match(/^(?:\*\*([^*\n]+)\*\*|__([^_\n]+)__)$/u);
  const name = (match?.[1] ?? match?.[2] ?? '').trim();
  return match && isSpeakerName(name) ? stripMarkdownEmphasis(name) : null;
}

function isParenthetical(text: string): boolean {
  const value = stripMarkdownEmphasis(text.trim());
  return /^(?:\([^()\n]*\)|（[^（）\n]*）|\[[^\[\]\n]*\]|【[^【】\n]*】)$/u.test(value);
}

function hasFollowingSpeakerContent(paragraphs: MarkdownParagraph[], paragraphIndex: number, lineIndex: number): boolean {
  for (let p = paragraphIndex; p < paragraphs.length; p += 1) {
    if (paragraphs[p].fenced) return false;
    const start = p === paragraphIndex ? lineIndex + 1 : 0;
    for (let l = start; l < paragraphs[p].lines.length; l += 1) {
      const candidate = stripBlockquotePrefix(paragraphs[p].lines[l]);
      if (!candidate) continue;
      if (headingFromLine(candidate) || speakerLine(candidate) || standaloneBoldName(candidate)) return false;
      return true;
    }
  }
  return false;
}

/** Parse Markdown screenplay conventions while keeping unclear text as editable action. */
export function parseMarkdown(source: string): Block[] {
  const lines = stripMarkdownComments(stripYamlFrontmatter(source.replace(/\r\n?/g, '\n')));
  const paragraphs = splitMarkdownParagraphs(lines);
  const blocks: Block[] = [];
  let previousParagraph = -1;
  let speakerPending = false;

  const add = (type: BlockType, text: string, paragraphIndex: number, append = false) => {
    const value = text.trim();
    if (!value) return;
    const previous = blocks.at(-1);
    if (append && previous?.type === type && previousParagraph === paragraphIndex) {
      previous.text += `\n${value}`;
    } else {
      blocks.push({ id: newId(), type, text: value });
    }
    previousParagraph = paragraphIndex;
  };

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    if (paragraph.fenced) {
      speakerPending = false;
      add('action', paragraph.lines.join('\n'), paragraphIndex);
      continue;
    }

    let paragraphDialogue = false;
    for (let lineIndex = 0; lineIndex < paragraph.lines.length; lineIndex += 1) {
      const line = paragraph.lines[lineIndex];
      const content = stripBlockquotePrefix(line);
      if (!content) continue;

      const heading = headingFromLine(line);
      if (heading) {
        if (heading.text) add(heading.level === 2 && isSceneHeading(heading.text) ? 'scene' : 'act', heading.text, paragraphIndex);
        speakerPending = false;
        paragraphDialogue = false;
        continue;
      }

      if (isSceneHeading(content)) {
        add('scene', content, paragraphIndex);
        speakerPending = false;
        paragraphDialogue = false;
        continue;
      }

      const inlineSpeaker = speakerLine(line);
      if (inlineSpeaker) {
        add('character', inlineSpeaker.name, paragraphIndex);
        if (!inlineSpeaker.dialogue) {
          speakerPending = true;
          paragraphDialogue = false;
        } else if (isParenthetical(inlineSpeaker.dialogue)) {
          add('parenthetical', inlineSpeaker.dialogue, paragraphIndex);
          speakerPending = true;
          paragraphDialogue = false;
        } else {
          add('dialogue', inlineSpeaker.dialogue, paragraphIndex);
          speakerPending = false;
          paragraphDialogue = true;
        }
        continue;
      }

      const boldName = standaloneBoldName(line);
      if (boldName && hasFollowingSpeakerContent(paragraphs, paragraphIndex, lineIndex)) {
        add('character', boldName, paragraphIndex);
        speakerPending = true;
        paragraphDialogue = false;
        continue;
      }

      if (speakerPending && isParenthetical(content)) {
        add('parenthetical', stripMarkdownEmphasis(content), paragraphIndex);
        paragraphDialogue = false;
      } else if (speakerPending) {
        add('dialogue', content, paragraphIndex, true);
        speakerPending = false;
        paragraphDialogue = true;
      } else if (paragraphDialogue) {
        add('dialogue', content, paragraphIndex, true);
      } else {
        add('action', content, paragraphIndex, true);
      }
    }
  }
  return blocks;
}

export function detectTextFormat(source: string, fileName = ''): TextFormat {
  const name = fileName.toLowerCase();
  if (/\.fountain$/.test(name)) return 'fountain';
  if (/\.(?:md|markdown)$/.test(name)) return 'markdown';

  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^\s*---[\t ]*$/m.test(text)
    || /^\s{0,3}#{1,6}\s+\S/m.test(text)
    || /^\s{0,3}>\s*(?:\*\*|__)/m.test(text)
    || /^\s{0,3}(?:\*\*|__)[^\n]+(?:\*\*|__)\s*[:：]/m.test(text)) return 'markdown';
  if (/^\s*\.(?!\.)(?:INT\.?|EXT\.?|EST\.?|I\/E\.?|INT\.?\/EXT\.?|\S)/im.test(text)) return 'fountain';
  return 'plain';
}

export function parseText(source: string, fileName = ''): Block[] {
  const format = detectTextFormat(source, fileName);
  if (format === 'markdown') return markMessages(parseMarkdown(source));
  if (format === 'fountain') return markMessages(parseFountain(source));
  return markMessages(parsePlainText(source));
}

/** Action paragraphs written as 【微信】角色：… become chat-message blocks. */
export function markMessages<T extends Block>(blocks: T[]): T[] {
  return blocks.map((block) => block.type === 'action' && MESSAGE_MARK.test(block.text.trim().replace(/^!/, '')) ? { ...block, type: 'message', text: block.text.trim().replace(/^!/, '') } : block);
}

export function parseFountain(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let lastType: BlockType | null = null;
  let isBlank = true;
  let inComment = false;

  const add = (type: BlockType, text: string) => {
    blocks.push({ id: newId(), type, text });
    lastType = type;
  };
  const append = (type: 'action' | 'dialogue', text: string) => {
    const previous = blocks.at(-1);
    if (!isBlank && previous?.type === type) previous.text += `\n${text}`;
    else add(type, text);
    lastType = type;
  };

  for (const original of lines) {
    const trimmed = original.trim();
    if (inComment || trimmed.startsWith('/*')) {
      inComment = !trimmed.includes('*/');
      continue;
    }
    if (!trimmed || trimmed.startsWith('//')) {
      isBlank = true;
      lastType = null;
      continue;
    }
    if (/^(title|credit|author|authors|source|draft date|contact|copyright|notes|revision|date):/i.test(trimmed)) continue;

    if (trimmed.startsWith('.') && !trimmed.startsWith('...')) {
      add('scene', trimmed.slice(1).trim());
    } else if (/^>.*<$/u.test(trimmed)) {
      add('titlecard', trimmed.slice(1, -1).trim());
    } else if (/^>\s*/.test(trimmed)) {
      add('transition', trimmed.replace(/^>\s*/, '').trim());
    } else if (/^#{1,6}\s+/.test(trimmed)) {
      add('act', trimmed.replace(/^#{1,6}\s+/, '').trim());
    } else if (/^(INT\.?|EXT\.?|EST\.?|INT\.?\/EXT\.?|I\/E\.)\b/i.test(trimmed)) {
      add('scene', trimmed);
    } else if (/^(?:CUT TO:?|SMASH CUT TO:?|MATCH CUT TO:?|FADE (?:IN|OUT)\.?|DISSOLVE TO:?|WIPE TO:?)$/i.test(trimmed)) {
      add('transition', trimmed);
    } else if (/^ACT\s+(?:[0-9]+|[IVX]+|ONE|TWO|THREE|FOUR|FIVE)\b/i.test(trimmed)) {
      add('act', trimmed);
    } else {
      const cue = trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
      const upperCue = /^[A-Z][A-Z0-9 ._'’()\-]*$/.test(cue) && /[A-Z]/.test(cue) && cue.length <= 40;
      const isCharacter = trimmed.startsWith('@') || (upperCue && !/^(INT|EXT|EST)\./.test(cue));
      if (isCharacter) {
        add('character', cue);
      } else if (/^\(.*\)$/.test(trimmed) && ['character', 'dialogue', 'parenthetical'].includes(lastType ?? '')) {
        add('parenthetical', trimmed);
      } else if (['character', 'dialogue', 'parenthetical'].includes(lastType ?? '')) {
        append('dialogue', trimmed);
      } else {
        append('action', trimmed);
      }
    }
    isBlank = false;
  }
  return blocks;
}

export function isProjectData(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false;
  const project = value as Record<string, unknown>;
  if (typeof project.id !== 'string' || typeof project.title !== 'string' || typeof project.updatedAt !== 'string') return false;
  if (!Array.isArray(project.blocks) || !Array.isArray(project.entities) || !Array.isArray(project.claims) || !Array.isArray(project.threads)) return false;
  const blocksOk = project.blocks.every((item) => isRecord(item) && typeof item.id === 'string' && VALID_BLOCK_TYPES.includes(item.type as BlockType) && typeof item.text === 'string');
  const entitiesOk = project.entities.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.aliases) && item.aliases.every((alias) => typeof alias === 'string') && typeof item.description === 'string');
  const claimsOk = project.claims.every((item) => {
    if (!isRecord(item)) return false;
    const sourceRefOk = item.sourceRef === undefined || (isRecord(item.sourceRef) && typeof item.sourceRef.documentId === 'string' && typeof item.sourceRef.title === 'string' && typeof item.sourceRef.excerpt === 'string' && optionalString(item.sourceRef.locator));
    return typeof item.id === 'string' && typeof item.text === 'string' && ['candidate', 'confirmed', 'archived'].includes(String(item.status)) && optionalString(item.sourceBlockId) && optionalString(item.characterId) && sourceRefOk;
  });
  const threadsOk = project.threads.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' && ['open', 'progress', 'resolved', 'abandoned'].includes(String(item.status)) && optionalString(item.setupBlockId) && optionalString(item.payoffBlockId));
  const relationsOk = project.relations === undefined || (Array.isArray(project.relations) && project.relations.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.from === 'string' && typeof item.to === 'string' && typeof item.type === 'string'));
  const mindmapOk = project.mindmap === undefined || isMindNode(project.mindmap, 0);
  const titleOk = project.titlePage === undefined || (isRecord(project.titlePage) && Object.entries(project.titlePage).every(([key, value]) => key === 'print' ? typeof value === 'boolean' : typeof value === 'string'));
  const metaOk = project.sceneMeta === undefined || isRecord(project.sceneMeta);
  const commentsOk = project.comments === undefined || (Array.isArray(project.comments) && project.comments.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.blockId === 'string' && typeof item.text === 'string'));
  const settingsOk = project.settings === undefined || (isRecord(project.settings) && ['us-screenplay', 'taiwan-work'].includes(String(project.settings.preset)) && (project.settings.showActHeadings === undefined || typeof project.settings.showActHeadings === 'boolean'));
  const dismissedOk = project.dismissedIdentitySuggestions === undefined || (Array.isArray(project.dismissedIdentitySuggestions) && project.dismissedIdentitySuggestions.every((key) => typeof key === 'string'));
  const ignoredOk = project.ignoredStoryCandidates === undefined || (Array.isArray(project.ignoredStoryCandidates) && project.ignoredStoryCandidates.every((key) => typeof key === 'string'));
  const hiddenLocationsOk = project.hiddenLocations === undefined || (Array.isArray(project.hiddenLocations) && project.hiddenLocations.every((location) => typeof location === 'string'));
  const storyOutlineOk = project.storyOutline === undefined || (isRecord(project.storyOutline)
    && Object.entries(project.storyOutline).every(([field, text]) => ['logline', 'synopsis', 'core'].includes(field) && typeof text === 'string'));
  const characterDraftsOk = project.characterDrafts === undefined || (Array.isArray(project.characterDrafts) && project.characterDrafts.every((draft) => isRecord(draft)
    && typeof draft.id === 'string' && isRecord(draft.fields)
    && (draft.touched === undefined || typeof draft.touched === 'boolean')
    && Object.entries(draft.fields).every(([field, item]) => (field === 'name' || ['age', 'role', 'look', 'personality', 'want', 'need', 'flaw', 'arc', 'backstory', 'notes'].includes(field)) && typeof item === 'string')));
  return blocksOk && entitiesOk && claimsOk && threadsOk && relationsOk && mindmapOk && titleOk && metaOk && commentsOk && settingsOk && dismissedOk && ignoredOk && hiddenLocationsOk && storyOutlineOk && characterDraftsOk;
}

function isMindNode(value: unknown, depth: number): boolean {
  return depth < 24 && isRecord(value) && typeof value.id === 'string' && typeof value.text === 'string'
    && Array.isArray(value.children) && value.children.every((child: unknown) => isMindNode(child, depth + 1));
}

export function validateProjectData(value: unknown): Project {
  if (!isProjectData(value)) throw new Error('JSON project 格式錯誤：project、blocks、entities、claims 或 threads 欄位不符合規範。');
  return value;
}

export interface EditorKeyEvent {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
}

export type EditorIntent = 'split-block' | 'next-block' | 'previous-block';
const BLOCK_AFTER_ENTER: Record<BlockType, BlockType> = {
  scene: 'action', action: 'action', character: 'dialogue', dialogue: 'action', parenthetical: 'dialogue',
  transition: 'scene', shot: 'action', act: 'scene', note: 'note', message: 'message', titlecard: 'action',
};

export function getBlockTypeAfterEnter(type: BlockType): BlockType {
  return BLOCK_AFTER_ENTER[type];
}

export function getEditorIntent(event: EditorKeyEvent): EditorIntent | null {
  if (event.isComposing || event.keyCode === 229 || event.which === 229) return null;
  if (event.key === 'Enter' && !event.shiftKey) return 'split-block';
  // Shift+Enter stays native (newline); Tab is reserved for the scene ghost UI.
  return null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function createEmptyProject(title: string, id = newId()): Project {
  return {
    id,
    title: title.trim() || '未命名劇本',
    updatedAt: new Date().toISOString(),
    blocks: [{ id: newId(), type: 'scene', text: '' }],
    entities: [],
    claims: [],
    threads: [],
  };
}

export function blocksToFountain(blocks: Block[]): string {
  const lines: string[] = [];
  let previousType: BlockType | null = null;
  for (const block of blocks) {
    if (!block.text.trim()) continue;
    if ((previousType === 'character' && ['parenthetical', 'dialogue'].includes(block.type))
      || (previousType === 'parenthetical' && block.type === 'dialogue')
      || (previousType === 'dialogue' && ['dialogue', 'parenthetical'].includes(block.type))) lines.pop();
    let text = block.text.trim();
    if (block.type === 'scene' && !/^(INT\.?|EXT\.?|EST\.?|INT\.?\/EXT\.?|I\/E\.)/i.test(text)) text = `.${text}`;
    else if (block.type === 'character') text = `@${text}`;
    else if (block.type === 'transition' && !/^>/.test(text)) text = `> ${text}`;
    else if (block.type === 'act') text = `# ${text}`;
    else if (block.type === 'titlecard') text = `>${text}<`;
    else if (block.type === 'message') text = `!${messageText(text)}`;
    lines.push(text);
    lines.push('');
    previousType = block.type;
  }
  return lines.join('\n').trimEnd();
}

export function blocksToPlainText(blocks: Block[]): string {
  return blocks.filter((block) => block.text.trim()).map((block) => block.type === 'message' ? messageText(block.text.trim()) : block.text.trim()).join('\n\n');
}

export function blocksToMarkdown(blocks: Block[]): string {
  return blocks.filter((block) => block.text.trim()).map((block) => block.type === 'titlecard' ? `**${block.text.trim()}**` : block.type === 'scene' ? `## ${block.text.trim()}` : block.type === 'message' ? messageText(block.text.trim()) : block.text.trim()).join('\n\n');
}

/** Chat / text-message lines are written as 【訊息】角色：內容 when they leave SceneForge. */
export const MESSAGE_MARK = /^【(訊息|簡訊|短信|微信|LINE|聊天|私訊|留言)】/;
export function messageText(text: string): string {
  const trimmed = text.trim();
  return /^【[^】]{1,6}】/.test(trimmed) ? trimmed : `【訊息】${trimmed}`;
}

export function countScriptLength(blocks: ReadonlyArray<{ text: string }>): number {
  return blocks.reduce((total, block) => total + Array.from(block.text.replace(/\s/gu, '')).length, 0);
}

export type StoryRecord = Entity | Claim | Thread;
