import type { Block, BlockType } from './types';

export interface MarkdownImportWarning {
  line: number;
  content: string;
  reason: string;
}
export interface MarkdownSourceLine {
  id: string;
  line: number;
  endLine: number;
}
export interface MarkdownImportResult {
  blocks: Block[];
  warnings: MarkdownImportWarning[];
  lineMap: MarkdownSourceLine[];
  metadata: Record<string, string>;
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const sceneLine = /^(?:INT(?:\/EXT)?|EXT|EST|I\/E)\.?\s+/i;
const parentheticalLine = /^[（(].*[）)]$/;

function speakerName(value: string): string | null {
  const name = value.trim();
  if (!name || Array.from(name).length > 24) return null;
  if (!/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}·・._'’ -]*$/u.test(name)) return null;
  if (/^(?:HTTP|HTTPS|URL)$/i.test(name)) return null;
  return name;
}

function boldSpeakerLine(text: string): { name: string; dialogue: string } | null {
  const match = /^(?:\*\*([^*\n]+)\*\*|__([^_\n]+)__)(?:\s*[:：]\s*(.*))?$/u.exec(text);
  if (!match) return null;
  const name = speakerName(match[1] ?? match[2] ?? '');
  return name ? { name, dialogue: match[3]?.trim() ?? '' } : null;
}

function removeHtmlComment(lines: string[], startLine: number, startColumn: number) {
  let endLine = startLine;
  let endColumn = -1;
  let searchFrom = startColumn + 4;
  for (; endLine < lines.length; endLine += 1) {
    const close = lines[endLine].indexOf('-->', searchFrom);
    if (close >= 0) { endColumn = close; break; }
    searchFrom = 0;
  }
  const closed = endColumn >= 0;
  const actualEndLine = closed ? endLine : lines.length - 1;
  const source = lines.slice(startLine, actualEndLine + 1).map((line, offset) => {
    if (offset === 0) return line.slice(startColumn, line.length);
    if (closed && startLine + offset === actualEndLine) return line.slice(0, endColumn + 3);
    return line;
  }).join('\n');
  const prefix = lines[startLine].slice(0, startColumn);
  const suffix = closed ? lines[actualEndLine].slice(endColumn + 3) : '';
  if (actualEndLine === startLine) {
    lines[startLine] = `${prefix}${suffix}`;
  } else {
    lines[startLine] = prefix;
    for (let index = startLine + 1; index < actualEndLine; index += 1) lines[index] = '';
    lines[actualEndLine] = suffix;
  }
  return { source, endLine: actualEndLine + 1, closed };
}

export function parseMarkdownScript(source: string): MarkdownImportResult {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const warnings: MarkdownImportWarning[] = [];
  const lineMap: MarkdownSourceLine[] = [];
  const metadata: Record<string, string> = {};
  const add = (type: BlockType, text: string, line: number, endLine = line) => {
    const block = { id: newId(), type, text };
    blocks.push(block);
    lineMap.push({ id: block.id, line, endLine });
  };
  const warn = (line: number, content: string, reason: string) => warnings.push({ line, content, reason });

  let index = 0;
  let firstContent = 0;
  while (firstContent < lines.length && !lines[firstContent].trim()) firstContent += 1;
  if (lines[firstContent]?.trim() === '---') {
    let close = firstContent + 1;
    while (close < lines.length && lines[close].trim() !== '---' && lines[close].trim() !== '...') close += 1;
    const closed = close < lines.length;
    const yamlEnd = closed ? close : lines.length;
    const yaml = lines.slice(firstContent + 1, yamlEnd).join('\n').trimEnd();
    for (const yamlLine of lines.slice(firstContent + 1, yamlEnd)) {
      const field = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(yamlLine);
      if (field) metadata[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, '');
    }
    const endLine = closed ? close + 1 : lines.length;
    const frontMatter = lines.slice(firstContent, endLine).join('\n');
    warn(firstContent + 1, frontMatter, closed
      ? 'YAML front matter 已保留為匯入中繼資料，不會寫入劇本。'
      : 'YAML front matter 缺少結尾標記；已保留可辨識欄位為匯入中繼資料，不會寫入劇本。請核對或下載原始來源。');
    index = closed ? close + 1 : lines.length;
  }

  let pendingSpeakerLine: number | null = null;
  const warnMissingDialogue = () => {
    if (pendingSpeakerLine === null) return;
    const line = pendingSpeakerLine;
    warn(line, lines[line - 1] ?? '', '粗體角色標示後未找到可辨識的對白；角色名已保留，請在匯入預覽核對原始來源。');
    pendingSpeakerLine = null;
  };

  while (index < lines.length) {
    let line = index + 1;
    let raw = lines[index];
    let trimmed = raw.trim();
    if (!trimmed) { index += 1; continue; }

    const commentColumn = raw.indexOf('<!--');
    if (commentColumn >= 0) {
      const comment = removeHtmlComment(lines, index, commentColumn);
      warn(line, comment.source, comment.closed
        ? 'Markdown HTML 註解／版本註記不是劇本內容，未匯入；原始來源可在本視窗查看或下載。'
        : 'Markdown HTML 註解未閉合，註解內容未匯入；原始來源可在本視窗查看或下載。');
      if (comment.endLine > line && lines[comment.endLine - 1]?.trim()) index = comment.endLine - 1;
      else if (!lines[index]?.trim()) index = comment.endLine;
      continue;
    }

    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      const marker = trimmed.slice(0, 3);
      const code = [raw];
      let endLine = line;
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) {
        code.push(lines[index]);
        endLine = index + 1;
        index += 1;
      }
      if (index < lines.length) { code.push(lines[index]); endLine = index + 1; }
      warnMissingDialogue();
      add('action', code.join('\n'), line, endLine);
      warn(line, raw, '程式碼區塊用途不明，原文保留為動作段落。');
      index += 1;
      continue;
    }

    let content = trimmed;
    const heading = /^(#{1,6})\s+(.+)$/.exec(content);
    if (heading) {
      content = heading[2].trim();
      content = content.replace(/^(?:SC(?:ENE)?\s*0*\d+[\s.:：-]*)/i, '');
      if (/^(?:第一幕|第二幕|第三幕|序幕|尾聲|ACT\s+(?:\d+|[IVX]+))\b/i.test(content)) {
        warnMissingDialogue();
        add('act', content, line);
      } else if (sceneLine.test(content)) {
        warnMissingDialogue();
        add('scene', content, line);
      } else {
        warnMissingDialogue();
        add('act', content, line);
        if (!/^(?:第一幕|第二幕|第三幕|序幕|尾聲|ACT\b)/i.test(content)) warn(line, raw, '標題未辨識為場景或幕標題，保留為幕標題。');
      }
      index += 1;
      continue;
    }

    const quoted = /^>\s*(.*)$/.exec(content);
    if (quoted) {
      const quoteText = quoted[1].trim();
      const cue = /^\*\*([^*]+)\*\*\s*[:：]\s*(.*)$/.exec(quoteText);
      if (cue) {
        warnMissingDialogue();
        add('character', cue[1].trim(), line);
        if (cue[2].trim()) add('dialogue', cue[2].trim(), line);
        else pendingSpeakerLine = line;
      } else if (parentheticalLine.test(quoteText)) {
        add('parenthetical', quoteText, line);
      } else if (pendingSpeakerLine !== null) {
        add('dialogue', quoteText, line);
        pendingSpeakerLine = null;
      } else {
        warnMissingDialogue();
        add('action', quoteText, line);
        if (!sceneLine.test(quoteText)) warn(line, raw, '引用區塊用途不明，原文保留為動作段落。');
      }
      index += 1;
      continue;
    }

    if (sceneLine.test(content)) {
      warnMissingDialogue();
      add('scene', content.replace(/\*\*/g, ''), line);
      index += 1;
      continue;
    }
    if (parentheticalLine.test(content)) {
      add('parenthetical', content, line);
      index += 1;
      continue;
    }

    const boldSpeaker = boldSpeakerLine(content);
    if (boldSpeaker) {
      warnMissingDialogue();
      add('character', boldSpeaker.name, line);
      if (boldSpeaker.dialogue) {
        if (parentheticalLine.test(boldSpeaker.dialogue)) {
          add('parenthetical', boldSpeaker.dialogue, line);
          pendingSpeakerLine = line;
        } else add('dialogue', boldSpeaker.dialogue, line);
      } else pendingSpeakerLine = line;
      index += 1;
      continue;
    }

    if (!/^\*\*/.test(content)) {
      const cue = /^([\p{Script=Han}A-Z][\p{Script=Han}A-Z0-9·._'’ -]{0,23})\s*[:：]\s*(.*)$/u.exec(content);
      if (cue && speakerName(cue[1])) {
        warnMissingDialogue();
        add('character', cue[1].trim(), line);
        if (cue[2].trim()) add('dialogue', cue[2].trim(), line);
        else pendingSpeakerLine = line;
        index += 1;
        continue;
      }
    }

    if (pendingSpeakerLine !== null) {
      add('dialogue', content, line);
      pendingSpeakerLine = null;
    } else add('action', content, line);
    if (/^(?:[-*+]\s|\d+[.)]\s)/.test(content)) warn(line, raw, '清單項目無法確認劇本類型，保留原文為動作段落。');
    index += 1;
  }

  warnMissingDialogue();
  return { blocks, warnings, lineMap, metadata };
}
