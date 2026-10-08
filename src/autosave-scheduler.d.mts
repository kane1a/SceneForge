export interface AutoSaveTarget {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
  addEventListener(type: 'blur' | 'pagehide' | 'beforeunload', listener: () => void): void;
  removeEventListener(type: 'blur' | 'pagehide' | 'beforeunload', listener: () => void): void;
  requestIdleCallback?(callback: () => void, options?: { timeout?: number }): number;
  cancelIdleCallback?(id: number): void;
}
export interface ProjectAutoSaveSchedule {
  flush: () => void | boolean | Promise<boolean>;
  cancel: () => void;
}
export function scheduleDocumentAutoSave(save: () => void, options?: { target?: AutoSaveTarget; delayMs?: number }): () => void;
export function scheduleProjectAutoSave(save: () => void | boolean | Promise<boolean>, options?: { target?: AutoSaveTarget; delayMs?: number; idleTimeoutMs?: number }): ProjectAutoSaveSchedule;
