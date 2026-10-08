import type { Block, BlockType } from './types';

export interface ExtractedFile {
  text: string;
  /** Present when the file already carries screenplay structure (Final Draft .fdx). */
  blocks?: Block[];
  kind: string;
  encoding?: string;
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

/** Decode bytes, falling back to Big5 / GB18030 when UTF-8 is clearly wrong (old Windows files). */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16LE' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16BE' };
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad === 0 || bad / Math.max(1, utf8.length) < 0.001) return { text: utf8, encoding: 'UTF-8' };
  let best = { text: utf8, encoding: 'UTF-8', score: bad };
  for (const encoding of ['big5', 'gb18030']) {
    try {
      const text = new TextDecoder(encoding).decode(bytes);
      const score = (text.match(/�/g) ?? []).length + (encoding === 'gb18030' ? countSimplifiedOnly(text) * 0.01 : 0);
      if (score < best.score) best = { text, encoding: encoding === 'big5' ? 'Big5' : 'GB18030', score };
    } catch { /* decoder not available */ }
  }
  return { text: best.text, encoding: best.encoding };
}

function countSimplifiedOnly(text: string): number {
  return (text.match(/[这们说时为来对会过还没国们]/g) ?? []).length === 0 ? 1 : 0;
}

const FDX_TYPES: Record<string, BlockType> = {
  'scene heading': 'scene', action: 'action', character: 'character', dialogue: 'dialogue', parenthetical: 'parenthetical',
  transition: 'transition', shot: 'shot', general: 'action', 'new act': 'act', 'end of act': 'act', 'act break': 'act', 'cast list': 'note',
};

function parseFdx(xml: string): Block[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const content = doc.querySelector('Content') ?? doc.documentElement;
  const blocks: Block[] = [];
  content.querySelectorAll(':scope > Paragraph').forEach((paragraph) => {
    const type = FDX_TYPES[(paragraph.getAttribute('Type') ?? 'Action').toLowerCase()] ?? 'action';
    const centeredAction = type === 'action' && paragraph.getAttribute('Alignment')?.toLowerCase() === 'center';
    const text = Array.from(paragraph.querySelectorAll('Text')).map((node) => node.textContent ?? '').join('').trim();
    if (text) blocks.push({ id: newId(), type: centeredAction ? 'titlecard' : type, text });
  });
  return blocks;
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false, disableStream: true, disableAutoFetch: true }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= Math.min(doc.numPages, 500); number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue;
      const y = Math.round(item.transform[5] / 2) * 2;
      rows.set(y, [...(rows.get(y) ?? []), { x: item.transform[4], str: item.str }]);
    }
    const ys = [...rows.keys()].sort((a, b) => b - a);
    const lines: string[] = [];
    let previous: number | null = null;
    for (const y of ys) {
      if (previous !== null && previous - y > 22) lines.push('');
      lines.push(rows.get(y)!.sort((a, b) => a.x - b.x).map((part) => part.str).join('').trim());
      previous = y;
    }
    // Drop bare page numbers and running headers like "12." at page edges.
    pages.push(lines.filter((line, index) => !(/^\d{1,4}\.?$/.test(line) && (index < 2 || index > lines.length - 3))).join('\n'));
  }
  return pages.join('\n\n');
}

export async function extractFile(file: File): Promise<ExtractedFile> {
  const extension = file.name.toLowerCase().split('.').at(-1) ?? '';
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (extension === 'docx') {
    const mammoth = await import('mammoth/mammoth.browser.js');
    const result = await mammoth.default.extractRawText({ arrayBuffer: bytes.buffer });
    return { text: result.value.replace(/\n{3,}/g, '\n\n'), kind: 'Word 文件' };
  }
  if (extension === 'pdf') return { text: await pdfText(bytes), kind: 'PDF' };
  const { text, encoding } = decodeText(bytes);
  if (extension === 'fdx' || /<FinalDraft[\s>]/.test(text.slice(0, 500))) return { text, blocks: parseFdx(text), kind: 'Final Draft', encoding };
  if (extension === 'html' || extension === 'htm') {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
    doc.querySelectorAll('p,div,h1,h2,h3,h4,li').forEach((node) => node.append('\n'));
    return { text: doc.body.textContent ?? '', kind: '網頁', encoding };
  }
  if (extension === 'rtf') return { text: stripRtf(text), kind: 'RTF', encoding };
  return { text, kind: extension ? extension.toUpperCase() : '文字', encoding };
}

function stripRtf(rtf: string): string {
  return rtf
    .replace(/\\u(-?\d+)\??/g, (_, code) => String.fromCharCode(Number(code) < 0 ? Number(code) + 65536 : Number(code)))
    .replace(/\\'([0-9a-f]{2})/gi, '')
    .replace(/\\par[d]?\b ?/g, '\n')
    .replace(/\{\\\*[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}
