/**
 * Caret geometry for textareas, measured with an off-screen mirror that copies the
 * textarea's text layout. Lets the script editor move between paragraphs by visual
 * line and keep the horizontal "goal column", the way a normal text editor does.
 */
const COPIED = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontFeatureSettings', 'fontVariantEastAsian', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform',
  'textIndent', 'textAlign', 'whiteSpace', 'overflowWrap', 'wordBreak', 'lineBreak', 'tabSize'] as const;

let mirror: HTMLDivElement | null = null;
let marker: HTMLSpanElement | null = null;

function prepare(el: HTMLTextAreaElement) {
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, { position: 'absolute', top: '0', left: '-99999px', visibility: 'hidden', overflow: 'hidden', borderStyle: 'solid', borderColor: 'transparent' });
    marker = document.createElement('span');
    document.body.append(mirror);
  }
  const style = getComputedStyle(el);
  for (const key of COPIED) (mirror.style as unknown as Record<string, string>)[key] = style[key];
  mirror.style.width = `${el.getBoundingClientRect().width}px`;
  return style;
}

function coordsAt(el: HTMLTextAreaElement, pos: number): { top: number; left: number } {
  mirror!.textContent = el.value.slice(0, pos);
  marker!.textContent = el.value.slice(pos, pos + 1) || '​';
  mirror!.append(marker!);
  return { top: marker!.offsetTop, left: marker!.offsetLeft };
}

function lineHeightOf(style: CSSStyleDeclaration): number {
  const value = parseFloat(style.lineHeight);
  return Number.isFinite(value) ? value : parseFloat(style.fontSize) * 1.5;
}

export interface CaretEdge { first: boolean; last: boolean; x: number }

/** Is the caret on the first / last visual line, and at which screen x? */
export function caretEdge(el: HTMLTextAreaElement): CaretEdge {
  const style = prepare(el);
  const lh = lineHeightOf(style);
  const pos = el.selectionStart;
  const here = coordsAt(el, pos);
  const start = coordsAt(el, 0);
  const end = coordsAt(el, el.value.length);
  return { first: here.top < start.top + lh / 2, last: here.top > end.top - lh / 2, x: el.getBoundingClientRect().left + here.left };
}

/** Text offset on the first or last visual line of `el` closest to screen x. */
export function offsetOnEdgeLine(el: HTMLTextAreaElement, which: 'first' | 'last', x: number): number {
  const style = prepare(el);
  const lh = lineHeightOf(style);
  const left = el.getBoundingClientRect().left;
  const length = el.value.length;
  const lineTop = coordsAt(el, which === 'first' ? 0 : length).top;
  let best = which === 'first' ? 0 : length;
  let bestDistance = Infinity;
  const range = which === 'first' ? { from: 0, to: length, step: 1 } : { from: length, to: 0, step: -1 };
  for (let pos = range.from; which === 'first' ? pos <= range.to : pos >= range.to; pos += range.step) {
    const point = coordsAt(el, pos);
    if (Math.abs(point.top - lineTop) > lh / 2) break;
    const distance = Math.abs(left + point.left - x);
    if (distance < bestDistance) { bestDistance = distance; best = pos; }
  }
  return best;
}

/** Rectangles (relative to the textarea) covering text[start, end) — one per visual line. */
export function rangeRects(el: HTMLTextAreaElement, start: number, end: number): { left: number; top: number; width: number; height: number }[] {
  const style = prepare(el);
  const lh = lineHeightOf(style);
  const rects: { left: number; top: number; width: number; height: number }[] = [];
  let lineStart = coordsAt(el, start);
  let previous = lineStart;
  for (let pos = start + 1; pos <= end; pos += 1) {
    const point = coordsAt(el, pos);
    if (Math.abs(point.top - lineStart.top) > lh / 2 || pos === end) {
      const right = pos === end && Math.abs(point.top - lineStart.top) <= lh / 2 ? point.left : previous.left + (parseFloat(style.fontSize) || 16);
      rects.push({ left: lineStart.left, top: lineStart.top, width: Math.max(4, right - lineStart.left), height: lh });
      lineStart = point;
    }
    previous = point;
  }
  return rects;
}

/** Text offset nearest a screen point (used when clicking in the margin beside a line). */
export function offsetAtPoint(el: HTMLTextAreaElement, clientX: number, clientY: number): number {
  const style = prepare(el);
  const lh = lineHeightOf(style);
  const rect = el.getBoundingClientRect();
  const length = el.value.length;
  let best = length;
  let bestScore = Infinity;
  for (let pos = 0; pos <= length; pos += 1) {
    const point = coordsAt(el, pos);
    const dy = Math.abs(rect.top + point.top + lh / 2 - clientY);
    const dx = Math.abs(rect.left + point.left - clientX);
    const score = (dy > lh / 2 ? dy * 1000 : 0) + dx;
    if (score < bestScore) { bestScore = score; best = pos; }
  }
  return best;
}
