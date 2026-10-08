import { isProjectData } from './document';
import type { Project } from './types';

/**
 * The .sfe document format (SceneForge encrypted script). Every file is sealed with SceneForge's
 * own key, so it is unreadable to anything but SceneForge — no password for the writer to manage.
 *
 *   bytes 0–3   "SFE1"
 *   byte  4     format version (1)
 *   bytes 5–20  random salt
 *   bytes 21–32 random IV
 *   rest        AES-256-GCM( gzip( JSON ) ), key = HKDF-SHA256(app key, salt)
 *
 * Files from 0.4 (.sceneforge, "SFORGE01", optionally password-protected) still open.
 */
export const FILE_EXTENSION = 'sfe';
export const FILE_EXTENSIONS = ['.sfe', '.sceneforge'];
const SFE_MAGIC = new TextEncoder().encode('SFE1');
const MAGIC = new TextEncoder().encode('SFORGE01');
// Built into the app; with the salt it yields a different key for every file.
const APP_KEY = Uint8Array.from([0x5c, 0x9e, 0x21, 0xd4, 0x7a, 0x0f, 0xb3, 0x68, 0xe2, 0x14, 0x8d, 0x39, 0xc6, 0x51, 0xaf, 0x07, 0x93, 0x2b, 0xde, 0x46, 0x10, 0x7f, 0xc8, 0x65, 0x3a, 0xe9, 0x02, 0xbd, 0x74, 0x1c, 0x58, 0xf1]);
async function appKey(salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', APP_KEY as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new TextEncoder().encode('SceneForge document v1') as BufferSource }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const FLAG_GZIP = 1;
const FLAG_ENCRYPTED = 2;
const ITERATIONS = 310_000;

export interface SceneForgeDocument { format: 'sceneforge'; version: 1; savedAt: string; app: string; project: Project }
export class PasswordRequiredError extends Error { constructor() { super('這個檔案有密碼保護。'); } }
export class WrongPasswordError extends Error { constructor() { super('密碼不正確。'); } }

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const response = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function isEncryptedFile(bytes: Uint8Array): boolean {
  return bytes.length > 9 && MAGIC.every((byte, index) => bytes[index] === byte) && (bytes[8] & FLAG_ENCRYPTED) !== 0;
}

export async function encodeDocument(project: Project, app: string, password?: string): Promise<Uint8Array> {
  const doc: SceneForgeDocument = { format: 'sceneforge', version: 1, savedAt: new Date().toISOString(), app, project };
  const packed = await pipe(new TextEncoder().encode(JSON.stringify(doc)), new CompressionStream('gzip'));
  if (!password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await appKey(salt), packed as BufferSource));
    return concat(SFE_MAGIC, Uint8Array.of(1), salt, iv, sealed);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed as BufferSource));
  return concat(MAGIC, Uint8Array.of(FLAG_GZIP | FLAG_ENCRYPTED), salt, iv, sealed);
}

export async function decodeDocument(bytes: Uint8Array, password?: string): Promise<SceneForgeDocument> {
  let body: Uint8Array;
  if (SFE_MAGIC.every((byte, index) => bytes[index] === byte)) {
    if (bytes[4] !== 1) throw new Error('這個劇本檔來自較新版本的 SceneForge，請先更新。');
    const salt = bytes.subarray(5, 21);
    const iv = bytes.subarray(21, 33);
    let packed: Uint8Array;
    try { packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await appKey(salt), bytes.subarray(33) as BufferSource)); }
    catch { throw new Error('劇本檔已損毀，無法開啟。'); }
    body = await pipe(packed, new DecompressionStream('gzip'));
  } else if (MAGIC.every((byte, index) => bytes[index] === byte)) {
    const flags = bytes[8];
    let payload = bytes.subarray(9);
    if (flags & FLAG_ENCRYPTED) {
      if (!password) throw new PasswordRequiredError();
      const salt = payload.subarray(0, 16);
      const iv = payload.subarray(16, 28);
      const key = await deriveKey(password, salt);
      try { payload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, payload.subarray(28) as BufferSource)); }
      catch { throw new WrongPasswordError(); }
    }
    body = flags & FLAG_GZIP ? await pipe(payload, new DecompressionStream('gzip')) : payload;
  } else {
    body = bytes; // plain JSON (older exports)
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { throw new Error('這不是 SceneForge 劇本檔，或檔案已損毀。'); }
  const doc = (parsed && typeof parsed === 'object' && 'project' in parsed ? parsed : { format: 'sceneforge', version: 1, savedAt: '', app: '', project: parsed }) as SceneForgeDocument;
  if (!isProjectData(doc.project)) throw new Error('劇本檔內容不完整，無法開啟。');
  return doc;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Bridge to the desktop shell (electron/preload.cjs). Absent in the browser. */
export interface DesktopBridge {
  openDialog(): Promise<{ path: string; bytes: Uint8Array } | null>;
  readFile(path: string, projectId?: string): Promise<Uint8Array>;
  resolvePath(path: string): string;
  getPathForFile(file: File): string;
  saveDialog(defaultName: string): Promise<string | null>;
  defaultPath(defaultName: string): Promise<string>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  onOpenPath(callback: (path: string) => void): void;
  takePendingPath(): Promise<string | null>;
  folders?(): Promise<{ scripts: string; data: string; backups: string; trash: string }>;
  openFolder?(key: 'scripts' | 'data' | 'backups' | 'trash'): Promise<boolean>;
  setDocumentState(state: { title: string; dirty: boolean }): void;
  getZoom(): Promise<number>;
  setZoom(factor: number): Promise<number>;
  toggleFullscreen(): Promise<boolean>;
  onZoomChange(callback: (factor: number) => void): () => void;
  onSaveBeforeClose(callback: (shouldSaveFile: boolean) => Promise<boolean>): void;
}
export const desktop: DesktopBridge | undefined = (globalThis as { sfDesktop?: DesktopBridge }).sfDesktop;

export const baseName = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;
export const stripExtension = (name: string) => name.replace(/\.(sfe|sceneforge)$/i, '');
