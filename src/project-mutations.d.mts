import type { CharacterProfile, Project, Thread } from './types';
export function removeSceneFromProject(project: Project, sceneId: string): Project;
export function mergeCharacters(project: Project, fromName: string, toName: string): Project;
export function setStoryRecordKind(project: Project, recordId: string, kind: 'setting' | 'thread'): Project;
export function getStoryRecordOrder(project: Project): string[];
export function convertClaimToThread(project: Project, recordId: string, updates?: Partial<Thread>): Project;
export const CHARACTER_DRAFT_FOCUS_PREFIX: string;
export function characterDraftFocusKey(draftId: string): string;
export function parseCharacterDraftFocusKey(value: unknown): string;
export function addCharacterDraft(project: Project, draftId?: string): Project;
export function updateCharacterDraft(project: Project, draftId: string, fields: Partial<CharacterProfile & { name: string }>): Project;
export function discardEmptyCharacterDraft(project: Project, draftId: string): Project;
export function commitCharacterDraft(project: Project, draftId: string, rawName: string, options?: { mergeInto?: string }):
  | { status: 'missing' | 'empty-name'; project: Project }
  | { status: 'duplicate'; duplicate: string; project: Project }
  | { status: 'committed' | 'merged'; duplicate?: string; name: string; project: Project };
export function removeUntouchedEmptyStoryRecords(project: Project): Project;
