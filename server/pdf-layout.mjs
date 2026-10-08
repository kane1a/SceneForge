// SceneForge print engine: measures real glyph advances, breaks lines with Chinese
// line-breaking rules (禁則), paginates like a screenplay (keep-with-next, (MORE)/(CONT'D)),
// and renders a PDF with subset-embedded fonts. Used for PDF export and page statistics.
import { readFileSync } from 'node:fs';
import * as fontkit from 'fontkit';
import PDFDocument from 'pdfkit';
import { withContinuationCues } from '../src/dialogue-rendering.mjs';

export { BUNDLED_FONTS } from './bundled-fonts.mjs';

const PT = 72;
const PAPERS = {
  letter: { width: 8.5 * PT, height: 11 * PT, top: 1 * PT, bottom: 1 * PT, left: 1.5 * PT, right: 1 * PT },
  a4: { width: 595.28, height: 841.89, top: 25 / 25.4 * PT, bottom: 25 / 25.4 * PT, left: 35 / 25.4 * PT, right: 25 / 25.4 * PT },
};
// Offsets and widths in inches from the text column's left edge (a 6in column on US Letter).
const ELEMENTS = {
  scene: { indent: 0, width: 6, before: 1, bold: true, upper: true },
  action: { indent: 0, width: 6, before: 1 },
  character: { indent: 2.2, width: 3.3, before: 1, upper: true },
  parenthetical: { indent: 1.6, width: 2.4, before: 0 },
  dialogue: { indent: 1, width: 3.5, before: 0 },
  transition: { indent: 0, width: 6, before: 1, upper: true, align: 'right' },
  shot: { indent: 0, width: 6, before: 1, bold: true, upper: true },
  act: { indent: 0, width: 6, before: 2, bold: true, upper: true, align: 'center', underline: true },
  titlecard: { indent: 0, width: 6, before: 1, bold: true, align: 'center' },
  // On-screen chat / text message (short-drama convention), set like an indented quote.
  message: { indent: 0.6, width: 4.4, before: 1 },
};
const MESSAGE_MARK = /^【[^】]{1,6}】/;
const STANDARD_LINES_PER_MINUTE = 55; // one US page of 12pt Courier at single spacing ≈ one minute
const STANDARD_LINES_PER_PAGE = 55; // screenplay convention; exact margins determine the physical fit

// 禁則: characters that may not begin a line, and ones that may not end one.
const NO_START = new Set([...'，。、；：？！）」』】》〉〕｝…—·．,.;:?!)]}%’”ゝゞーぁぃぅぇぉっゃゅょ']);
const NO_END = new Set([...'（「『【《〈〔｛([{‘“']);
const isWide = (cp) => (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0x20000 && cp <= 0x2fa1f) || cp === 0x2026 || cp === 0x2014;

const fontCache = new Map();
/** spec: a file path, or { file, face } where face is a PostScript name inside a collection (.ttc). */
function loadFont(spec) {
  const { file, face: wanted } = typeof spec === 'string' ? { file: spec } : spec;
  const key = `${file}#${wanted ?? ''}`;
  if (!fontCache.has(key)) {
    const font = fontkit.create(readFileSync(file));
    const face = 'fonts' in font ? (font.fonts.find((item) => item.postscriptName === wanted) ?? font.fonts[0]) : font;
    // Collections need the face's PostScript name when registered with pdfkit.
    fontCache.set(key, { file, font: face, advances: new Map(), face: 'fonts' in font ? face.postscriptName : undefined });
  }
  return fontCache.get(key);
}
function advance(entry, cp) {
  let value = entry.advances.get(cp);
  if (value === undefined) {
    const glyph = entry.font.glyphForCodePoint(cp);
    value = glyph && glyph.id !== 0 ? glyph.advanceWidth / entry.font.unitsPerEm : -1;
    entry.advances.set(cp, value);
  }
  return value;
}

/** fonts: { latin, latinBold, cjk }, each a file path or { file, face }. */
export function createFontSet(fonts) {
  const latin = loadFont(fonts.latin);
  const latinBold = fonts.latinBold ? loadFont(fonts.latinBold) : latin;
  const cjk = loadFont(fonts.cjk);
  return { files: fonts, latin, latinBold, cjk };
}

/** Split text into runs of one font each, measuring every character. */
function measureChars(text, fontSet, bold, size) {
  const chars = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const primary = isWide(cp) ? 'cjk' : bold ? 'latinBold' : 'latin';
    let slot = primary;
    let width = advance(fontSet[slot], cp);
    if (width < 0) { slot = primary === 'cjk' ? 'latin' : 'cjk'; width = advance(fontSet[slot], cp); }
    if (width < 0) { slot = primary; width = 0.5; }
    chars.push({ ch, slot, width: width * size, wide: isWide(cp) });
  }
  return chars;
}

/** Break one paragraph into lines no wider than maxWidth, honouring 禁則 and Latin word boundaries. */
function breakParagraph(chars, maxWidth, restWidth = maxWidth) {
  const lines = [];
  let line = [];
  let width = 0;
  const units = [];
  for (let i = 0; i < chars.length;) {
    if (!chars[i].wide && chars[i].ch !== ' ') {
      let j = i;
      while (j < chars.length && !chars[j].wide && chars[j].ch !== ' ') j += 1;
      units.push(chars.slice(i, j)); i = j;
    } else { units.push([chars[i]]); i += 1; }
  }
  const unitWidth = (unit) => unit.reduce((sum, c) => sum + c.width, 0);
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u];
    const w = unitWidth(unit);
    const limit = lines.length ? restWidth : maxWidth;
    if (width + w <= limit + 0.01 || line.length === 0) {
      if (line.length === 0 && unit[0].ch === ' ') continue;
      if (w > limit && line.length === 0 && unit.length > 1) {
        // Very long Latin token: hard-split by characters.
        for (const c of unit) { if (width + c.width > (lines.length ? restWidth : maxWidth) && line.length) { lines.push(line); line = []; width = 0; } line.push(c); width += c.width; }
        continue;
      }
      line.push(...unit); width += w;
      continue;
    }
    // Hanging punctuation: a no-start mark stays on this line even if it overhangs.
    if (unit.length === 1 && NO_START.has(unit[0].ch)) { line.push(unit[0]); width += w; continue; }
    // Never end a line on an opening bracket: carry it to the next line.
    const carry = [];
    while (line.length > 1 && NO_END.has(line[line.length - 1].ch)) carry.unshift(line.pop());
    while (line.length && line[line.length - 1].ch === ' ') line.pop();
    lines.push(line);
    line = [...carry];
    width = carry.reduce((sum, c) => sum + c.width, 0);
    if (unit[0].ch !== ' ') { line.push(...unit); width += w; }
  }
  if (line.length || !lines.length) lines.push(line);
  return lines;
}

function wrap(text, fontSet, spec, size, columnScale, hang = 0) {
  const maxWidth = spec.width * PT * columnScale;
  const value = spec.upper ? text.toUpperCase() : text;
  return value.split('\n').flatMap((paragraph, index) => breakParagraph(measureChars(paragraph, fontSet, !!spec.bold, size), index === 0 ? maxWidth : maxWidth - hang, maxWidth - hang));
}

const isCjkName = (name) => /\p{Script=Han}/u.test(name);
const moreLabel = (name) => isCjkName(name) ? '（接下頁）' : '(MORE)';
const contLabel = (name) => isCjkName(name) ? `${name}（續）` : `${name} (CONT'D)`;

/**
 * Lay the script out into pages. Returns { pages: Page[], stats }.
 * Page = { number, lines: { type, x, width, align, chars, bold, underline }[] } at fixed line slots.
 */
/**
 * options.template: 'hollywood' (default) or 'zh-inline' (scene number first, 角色：對白 on one hanging-indented paragraph).
 * options.sceneNumbers: print scene numbers. options.revised: Set of block ids to mark with * in the right margin.
 */
export function layoutScript(project, format, fontSet, options = {}) {
  const template = options.template === 'zh-inline' ? 'zh-inline' : 'hollywood';
  const revised = options.revised instanceof Set ? options.revised : new Set();
  const paper = PAPERS[format.paper === 'a4' ? 'a4' : 'letter'];
  const size = Math.min(16, Math.max(9, Number(format.fontPt) || 12));
  const hasCjkScript = project.blocks.some((block) => block.type !== 'note' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(block.text));
  const requestedLineSpacing = Math.max(1, Number(format.lineSpacing) || 1);
  const lineSpacing = template === 'hollywood' && hasCjkScript ? Math.max(1.25, requestedLineSpacing) : requestedLineSpacing;
  const lineHeight = size * lineSpacing;
  const gap = Math.max(0, Number(format.paragraphSpacing ?? 1));
  const columnScale = (paper.width - paper.left - paper.right) / (6 * PT);
  const firstBaseline = paper.top + (lineHeight - size) / 2 + size * 0.8;
  const lastBaseline = paper.height - paper.bottom - size * 0.2;
  const physicallyFit = Math.max(1, Math.floor((lastBaseline - firstBaseline) / lineHeight) + 1);
  const perPage = Math.min(STANDARD_LINES_PER_PAGE, physicallyFit);

  // Build flow items.
  const items = [];
  let speaker = '';
  let standardLines = 0;
  let sceneId = '';
  let sceneNumber = 0;
  const sourceBlocks = project.blocks.filter((block) => block.type !== 'note' && (block.type !== 'act' || (project.settings?.showActHeadings ?? project.kind !== 'film')) && block.text.trim());
  const blocks = withContinuationCues(sourceBlocks, template === 'zh-inline' ? 'taiwan-work' : 'us-screenplay', project.settings?.autoContinuation !== false);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === 'scene') { sceneId = block.id; sceneNumber += 1; }
    const base = { blockId: block.id, sceneId, revised: revised.has(block.id) };
    // Standard-screenplay line count drives the runtime estimate regardless of template.
    const standardSpec = ELEMENTS[block.type] ?? ELEMENTS.action;
    const standardBefore = block.type === 'scene' ? 2 : standardSpec.before;
    standardLines += wrap(block.text.trim(), fontSet, standardSpec, 12, 1).length + standardBefore;
    if (template === 'zh-inline' && block.type === 'character') {
      // 林志安：（低聲）台詞…  — one paragraph, continuation lines hang under the dialogue.
      const name = block.text.trim().replace(/[：:]$/, '');
      let text = `${name}：`;
      let j = index + 1;
      const parts = [];
      const ids = [block.id];
      while (j < blocks.length && ['parenthetical', 'dialogue'].includes(blocks[j].type)) { parts.push(blocks[j].text.trim()); ids.push(blocks[j].id); j += 1; }
      text += parts.join('');
      const hang = measureChars(`${name}：`, fontSet, false, size).reduce((sum, c) => sum + c.width, 0);
      const spec = { ...ELEMENTS.action, hang };
      items.push({ ...base, revised: ids.some((id) => revised.has(id)), type: 'dialogue-inline', spec, lines: wrap(text, fontSet, spec, size, columnScale, hang), before: Math.round(1 * gap), speaker: name });
      index = j - 1;
      continue;
    }
    const spec = ELEMENTS[block.type] ?? ELEMENTS.action;
    let text = block.text.trim();
    if (block.type === 'message' && !MESSAGE_MARK.test(text)) text = `【訊息】${text}`;
    if (block.type === 'scene' && options.sceneNumbers && template === 'zh-inline') text = `${sceneNumber}. ${text}`;
    const lines = wrap(text, fontSet, spec, size, columnScale);
    if (block.type === 'character') speaker = block.text.trim().replace(/\s*\(CONT'D\)$/iu, '').replace(/（續）$/u, '');
    items.push({ ...base, type: block.type, spec, lines, before: Math.round(spec.before * gap), speaker: ['dialogue', 'parenthetical'].includes(block.type) ? speaker : '', sceneNumber: block.type === 'scene' ? sceneNumber : undefined });
  }
  // 台式 spacing: consecutive action lines and consecutive dialogue lines sit together; a blank
  // line separates action from dialogue; two blank lines come before every scene heading.
  if (template === 'zh-inline') {
    const group = (type) => type === 'dialogue-inline' || type === 'dialogue' || type === 'parenthetical' || type === 'character' ? 'talk' : type;
    items.forEach((item, index) => {
      const previous = items[index - 1];
      if (!previous) return;
      if (item.type === 'scene') item.before = Math.round(2 * gap);
      else if (previous.type === 'scene' || group(previous.type) === group(item.type)) item.before = 0;
      else item.before = Math.round(1 * gap);
    });
  }

  const pages = [];
  let page = { lines: [] };
  let used = 0;
  const newPage = () => { pages.push(page); page = { lines: [] }; used = 0; };
  const place = (item, line) => page.lines.push({ slot: used++, item, chars: line });
  const placeText = (item, text) => place(item, measureChars(text, fontSet, false, size));

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const before = used === 0 ? 0 : item.before;
    const next = items[index + 1];
    // Minimum lines that must follow on the same page (keep-with-next).
    const keep = item.type === 'scene' || item.type === 'act' ? Math.min(2, next?.lines.length ?? 0) + (next ? next.before : 0)
      : item.type === 'character' || item.type === 'parenthetical' ? Math.min(1, next?.lines.length ?? 0) : 0;
    const need = before + item.lines.length + keep;
    if (used + need <= perPage) {
      used += before;
      item.lines.forEach((line) => place(item, line));
      continue;
    }
    const room = perPage - used - before;
    const splittable = (item.type === 'action' || item.type === 'dialogue') && item.lines.length >= 4 && room >= 2 + (item.type === 'dialogue' ? 1 : 0);
    if (!splittable) {
      // Pull a dangling character cue (and parenthetical) onto the next page with its dialogue.
      if (item.type === 'dialogue' || item.type === 'parenthetical') {
        const moved = [];
        while (page.lines.length && ['character', 'parenthetical'].includes(page.lines[page.lines.length - 1].item.type) && page.lines[page.lines.length - 1].item !== item) {
          const last = page.lines[page.lines.length - 1].item;
          const removed = page.lines.filter((line) => line.item === last);
          page.lines = page.lines.filter((line) => line.item !== last);
          used -= removed.length;
          moved.unshift({ item: last, lines: removed.map((line) => line.chars) });
        }
        if (moved.length) {
          newPage();
          moved.forEach(({ item: movedItem, lines }) => lines.forEach((line) => place(movedItem, line)));
          item.lines.forEach((line) => place(item, line));
          continue;
        }
      }
      if (used > 0) newPage();
      item.lines.forEach((line, lineIndex) => { if (used >= perPage) newPage(); if (lineIndex === 0 && used > 0) used += 0; place(item, line); });
      continue;
    }
    used += before;
    const take = item.type === 'dialogue' ? room - 1 : room;
    const head = item.lines.slice(0, Math.min(take, item.lines.length - 2));
    const tail = item.lines.slice(head.length);
    head.forEach((line) => place(item, line));
    if (item.type === 'dialogue') {
      const more = { ...item, type: 'character', spec: ELEMENTS.character };
      placeText(more, moreLabel(item.speaker));
    }
    newPage();
    if (item.type === 'dialogue') placeText({ ...item, type: 'character', spec: ELEMENTS.character }, contLabel(item.speaker));
    tail.forEach((line) => { if (used >= perPage) newPage(); place(item, line); });
  }
  if (page.lines.length || !pages.length) pages.push(page);
  pages.forEach((entry, i) => { entry.number = i + 1; });

  // Where each page begins (for on-screen page breaks) and how long each scene runs.
  const pageStarts = [];
  const sceneLines = {};
  const seen = new Set();
  for (const entry of pages) {
    const first = entry.lines[0];
    if (first && entry.number > 1) pageStarts.push({ blockId: first.item.blockId, page: entry.number, continued: seen.has(first.item.blockId) });
    for (const line of entry.lines) {
      seen.add(line.item.blockId);
      if (line.item.sceneId) sceneLines[line.item.sceneId] = (sceneLines[line.item.sceneId] ?? 0) + 1;
    }
  }

  const text = project.blocks.filter((block) => block.type !== 'note').map((block) => block.text).join('');
  const hanChars = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const allChars = Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
  return {
    pages,
    geometry: { paper, size, lineHeight, columnScale, perPage },
    stats: {
      pages: pages.length,
      scenes: project.blocks.filter((block) => block.type === 'scene').length,
      hanChars,
      characters: allChars,
      dialogueLines: project.blocks.filter((block) => block.type === 'dialogue').length,
      standardLines,
      minutes: Math.max(1, Math.round(standardLines / STANDARD_LINES_PER_MINUTE)),
      linesPerPage: perPage,
    },
    pageStarts,
    sceneEighths: Object.fromEntries(Object.entries(sceneLines).map(([id, count]) => [id, Math.max(1, Math.round((count / perPage) * 8))])),
  };
}

function drawRuns(doc, fontSet, chars, x, baseline, size, { bold = false, underline = false } = {}) {
  let cursor = x;
  let i = 0;
  while (i < chars.length) {
    const slot = chars[i].slot;
    let j = i;
    let width = 0;
    let text = '';
    while (j < chars.length && chars[j].slot === slot) { text += chars[j].ch; width += chars[j].width; j += 1; }
    const name = slot === 'cjk' ? 'sf-cjk' : slot === 'latinBold' ? 'sf-latin-bold' : 'sf-latin';
    const fakeBold = bold && (slot === 'cjk' || (slot === 'latin' && fontSet.latinBold === fontSet.latin));
    doc.font(name).fontSize(size);
    if (fakeBold) doc.lineWidth(size * 0.035);
    doc.text(text, cursor, baseline, { lineBreak: false, baseline: 'alphabetic', characterSpacing: 0, fill: true, stroke: fakeBold, width: width + 20 });
    cursor += width;
    i = j;
  }
  if (underline && chars.length) doc.moveTo(x, baseline + size * 0.18).lineTo(cursor, baseline + size * 0.18).lineWidth(0.6).stroke();
  return cursor - x;
}

function drawCover(doc, fontSet, cover, title, geometry, us = false) {
  const { paper, size } = geometry;
  const center = (text, y, fontSize, bold = false) => {
    const chars = measureChars(text, fontSet, bold, fontSize);
    const width = chars.reduce((sum, c) => sum + c.width, 0);
    drawRuns(doc, fontSet, chars, (paper.width - width) / 2, y, fontSize, { bold });
  };
  let y = paper.height * 0.36;
  if (us) {
    // Hollywood title page: everything in 12pt Courier; title uppercase; "Written by" 4 lines below, author 2 lines below that.
    const heading = (cover.title || title).toLocaleUpperCase();
    center(heading, y, size, true);
    if (cover.subtitle) { y += size * 2; center(cover.subtitle, y, size); }
    if (cover.author) { y += size * 4; center('Written by', y, size); y += size * 2; center(cover.author, y, size); }
    if (cover.basedOn) { y += size * 4; center(cover.basedOn, y, size); }
  } else {
    center(cover.title || title, y, size * 1.6, true);
    if (cover.subtitle) { y += size * 2.2; center(cover.subtitle, y, size); }
    if (cover.author) { y += size * 4; center('編劇', y, size); y += size * 1.8; center(cover.author, y, size * 1.1); }
    if (cover.basedOn) { y += size * 3; center(cover.basedOn, y, size * 0.95); }
  }
  const bottom = paper.height - paper.bottom;
  const contact = (cover.contact || '').split('\n').filter(Boolean);
  const contactSize = us ? size : size * 0.9;
  contact.forEach((line, i) => drawRuns(doc, fontSet, measureChars(line, fontSet, false, contactSize), paper.left, bottom - (contact.length - 1 - i) * (us ? size : size * 1.4), contactSize));
  const right = [cover.draft, cover.date].filter(Boolean);
  right.forEach((line, i) => {
    const chars = measureChars(line, fontSet, false, size * 0.9);
    const width = chars.reduce((sum, c) => sum + c.width, 0);
    drawRuns(doc, fontSet, chars, paper.width - paper.right - width, bottom - (right.length - 1 - i) * size * 1.4, size * 0.9);
  });
}

/** Render to a PDF Buffer. */
export function renderPdf(project, format, fontSet, { includeCover = true, ...options } = {}) {
  const layout = layoutScript(project, format, fontSet, options);
  const { paper, size, lineHeight, columnScale } = layout.geometry;
  const doc = new PDFDocument({ size: [paper.width, paper.height], margin: 0, autoFirstPage: false, info: options.anonymous ? { Title: project.title } : { Title: project.title, Author: project.titlePage?.author ?? '', Creator: 'SceneForge' } });
  doc.registerFont('sf-latin', fontSet.latin.file, fontSet.latin.face);
  doc.registerFont('sf-latin-bold', fontSet.latinBold.file, fontSet.latinBold.face);
  doc.registerFont('sf-cjk', fontSet.cjk.file, fontSet.cjk.face);
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  if (includeCover && project.titlePage?.print !== false) {
    doc.addPage();
    drawCover(doc, fontSet, project.titlePage ?? {}, project.title, layout.geometry, options.template !== 'zh-inline');
  }
  const ascent = size * 0.8;
  for (const page of layout.pages) {
    doc.addPage();
    if (page.number > 1) {
      const label = `${page.number}.`;
      const chars = measureChars(label, fontSet, false, size);
      const width = chars.reduce((sum, c) => sum + c.width, 0);
      drawRuns(doc, fontSet, chars, paper.width - paper.right - width, paper.top - lineHeight + ascent, size);
    }
    for (const line of page.lines) {
      const spec = line.item.spec;
      const firstOfItem = page.lines.find((entry) => entry.item === line.item) === line;
      const colX = paper.left + spec.indent * PT * columnScale + (spec.hang && !firstOfItem ? spec.hang : 0);
      const colW = spec.width * PT * columnScale;
      const width = line.chars.reduce((sum, c) => sum + c.width, 0);
      const x = spec.align === 'right' ? colX + colW - width : spec.align === 'center' ? colX + (colW - width) / 2 : colX;
      const baseline = paper.top + line.slot * lineHeight + (lineHeight - size) / 2 + ascent;
      drawRuns(doc, fontSet, line.chars, x, baseline, size, { bold: !!spec.bold && line.item.type !== 'character', underline: !!spec.underline });
      if (options.sceneNumbers && line.item.type === 'scene' && firstOfItem && line.item.sceneNumber && options.template !== 'zh-inline') {
        const label = measureChars(String(line.item.sceneNumber), fontSet, false, size);
        const labelWidth = label.reduce((sum, c) => sum + c.width, 0);
        drawRuns(doc, fontSet, label, paper.left - 0.4 * PT - labelWidth, baseline, size);
      }
      if (line.item.revised) drawRuns(doc, fontSet, measureChars('*', fontSet, false, size), paper.width - paper.right + 0.5 * PT, baseline, size);
    }
  }
  doc.end();
  return done.then((buffer) => ({ buffer, stats: layout.stats }));
}
