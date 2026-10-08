import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { askConfirm } from './confirm';
import { Select, TruncateText } from './ui-controls';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

type DocumentSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  byteLength: number;
  pageCount: number;
  paragraphCount: number;
  status: string;
};
type IndexedParagraph = { index: number; start: number; end: number; text: string };
type IndexedPage = { number: number; status: string; start: number; end: number; paragraphs: IndexedParagraph[] };
type DocumentDetail = DocumentSummary & {
  metadata: Record<string, unknown> | null;
  pages: IndexedPage[];
  text: string;
};
type SearchHit = { page: number; offset: number; sourceOffset: number; paragraph: number | null; excerpt: string };
type SearchResponse = { query: string; total: number; hasMore: boolean; results: SearchHit[] };
type ImportedContent = { text: string; metadata?: Record<string, unknown> };
type PlainRecord = Record<string, unknown>;

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const styles = `
  .sf-analyzer { color:#292722; background:#f6f3ed; min-height:100%; padding:28px; font-family:Inter,"Noto Sans TC","Microsoft JhengHei",sans-serif; }
  .sf-analyzer * { box-sizing:border-box; }
  .sf-head { max-width:1200px; margin:0 auto 22px; display:flex; gap:20px; justify-content:space-between; align-items:flex-end; }
  .sf-eyebrow { color:#9b644b; letter-spacing:.12em; font-size:11px; font-weight:700; }
  .sf-title { margin:5px 0 0; font-size:27px; letter-spacing:-.03em; }
  .sf-note { display:grid; gap:3px; margin:7px 0 0; color:#77736a; font-size:12.5px; line-height:1.5; }
  .sf-note span { display:block; }
  .sf-grid { max-width:1200px; margin:auto; display:grid; grid-template-columns:minmax(255px,310px) minmax(0,1fr); gap:16px; align-items:start; }
  .sf-panel { background:#fffefa; border:1px solid #e6e1d8; border-radius:14px; box-shadow:0 8px 25px #4a39210a; }
  .sf-library { padding:17px; }
  .sf-doc-list { display:grid; gap:2px; }
  .sf-doc { border:1px solid transparent; background:transparent; border-radius:10px; padding:9px 10px; text-align:left; width:100%; cursor:pointer; color:inherit; transition: background-color .2s cubic-bezier(.2,.7,.2,1), border-color .2s; }
  .sf-doc:hover { background:color-mix(in srgb, var(--ink) 4%, transparent); }
  .sf-doc-name { display:block; font-size:13px; font-weight:600; color:var(--ink); overflow-wrap:anywhere; }
  .sf-doc-meta { display:block; color:var(--muted); font-size:11.5px; margin-top:3px; font-variant-numeric: tabular-nums; }
  .sf-main { padding:20px; min-height:420px; }
  .sf-main-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
  .sf-main h2 { margin:0; font-size:18px; overflow-wrap:anywhere; }
  .sf-muted { color:#817d74; font-size:12px; line-height:1.6; }
  .sf-search { display:flex; gap:8px; margin:18px 0 10px; }
  .sf-search input { flex:1; min-width:0; border:1px solid #ded8cf; border-radius:9px; padding:10px 12px; font:inherit; font-size:13px; background:white; }
  .sf-btn { border:0; border-radius:9px; padding:9px 13px; background:#a66444; color:white; font:inherit; font-size:13px; font-weight:650; cursor:pointer; }
  .sf-btn:disabled { opacity:.5; cursor:wait; }
  .sf-clear { background:#eee9e1; color:#514b43; }
  .sf-status { padding:9px 11px; background:#f4f0e9; border-radius:8px; color:#625c52; font-size:12px; margin:11px 0; }
  .sf-status.error { background:#fff0eb; color:#9d3c25; }
  .sf-results { display:grid; gap:7px; margin:12px 0 19px; max-height:340px; overflow-y:auto; overscroll-behavior:contain; }
  .sf-hit { display:block; width:100%; text-align:left; background:#f9f6f0; border:1px solid #eae4da; border-radius:9px; padding:10px 12px; color:inherit; cursor:pointer; }
  .sf-hit:hover { border-color:#c8a890; }
  .sf-hit-meta { display:block; color:#8a614c; font-size:11px; margin-bottom:5px; }
  .sf-hit-excerpt { display:block; font-size:13px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
  .sf-page-bar { display:flex; align-items:center; gap:7px; flex-wrap:wrap; border-top:1px solid #eee9e1; padding-top:14px; margin-top:8px; }
  .sf-page { border:1px solid #e6e1d8; border-radius:7px; background:white; padding:5px 9px; font-size:11px; cursor:pointer; color:#514b43; }
  .sf-page.active { background:#292722; color:white; border-color:#292722; }
  .sf-page-text { background:#fbfaf7; border:1px solid #eee9e1; border-radius:9px; padding:14px; min-height:90px; max-height:400px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.8 ui-monospace,Consolas,monospace; color:#454139; }
  .sf-empty { padding:34px 18px; text-align:center; color:#817d74; font-size:13px; }
  .sf-footnote { border-top:1px solid #eee9e1; margin-top:16px; padding-top:12px; color:#817d74; font-size:11px; line-height:1.7; }
  .sf-analyzer { background:var(--canvas); color:var(--ink); font-family:inherit; }
  .sf-panel { background:var(--paper); border-color:var(--line); border-radius:4px; box-shadow:none; }
  .sf-hit-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; }
  .sf-save-note { min-height:34px; padding:6px 10px; border:1px solid #c8a890; border-radius:8px; background:#fffefa; color:#744b37; font:inherit; cursor:pointer; }
  .sf-save-note:hover { background:#f5ece4; }
  .sf-save-selected { margin-top:8px; }
  .sf-import,.sf-hit:hover { background:var(--accent-soft); border-color:var(--accent); color:var(--ink); }
  .sf-doc:hover,.sf-hit,.sf-page-text,.sf-status { background:var(--paper-raised); color:var(--ink); border-color:var(--line); }
  .sf-search input,.sf-page { background:var(--paper); color:var(--ink); border-color:var(--line); }
  .sf-note,.sf-muted,.sf-count,.sf-doc-meta,.sf-import small,.sf-footnote,.sf-empty { color:var(--muted); }
  .sf-eyebrow,.sf-hit-meta { color:var(--accent); }
  .sf-page.active,.sf-btn { background:var(--accent-deep); color:var(--paper); border-color:var(--accent); }
  .sf-clear { background:var(--line); color:var(--ink); }
  .sf-page-bar,.sf-footnote { border-color:var(--line); }
  .sf-import,.sf-doc,.sf-hit,.sf-search input,.sf-btn,.sf-status,.sf-page,.sf-page-text { border-radius:4px; }
  .sf-search input,.sf-search button { min-height:40px; }
  @media(max-width:760px) { .sf-analyzer{padding:18px 12px}.sf-head{align-items:flex-start;display:block}.sf-grid{grid-template-columns:1fr}.sf-main{padding:15px}.sf-search{flex-wrap:wrap}.sf-search input{flex-basis:100%} }
  .sf-analyzer { font-size:16px; line-height:1.65; }
  .sf-eyebrow,.sf-note,.sf-panel-title,.sf-import strong,.sf-count,.sf-doc-meta,.sf-import small,.sf-muted,.sf-btn,.sf-hit-meta,.sf-hit-excerpt,.sf-page,.sf-status,.sf-empty,.sf-footnote { font-size:15px; }
  .sf-title { font-size:28px; }
  .sf-note,.sf-import small,.sf-footnote { font-size:12.5px; line-height:1.5; }
  .sf-doc-name,.sf-main h2 { font-size:17px; }
  .sf-import,.sf-search input,.sf-btn,.sf-page { min-height:44px; }
  .sf-page-text { font-size:15px; }
  .sf-analyzer { padding:32px; }
  .sf-panel { border-radius:12px; background:var(--chrome); }
  .sf-import,.sf-doc,.sf-hit,.sf-search input,.sf-btn,.sf-status,.sf-page,.sf-page-text { border-radius:8px; }
  .sf-title { font-family:var(--font-display); font-weight:500; }
  .sf-eyebrow { font-family:var(--font-mono); font-size:12px; letter-spacing:.2em; }
  .sf-page.active,.sf-btn { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
  .sf-grid-single { grid-template-columns:minmax(0,1fr); height:100%; }
  .sf-analyzer-rail-mode { height:100%; min-height:0; overflow:auto; padding:28px; background:transparent; }
  .sf-analyzer-rail-mode .sf-grid-single { max-width:1200px; margin:0 auto; }
  .sf-analyzer-rail-mode .sf-main { min-height:0; max-height:100%; overflow:auto; }
  .sf-doc-row { min-width:0; display:grid; grid-template-columns:minmax(0,1fr) 30px; align-items:start; gap:4px; }
  .sf-doc-row .sf-doc { min-width:0; }
  .sf-doc-delete { width:28px; height:28px; opacity:0; border:0; border-radius:7px; background:transparent; color:var(--muted); font:20px/1 inherit; cursor:pointer; }
  .sf-doc-row:hover .sf-doc-delete,.sf-doc-row:focus-within .sf-doc-delete { opacity:1; }
  .sf-page-select { min-width:130px; }
  .sf-analyzer-rail-portal { min-height:0!important; padding:0!important; background:transparent!important; }
  .sf-analyzer-rail-portal .sf-library { padding:0; border:0; border-radius:0; background:transparent; }
  .sf-analyzer-rail-portal .sf-panel-title { margin:0 0 10px; padding:0 4px; }
  .sf-analyzer-rail-portal .sf-import { margin-bottom:4px; padding:12px; }
  .sf-analyzer-rail-portal .sf-doc-list { gap:4px; }
  .sf-analyzer-rail-portal .sf-doc-row { grid-template-columns:minmax(0,1fr) 24px; gap:2px; }
  .sf-analyzer-rail-portal .sf-doc { padding:9px 7px; }
  .sf-analyzer-rail-portal .sf-doc-delete { width:24px; height:24px; }
  .sf-analyzer-rail-portal .sf-footnote { display:none; }
  @media(hover:none) { .sf-doc-delete { opacity:1; } }
  /* reference library and document reader use the shared SceneForge tokens. */
  .sf-analyzer-rail-mode { height:100%; min-height:0; overflow:auto; padding:22px 24px 32px; background:transparent; }
  .sf-analyzer-rail-mode .sf-grid-single { max-width:none; height:auto; min-height:0; margin:0; }
  .sf-analyzer-rail-mode .sf-main { min-height:0; max-height:none; overflow:visible; padding:24px; border-radius:12px; background:var(--paper); }
  .sf-analyzer-rail-portal .sf-library { padding:0; }
  .sf-analyzer-rail-portal .sf-panel-title { display:none; }
  .sf-import { display:block; margin:0; padding:0!important; border:0; border-radius:0; background:transparent!important; color:var(--ink); }
  .sf-import-button { position:relative; display:flex; align-items:center; justify-content:center; width:100%; min-height:36px; padding:0 12px; border:1px solid var(--line); border-radius:8px; background:var(--paper); color:var(--ink-2); font:600 13px/1 var(--font-ui); cursor:pointer; }
  .sf-import-button:hover { background:var(--chrome-hover); }
  .sf-import-button .sf-file { position:absolute; inset:0; width:100%; height:100%; clip:auto; opacity:0; cursor:pointer; }
  .sf-format-list,.sf-import-helper { display:block; color:var(--muted); font-size:12px!important; line-height:1.55; }
  .sf-format-list { margin-top:8px; white-space:normal; letter-spacing:0; }
  .sf-import-helper { margin-top:1px; }
  .sf-analyzer-rail-portal .sf-count { margin:18px 2px 6px; font-size:11px!important; font-weight:600; letter-spacing:.06em; }
  .sf-analyzer-rail-portal .sf-doc-list { gap:3px; }
  .sf-doc-row { min-width:0; display:grid; grid-template-columns:minmax(0,1fr) 28px; align-items:center; gap:0; min-height:52px; padding:0 4px 0 9px; border:1px solid transparent; border-radius:8px; background:transparent; transition:background-color .18s,border-color .18s; }
  .sf-doc-row:hover { background:color-mix(in srgb,var(--ink) 3%,var(--paper)); }
  .sf-doc-row.active { border-color:var(--line); background:var(--paper); box-shadow:0 1px 2px rgb(22 20 15 / .06); }
  .sf-doc-row .sf-doc { box-sizing:border-box; min-width:0; min-height:50px; display:grid; align-content:center; gap:2px; padding:7px 0!important; border:0; border-radius:0; background:transparent; color:var(--ink-2); text-align:left; font:inherit; }
  .sf-doc-row .sf-doc:hover,.sf-doc-row .sf-doc.active { border-color:transparent; background:transparent; color:var(--ink); box-shadow:none; }
  .sf-doc-name { color:var(--ink); font-size:13px!important; font-weight:600; line-height:1.35; }
  .sf-doc-meta { margin-top:1px; color:var(--muted); font-size:12px!important; line-height:1.35; }
  .sf-doc-delete { box-sizing:border-box; width:28px; height:28px; display:grid; place-items:center; justify-self:center; align-self:center; padding:0; border:0; border-radius:7px; opacity:0; background:transparent; color:var(--muted); font:20px/28px var(--font-ui); cursor:pointer; }
  .sf-doc-row:hover .sf-doc-delete,.sf-doc-row:focus-within .sf-doc-delete { opacity:1; }
  .sf-doc-delete:hover,.sf-doc-delete:focus-visible { background:var(--chrome-hover); color:var(--ink); }
  .sf-main { padding:24px; background:var(--paper); border-radius:12px; }
  .sf-main-head { align-items:center; margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--line); }
  .sf-main h2 { font:600 20px/1.35 var(--font-display); }
  .sf-search { gap:8px; margin:0 0 14px; }
  .sf-search input,.sf-search button { height:42px; min-height:42px; border-radius:8px; box-sizing:border-box; }
  .sf-search input { padding:0 12px; border-color:var(--line); background:var(--paper-raised); color:var(--ink); font:14px var(--font-ui); }
  .sf-search .sf-btn { padding:0 16px; font:600 14px var(--font-ui); }
  .sf-search .sf-clear { background:var(--chrome-active); color:var(--ink-2); }
  .sf-page-bar { gap:10px; margin-top:18px; padding-top:16px; border-color:var(--line); }

  .sf-page-context { margin:12px 0 8px; color:var(--muted); font-size:13px; font-weight:500; }
  .sf-page-text { min-height:180px; max-height:min(62vh,720px); margin:0; padding:18px; border:1px solid var(--line); border-radius:9px; background:var(--paper-raised); color:var(--ink); font:14px/1.8 var(--font-mono); }
  .sf-results { max-height:300px; }
  .sf-hit-meta { color:var(--muted); font-size:12px!important; }
  .sf-footnote { color:var(--muted); }
  .sf-save-note { border-color:var(--line); border-radius:8px; background:var(--paper); color:var(--ink-2); }
  .sf-save-note:hover { background:var(--chrome-hover); }
  @media(max-width:760px) {
    .sf-analyzer-rail-mode { padding:16px 12px 24px; }
    .sf-analyzer-rail-mode .sf-main { padding:18px; }
    .sf-format-list { white-space:normal; }
    .sf-main-head { align-items:flex-start; }
  }
  .sf-story-page-head { max-width:none; margin:0 0 14px; align-items:flex-start; }
  .sf-analyzer-rail-mode { height:auto; min-height:0; overflow:visible; padding:0; background:transparent; }
  .sf-analyzer-rail-mode .sf-grid-single { max-width:none; height:auto; min-height:0; margin:0; gap:0; }
  .sf-analyzer-rail-mode .sf-main { width:100%; min-height:0; max-height:none; overflow:visible; padding:18px 20px; }
  .sf-doc-row { grid-template-columns:minmax(0,1fr) 28px; }
  .sf-analyzer-rail-portal .sf-doc-row { grid-template-columns:minmax(0,1fr) 28px; gap:0; }
  .sf-analyzer-rail-portal .sf-doc-delete { width:28px; height:28px; }
  .sf-analyzer-rail-portal .sf-doc-list { gap:4px; }
  .sf-analyzer-rail-portal .sf-doc { padding-right:0!important; }
  @media(hover:none) { .sf-doc-delete { opacity:1; } }
`;

function isRecord(value: unknown): value is PlainRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : `伺服器回應 ${response.status}`);
  return payload as T;
}

function displaySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function field(record: PlainRecord, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}

function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!isRecord(part)) return '';
  for (const key of ['text', 'transcript', 'content']) if (typeof part[key] === 'string') return part[key] as string;
  const type = field(part, 'content_type', 'type');
  return `[非文字內容：${typeof type === 'string' ? type : '附件'}]`;
}

function messageText(message: PlainRecord): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join('\n');
  if (!isRecord(content)) return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.transcript === 'string') return content.transcript;
  if (Array.isArray(content.parts)) return content.parts.map(partText).filter(Boolean).join('\n');
  return '';
}

function timestampText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return typeof value === 'string' ? value : '';
}

function conversationMetadata(record: PlainRecord): PlainRecord {
  const keys = ['id', 'title', 'create_time', 'update_time', 'is_archived', 'default_model_slug', 'model', 'conversation_id'];
  const metadata: PlainRecord = {};
  for (const key of keys) if (record[key] !== undefined && ['string', 'number', 'boolean'].includes(typeof record[key])) metadata[key] = record[key];
  return metadata;
}

type ExtractedMessage = { header: string; text: string; metadata: PlainRecord; sortTime: number; order: number };

function makeMessage(message: PlainRecord, order: number, mappingId?: string, node?: PlainRecord): ExtractedMessage {
  const author = isRecord(message.author) ? message.author : {};
  const roleValue = field(message, 'role') ?? field(author, 'role');
  const role = typeof roleValue === 'string' ? roleValue : 'unknown';
  const authorName = typeof author.name === 'string' ? author.name : '';
  const created = field(message, 'create_time', 'created_at', 'timestamp');
  const updated = field(message, 'update_time', 'updated_at');
  const recipient = typeof message.recipient === 'string' && message.recipient !== 'all' ? message.recipient : '';
  const channel = typeof message.channel === 'string' ? message.channel : isRecord(message.metadata) && typeof message.metadata.channel === 'string' ? message.metadata.channel : '';
  const content = isRecord(message.content) ? message.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : Array.isArray(message.content) ? message.content : [];
  const partTypes = parts.filter(isRecord).map((part) => field(part, 'content_type', 'type')).filter((value): value is string => typeof value === 'string');
  const text = messageText(message);
  const meta: PlainRecord = {
    role,
    ...(message.id !== undefined ? { id: message.id } : {}),
    ...(authorName ? { authorName } : {}),
    ...(created !== undefined ? { createdAt: created } : {}),
    ...(updated !== undefined ? { updatedAt: updated } : {}),
    ...(recipient ? { recipient } : {}),
    ...(channel ? { channel } : {}),
    ...(typeof message.status === 'string' ? { status: message.status } : {}),
    ...(typeof content.content_type === 'string' ? { contentType: content.content_type } : {}),
    ...(partTypes.length ? { partTypes } : {}),
    ...(mappingId ? { mappingId } : {}),
    ...(node && typeof node.parent === 'string' ? { parentId: node.parent } : {}),
    ...(node && Array.isArray(node.children) ? { childIds: node.children.filter((value): value is string => typeof value === 'string') } : {}),
  };
  const details = [role, authorName, timestampText(created), channel, recipient ? `→ ${recipient}` : ''].filter(Boolean).join(' · ');
  const timeNumber = typeof created === 'number' ? created : typeof created === 'string' && Number.isFinite(Date.parse(created)) ? Date.parse(created) : Number.NaN;
  return { header: `[${details}]`, text: text || '（無文字內容）', metadata: meta, sortTime: timeNumber, order };
}

function extractConversationJson(input: unknown): ImportedContent {
  const roots = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.conversations) ? input.conversations : [input];
  const conversations: PlainRecord[] = [];
  const textSections: string[] = [];

  roots.forEach((candidate, conversationIndex) => {
    if (!isRecord(candidate)) return;
    const rawMapping = candidate.mapping;
    const rawMessages = candidate.messages;
    let messages: ExtractedMessage[] = [];
    if (isRecord(rawMapping)) {
      messages = Object.entries(rawMapping).flatMap(([mappingId, value], order) => {
        if (!isRecord(value) || !isRecord(value.message)) return [];
        return [makeMessage(value.message, order, mappingId, value)];
      });
    } else if (Array.isArray(rawMessages)) {
      messages = rawMessages.flatMap((value, order) => isRecord(value) ? [makeMessage(value, order)] : []);
    }
    if (!messages.length && !isRecord(rawMapping) && !Array.isArray(rawMessages)) return;
    messages.sort((a, b) => {
      if (Number.isFinite(a.sortTime) && Number.isFinite(b.sortTime) && a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
      return a.order - b.order;
    });
    const title = typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : `對話 ${conversationIndex + 1}`;
    const summary = conversationMetadata(candidate);
    const messageMetadata = messages.map((message) => message.metadata);
    conversations.push({ ...summary, title, messageCount: messages.length, messages: messageMetadata });
    const heading = `# ${title}`;
    const lines = [heading, ...messages.map((message) => `${message.header}\n${message.text}`)];
    textSections.push(lines.join('\n\n'));
  });

  if (!conversations.length) throw new Error('JSON 不是可辨識的對話匯出檔（需要 messages 或 mapping 欄位）。');
  return {
    text: textSections.join('\n\n\f\n\n'),
    metadata: { format: 'conversation-json', conversations },
  };
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let task: ReturnType<typeof pdfjs.getDocument> | undefined;
  try {
    task = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, useWasm: false, disableStream: true, disableAutoFetch: true });
    const pdf = await task.promise;
    if (pdf.numPages > 500) throw new Error('PDF 超過 500 頁的單次索引上限；大型 PDF 續跑索引尚未支援。');
    const pageTexts: string[] = [];
    let extractedBytes = 0;
    const encoder = new TextEncoder();
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item) || typeof item.str !== 'string') continue;
        pageText += item.str;
        if ('hasEOL' in item && item.hasEOL) pageText += '\n';
      }
      extractedBytes += encoder.encode(pageText).byteLength + (pageTexts.length ? 1 : 0);
      if (extractedBytes > MAX_IMPORT_BYTES) throw new Error('PDF 擷取文字超過 20 MiB 匯入上限。');
      pageTexts.push(pageText);
    }
    const text = pageTexts.join('\f');
    if (!text.trim()) throw new Error('PDF 沒有可搜尋的文字層；掃描影像 OCR 尚未支援。');
    return text;
  } catch (cause) {
    if (cause instanceof Error && /[\u3400-\u9fff]/u.test(cause.message)) throw cause;
    throw new Error('PDF 解析或文字擷取失敗；請確認檔案有效且含有文字層。');
  } finally {
    await task?.destroy().catch(() => {});
  }
}

async function parseFile(file: File): Promise<ImportedContent> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('檔案不可超過 20 MiB。');
  const extension = file.name.toLowerCase().split('.').at(-1);
  if (extension === 'pdf') return { text: await extractPdf(file) };
  const raw = await file.text();
  if (extension === 'json') {
    try {
      return extractConversationJson(JSON.parse(raw));
    } catch (cause) {
      if (cause instanceof SyntaxError) throw new Error('對話 JSON 格式無效。');
      throw cause;
    }
  }
  if (!['txt', 'fountain', 'md', 'markdown'].includes(extension ?? '')) {
    throw new Error('支援格式：TXT、Fountain、Markdown、ChatGPT 對話 JSON 與含文字層的 PDF。');
  }
  return { text: raw };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
}

export interface AnalyzerProps {
  railMode?: boolean;
  pendingImportFile?: File | null;
  onImportHandled?: () => void;
  onSaveNote?: (sourceRef: { documentId: string; title: string; excerpt: string; locator?: string }) => void;
  /** 參考資料只屬於目前專案。 */
  projectId: string;
}

/** 同一份劇本切回參考資料時先顯示上次內容，再在背景更新，避免畫面閃一下。 */
const libraryCache = new Map<string, { documents: DocumentSummary[]; source: DocumentDetail | null }>();

export default function Analyzer({ railMode = false, pendingImportFile = null, onImportHandled, onSaveNote, projectId }: AnalyzerProps) {
  const scope = `projectId=${encodeURIComponent(projectId)}`;
  const cached = libraryCache.get(projectId);
  const [documents, setDocuments] = useState<DocumentSummary[]>(() => cached?.documents ?? []);
  const [activeId, setActiveId] = useState(() => cached?.source?.id ?? cached?.documents[0]?.id ?? '');
  const [source, setSource] = useState<DocumentDetail | null>(() => cached?.source ?? null);
  const [pageNumber, setPageNumber] = useState(1);
  const [query, setQuery] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(() => !cached);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [railContainer, setRailContainer] = useState<HTMLElement | null>(null);
  const pendingImportStartedRef = useRef<File | null>(null);

  useLayoutEffect(() => {
    setRailContainer(railMode ? document.getElementById('reference-library-rail') : null);
  }, [railMode]);
  useEffect(() => { libraryCache.set(projectId, { documents, source }); }, [projectId, documents, source]);

  async function refreshLibrary(preferredId?: string) {
    const result = await apiRequest<{ documents: DocumentSummary[] }>(`/api/library?${scope}`);
    const next = Array.isArray(result.documents) ? result.documents : [];
    setDocuments(next);
    const chosen = preferredId || (next.some((item) => item.id === activeId) ? activeId : next[0]?.id || '');
    if (chosen) await openSource(chosen);
    else {
      setActiveId('');
      setSource(null);
    }
  }

  async function openSource(id: string) {
    setActiveId(id);
    setSource(null);
    setSearch(null);
    setQuery('');
    setPageNumber(1);
    const detail = await apiRequest<DocumentDetail>(`/api/library/${encodeURIComponent(id)}?${scope}`);
    setSource(detail);
  }

  useEffect(() => {
    let live = true;
    (async () => {
      if (!libraryCache.has(projectId)) setLoading(true);
      try {
        const result = await apiRequest<{ documents: DocumentSummary[] }>(`/api/library?${scope}`);
        if (!live) return;
        const next = Array.isArray(result.documents) ? result.documents : [];
        setDocuments(next);
        const kept = libraryCache.get(projectId)?.source;
        if (kept && next.some((item) => item.id === kept.id)) { /* 保留目前開啟的文件，不重新載入避免閃爍 */ }
        else if (next[0]) {
          setActiveId(next[0].id);
          const detail = await apiRequest<DocumentDetail>(`/api/library/${encodeURIComponent(next[0].id)}?${scope}`);
          if (live) setSource(detail);
        }
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : '無法載入文件庫。');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [projectId]);

  async function importFile(file: File) {
    setBusy(true);
    setError('');
    setMessage(`正在讀取「${file.name}」…`);
    try {
      const imported = await parseFile(file);
      if (new TextEncoder().encode(imported.text).byteLength > MAX_IMPORT_BYTES) throw new Error('擷取文字不可超過 20 MiB。');
      const result = await apiRequest<{ document: DocumentSummary }>('/api/library', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, name: file.name, text: imported.text, ...(imported.metadata ? { metadata: imported.metadata } : {}) }),
      });
      await refreshLibrary(result.document.id);
      setMessage(`已建立離線來源：「${result.document.name}」。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '匯入失敗。');
      setMessage('');
    } finally {
      setBusy(false);
      onImportHandled?.();
    }
  }

  async function onImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void importFile(file);
  }

  useEffect(() => {
    if (!pendingImportFile) {
      pendingImportStartedRef.current = null;
      return;
    }
    if (pendingImportStartedRef.current === pendingImportFile) return;
    pendingImportStartedRef.current = pendingImportFile;
    void importFile(pendingImportFile);
  }, [pendingImportFile]);

  async function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source) return;
    setError('');
    setMessage('');
    try {
      const result = await apiRequest<SearchResponse>(`/api/library/${encodeURIComponent(source.id)}/search?q=${encodeURIComponent(query)}&${scope}`);
      setSearch(result);
      if (result.results[0]) setPageNumber(result.results[0].page);
    } catch (cause) {
      setSearch(null);
      setError(cause instanceof Error ? cause.message : '搜尋失敗。');
    }
  }

  async function chooseSource(id: string) {
    setError('');
    setMessage('');
    try {
      await openSource(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '無法讀取來源。');
    }
  }

  async function deleteSource(document: DocumentSummary) {
    const confirmed = await askConfirm({ title: '刪除參考文件？', message: `「${document.name}」與已建立的索引內容會一起刪除，無法復原。`, confirmLabel: '刪除', cancelLabel: '取消', danger: true });
    if (!confirmed) return;
    setError('');
    setMessage('');
    try {
      await api.deleteLibraryDocument(document.id, projectId);
      setMessage(`已刪除「${document.name}」。`);
      await refreshLibrary();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '刪除來源文件失敗。');
    }
  }

  const currentPage = source?.pages.find((page) => page.number === pageNumber);
  const pageText = source && currentPage ? source.text.slice(currentPage.start, currentPage.end) : '';
  const libraryPanel = (
    <aside className="sf-panel sf-library" aria-label="文件來源庫">
      <h2 className="sf-panel-title">來源文件</h2>
      <div className="sf-import">
        <label className="sf-import-button">
          <span>{busy ? '正在匯入…' : '＋ 匯入文件'}</span>
          <input className="sf-file" type="file" accept=".txt,.fountain,.md,.markdown,.json,.pdf" onChange={onImport} disabled={busy} aria-label="選擇文件匯入" />
        </label>
        <small className="sf-format-list">支援文字：TXT、Fountain、Markdown</small>
        <small className="sf-format-list">文件：PDF、ChatGPT 匯出檔（JSON）</small>
        <small className="sf-import-helper">單檔 20 MB 以內，只存在這台電腦</small>
      </div>
      <div className="sf-count">{documents.length} 個來源</div>
      {loading ? <div className="sf-muted">正在載入來源庫…</div> : documents.length ? (
        <div className="sf-doc-list">
          {documents.map((document) => (
            <div key={document.id} className={`sf-doc-row${document.id === activeId ? ' active' : ''}`}>
              <button type="button" className={`sf-doc${document.id === activeId ? ' active' : ''}`} aria-pressed={document.id === activeId} onClick={() => void chooseSource(document.id)}>
                <TruncateText text={document.name} className="sf-doc-name" />
                <span className="sf-doc-meta">{document.pageCount} 頁 · {displaySize(document.byteLength)}</span>
              </button>
              <button type="button" className="sf-doc-delete" aria-label={`刪除參考文件 ${document.name}`} title="刪除文件" onClick={() => void deleteSource(document)}>×</button>
            </div>
          ))}
        </div>
      ) : <div className="sf-empty">尚無來源文件。匯入文字文件後即可搜尋。</div>}
      <div className="sf-footnote"><span>來源文件與劇本分開儲存。</span><span>PDF 僅支援可選取文字。</span></div>
    </aside>
  );

  return (
    <div className={`sf-analyzer${railMode ? ' sf-analyzer-rail-mode' : ''}`}>
      <style>{styles}</style>
      {railMode ? <header className="sf-head sf-story-page-head">
        <div><h1 className="story-page-title">參考資料</h1><p className="story-page-subtitle">管理來源文件並查閱已建立的文字索引。</p></div>
      </header> : <header className="sf-head">
        <div>
          <div className="sf-eyebrow">SCENEFORGE · 離線資料庫</div>
          <h1 className="sf-title">文件索引</h1>
          <p className="sf-note"><span>純文字搜尋，不做語意推論。</span><span>來源文件獨立於劇本。</span></p>
        </div>
      </header>}
      <div className={`sf-grid${railMode ? ' sf-grid-single' : ''}`}>
        {!railMode && libraryPanel}

        <main className="sf-panel sf-main">
          {error && <div className="sf-status error" role="alert">{error}</div>}
          {message && <div className="sf-status" role="status">{message}</div>}
          {!source ? (
            <div className="sf-empty">{loading ? '正在載入文件…' : '選取或匯入一份來源文件。'}</div>
          ) : (
            <>
              <div className="sf-main-head">
                <div>
                  <h2>{source.name}</h2>
                  <div className="sf-muted">建立於 {formatDate(source.createdAt)}</div>
                </div>
                <span className="sf-muted">{source.pageCount} 頁</span>
              </div>
              <form className="sf-search" onSubmit={(event) => void onSearch(event)}>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋文件中的原始文字…" aria-label="搜尋來源文件文字" />
                <button className="sf-btn" type="submit">搜尋</button>
                <button className="sf-btn sf-clear" type="button" onClick={() => { setQuery(''); setSearch(null); }} disabled={!search}>清除</button>
              </form>
              {search && (
                <section aria-label="搜尋結果">
                  <div className="sf-count">「{search.query}」找到 {search.total} 筆{search.hasMore ? '（僅顯示前 500 筆）' : ''}</div>
                  {search.results.length ? (
                    <div className="sf-results">
                      {search.results.map((hit, index) => <div className="sf-hit-row" key={`${hit.sourceOffset}-${index}`}>
                        <button type="button" className="sf-hit" onClick={() => setPageNumber(hit.page)}>
                          <span className="sf-hit-meta">第 {hit.page} 頁</span>
                          <span className="sf-hit-excerpt">{hit.excerpt}</span>
                        </button>
                        {onSaveNote && <button type="button" className="sf-save-note" onClick={() => onSaveNote({ documentId: source.id, title: source.name, excerpt: hit.excerpt, locator: `第 ${hit.page} 頁 · 段落 ${hit.paragraph ?? '未分類'} · 位移 ${hit.sourceOffset}` })}>存成設定</button>}
                      </div>)}
                    </div>
                  ) : <div className="sf-empty">沒有符合的原文片段。</div>}
                </section>
              )}
              <div className="sf-page-bar" aria-label="來源頁面">
                <label className="sf-muted" htmlFor="sf-page-select">查看頁面</label>
                <Select ariaLabel="選擇頁面" className="sf-page-select" value={String(pageNumber)} options={source.pages.map((page) => ({ value: String(page.number), label: `第 ${page.number} 頁` }))} onChange={(value) => setPageNumber(Number(value))} />
                <span className="sf-muted">共 {source.pages.length} 頁</span>
              </div>
              <div className="sf-page-context">第 {currentPage?.number ?? pageNumber} 頁</div>
              <pre className="sf-page-text" onMouseUp={() => setSelectedText(window.getSelection()?.toString().trim() ?? '')}>{pageText || '（此頁沒有可擷取文字）'}</pre>
              {onSaveNote && selectedText && <button type="button" className="sf-btn sf-save-selected" onClick={() => { onSaveNote({ documentId: source.id, title: source.name, excerpt: selectedText, locator: `第 ${currentPage?.number ?? pageNumber} 頁` }); setSelectedText(''); window.getSelection()?.removeAllRanges(); }}>存成設定</button>}
            </>
          )}
        </main>
      </div>
      {railMode && railContainer && createPortal(<div className="sf-analyzer sf-analyzer-rail-portal"><style>{styles}</style>{libraryPanel}</div>, railContainer)}
    </div>
  );
}
