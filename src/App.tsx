import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FocusEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import Analyzer from './Analyzer';
import logoUrl from './assets/logo.svg';
import ImportStudio, { type ImportConfirm, type ImportSource } from './ImportStudio';
import MindMap from './MindMap';
import RelationGraph from './RelationGraph';
import { extractFile } from './file-extract';
import { syncSegmentThumbs } from './segmented';
import { caretEdge, offsetOnEdgeLine, rangeRects } from './caret';
import { EMPTY_MEMORY, learnFromImport, speakerKey, type ImportMemory } from './smart-import';
import BackupsDialog from './dialogs/BackupsDialog';
import TrashDialog from './dialogs/TrashDialog';
import NamesDialog, { type NameOptions } from './dialogs/NamesDialog';
import CompareDialog, { type RevisionBase } from './dialogs/CompareDialog';
import CoverDialog from './dialogs/CoverDialog';
import ReportsDialog from './dialogs/ReportsDialog';
import { downloadBlob, downloadText, interceptDemoDownload, safeFileName } from './download';
import { ScriptBlock, type ScriptBlockHandlers } from './ScriptBlock';
import { api, type FontInfo, type ScriptStats } from './api';
import { bibleToDocx, projectToDocx, projectToFdx } from './exporters';
import SceneBoard from './SceneBoard';
import StoryTimeline from './StoryTimeline';
import StoryOutline from './StoryOutline';
import KnowledgeMatrix from './KnowledgeMatrix';
import SeriesBible, { PROFILE_LABELS } from './SeriesBible';
import UnifiedStoryRecords from './UnifiedStoryRecords';
import { editorLineCount, estimatePages } from './page-estimate';
import { effectiveScriptLineSpacing } from './script-format';
import { askConfirm, ConfirmHost } from './confirm';
import { baseName, decodeDocument, desktop, encodeDocument, FILE_EXTENSION, PasswordRequiredError, stripExtension, WrongPasswordError } from './docfile';
import { convertProject, type ConvertDirection } from './chinese-convert';
import { EPISODE_TARGET, templateContent, unitName } from './templates';
import { revisedBlockIds } from './diff';
import { analyzeStory, mindmapFromProject, syncMindMapIdentities, sortByAppearance } from './story-analysis';
import { profileNames } from './story-candidates';
import type { ExportOptions, PageStart } from './api';
import { APP_CONFIG, BLOCK_LABELS, BLOCK_ORDER } from './config';
import { blocksToFountain, blocksToPlainText, countScriptLength, createEmptyProject, getEditorIntent, isProjectData, validateProjectData } from './document';
import { getSceneCompletion, acceptSceneCompletion, extractRememberedLocation } from './scene-completion';
import { getCharacterCandidates } from './character-completion.mjs';
import { fitTextareasIn, observeTextareasOnWidthChange } from './editor-layout';
import { getContinuationCueIds, withContinuationCues } from './dialogue-rendering.mjs';
import { addCharacterDraft, characterDraftFocusKey, commitCharacterDraft, discardEmptyCharacterDraft, mergeCharacters, parseCharacterDraftFocusKey, removeSceneFromProject, setStoryRecordKind, getStoryRecordOrder } from './project-mutations.mjs';
import { avatarStyle } from './avatar';
import { Select, Switch, TruncateText } from './ui-controls';
import { scheduleDocumentAutoSave, scheduleProjectAutoSave } from './autosave-scheduler.mjs';
import { PROFILE_FIELDS } from './types';
import type { Block, BlockType, CharacterProfile, Claim, Entity, MindNode, Project, ProjectSummary, Relation, SceneMeta, ScriptComment, Thread, TitlePage } from './types';
import './app-zoom.css';

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && structurallyEqual(a[key], b[key]));
}
function sameProjectContent(current: Project, next: Project): boolean {
  const stripTimestamp = (value: Project) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'updatedAt'));
  return structurallyEqual(stripTimestamp(current), stripTimestamp(next));
}

const ZOOM_PERCENTAGES = [80, 90, 100, 110, 125, 150, 175, 200] as const;
const STEP_ZOOM_PERCENTAGES: readonly number[] = [50, 60, 70, ...ZOOM_PERCENTAGES];
function normalizeZoomFactor(value: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(2, Math.max(0.5, parsed)) : 1;
}
function stepZoomPercent(currentPercent: number, delta: number) {
  const current = Math.round(currentPercent);
  const direction = Math.sign(delta);
  if (!direction) return current;
  return direction > 0
    ? STEP_ZOOM_PERCENTAGES.find((percent) => percent > current) ?? 200
    : [...STEP_ZOOM_PERCENTAGES].reverse().find((percent) => percent < current) ?? 50;
}

 type WorkspaceView = 'script' | 'map' | 'story' | 'index';
type MapTab = 'relations' | 'mindmap' | 'timeline';
type StoryWorkspaceTab = 'outline' | 'people' | 'records' | 'knowledge' | 'cards' | 'references';
const MAP_TABS: { id: MapTab; label: string }[] = [
  { id: 'relations', label: '人物關係圖' }, { id: 'mindmap', label: '心智圖' }, { id: 'timeline', label: '時間線' },
];
const STORY_TABS: { id: StoryWorkspaceTab; label: string }[] = [
  { id: 'outline', label: '故事大綱' }, { id: 'people', label: '人物設定' }, { id: 'records', label: '伏筆與設定' }, { id: 'knowledge', label: '知情表' }, { id: 'cards', label: '分場大綱' }, { id: 'references', label: '參考資料' },
];
type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';
type MenuName = 'file' | 'edit' | 'view' | 'format' | 'tools' | null;
type FormatPreset = 'us-screenplay' | 'taiwan-work' | 'custom';
/** The file a working copy belongs to. `path` exists only in the desktop app; the password is kept in memory only. */
interface DocFileInfo { path?: string; name: string; password?: string }
interface RecentFile { path?: string; projectId: string; name: string; openedAt: string }
const AUTO_SAVE_KEY = 'sceneforge-auto-save';
const STORY_MARKERS_KEY = 'sceneforge-story-markers';
const RECENT_KEY = 'sceneforge-recent-files';
const DOCFILE_KEY_PREFIX = 'sceneforge-docfile-';
function readRecentFiles(): RecentFile[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(list)) return [];
    const entries = list.filter((item) => item && typeof item.projectId === 'string' && typeof item.name === 'string').slice(0, 12);
    const migrated = entries.map((item) => ({ ...item, path: typeof item.path === 'string' ? (desktop?.resolvePath(item.path) ?? item.path) : undefined }));
    if (entries.some((item, index) => item.path !== migrated[index].path)) localStorage.setItem(RECENT_KEY, JSON.stringify(migrated));
    return migrated;
  } catch { return []; }
}
function readDocFile(projectId: string): { info: DocFileInfo | null; stamp: string } {
  try {
    const key = `${DOCFILE_KEY_PREFIX}${projectId}`;
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved && typeof saved.name === 'string') {
      const oldPath = typeof saved.path === 'string' ? saved.path : undefined;
      const filePath = oldPath ? (desktop?.resolvePath(oldPath) ?? oldPath) : undefined;
      if (filePath !== oldPath) localStorage.setItem(key, JSON.stringify({ ...saved, path: filePath }));
      return { info: { path: filePath, name: saved.name }, stamp: typeof saved.stamp === 'string' ? saved.stamp : '' };
    }
  } catch { /* optional */ }
  return { info: null, stamp: '' };
}
interface FormatSettings { preset: FormatPreset; paper: 'letter' | 'a4'; fontPt: number; lineSpacing: number; paragraphSpacing: number; }
interface ImportPreviewState { fileName: string; title: string; blocks: Block[]; project: Project | null; warnings: { line: number; content: string; reason: string }[]; metadata?: Record<string, string>; originalSource?: string; }

const DEFAULT_FORMATS: Record<FormatPreset, FormatSettings> = {
  'us-screenplay': { preset: 'us-screenplay', paper: 'letter', fontPt: 12, lineSpacing: 1, paragraphSpacing: 1 },
  'taiwan-work': { preset: 'taiwan-work', paper: 'a4', fontPt: 12, lineSpacing: 1.65, paragraphSpacing: 0.8 },
  custom: { preset: 'custom', paper: 'letter', fontPt: 12, lineSpacing: 1, paragraphSpacing: 1 },
};
// CJK glyphs are taller than Courier's line box; below this they collide and get clipped.
const MIN_LINE_SPACING = 1;
const FORMAT_KEY_PREFIX = 'sceneforge-format-';
const LOCATION_KEY_PREFIX = 'sceneforge-locations-';
const COLLAPSED_ACTS_KEY_PREFIX = 'sceneforge-collapsed-acts-';
const FONTS_KEY_PREFIX = 'sceneforge-fonts-';
const DEFAULT_FONTS = { latin: 'courier-prime', cjk: 'noto-mono-cjk' };
const IS_DEMO = import.meta.env.MODE === 'demo';
const TYPE_SHORTCUTS: Partial<Record<BlockType, number>> = { scene: 1, action: 2, character: 3, dialogue: 4, parenthetical: 5, transition: 6, shot: 7, act: 8, note: 9, titlecard: 0 };
const IMPORT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'fountain', 'fdx', 'docx', 'pdf', 'rtf', 'html', 'htm', 'json']);
const SCENEFORGE_EXTENSIONS = new Set(['sfe', 'sceneforge']);
const INTERNAL_DRAG_TYPE = 'application/x-sceneforge-internal';
type DropFeedback = { kind: 'accept' | 'reject' | 'unknown'; message: string };
function inspectDrop(dataTransfer: DataTransfer): DropFeedback | null {
  const types = Array.from(dataTransfer.types);
  if (types.includes(INTERNAL_DRAG_TYPE)) return null;
  const items = Array.from(dataTransfer.items ?? []);
  const directory = items.some((item) => {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.();
    return entry?.isDirectory === true;
  });
  if (directory) return { kind: 'reject', message: '資料夾不能匯入；請選擇單一檔案。' };
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 1) return { kind: 'reject', message: '一次只能放入一個檔案；混合或多檔拖放已拒絕。' };
  if (files.length === 1) {
    const file = files[0];
    const extension = file.name.toLowerCase().split('.').at(-1) ?? '';
    if (SCENEFORGE_EXTENSIONS.has(extension)) return { kind: 'accept', message: `放開以開啟劇本「${file.name}」` };
    if (IMPORT_EXTENSIONS.has(extension)) return { kind: 'accept', message: `放開以匯入「${file.name}」` };
    return { kind: 'reject', message: `不支援「${file.name}」。請放入 .sfe 劇本或支援的文字／文件檔。` };
  }
  if (types.includes('Files')) return { kind: 'unknown', message: '放開檔案後確認格式；一次只能放入一個檔案。' };
  if (types.some((type) => ['text/plain', 'text/html', 'text/uri-list'].includes(type))) {
    return { kind: 'reject', message: '不接受直接拖入的文字或連結；請先另存為支援的檔案格式。' };
  }
  return null;
}
const blockAfterEnter = (type: BlockType): BlockType => ({
  scene: 'action', action: 'action', character: 'dialogue', dialogue: 'action', parenthetical: 'dialogue',
  transition: 'scene', shot: 'action', act: 'scene', note: 'note', message: 'message', titlecard: 'action',
}[type] as BlockType);
// Final Draft-style Tab / Shift+Tab element cycling.
const TAB_NEXT: Record<BlockType, BlockType> = { action: 'character', character: 'action', dialogue: 'parenthetical', parenthetical: 'dialogue', scene: 'action', transition: 'scene', shot: 'action', act: 'scene', note: 'action', message: 'action', titlecard: 'action' };
const TAB_PREV: Record<BlockType, BlockType> = { action: 'scene', character: 'action', dialogue: 'character', parenthetical: 'dialogue', scene: 'transition', transition: 'action', shot: 'action', act: 'action', note: 'action', message: 'action', titlecard: 'action' };
// Empty paragraphs stay visible so a blank line you left behind is easy to spot.
const NO_COMMENTS: ScriptComment[] = [];
const NO_LOCATIONS: string[] = [];
const EMPTY_HINTS: Record<BlockType, string> = {
  scene: 'INT. / EXT. 場景標題', action: '動作描述…', character: '角色', dialogue: '對白…', parenthetical: '（語氣）',
  transition: '轉場', shot: '鏡頭', act: '幕', note: '筆記…', message: '角色：訊息內容（手機／聊天畫面）', titlecard: '片名或字卡內容',
};
const statusText: Record<SaveStatus, string> = { saved: '已儲存', dirty: '待儲存', saving: '儲存中…', error: '儲存失敗' };
const id = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function readFormatSettings(projectId: string): FormatSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(`${FORMAT_KEY_PREFIX}${projectId}`) ?? 'null') as Partial<FormatSettings> | null;
    if (saved?.preset && saved.preset in DEFAULT_FORMATS) {
      const base = DEFAULT_FORMATS[saved.preset];
      return {
        ...base,
        paper: saved.paper === 'a4' ? 'a4' : saved.paper === 'letter' ? 'letter' : base.paper,
        fontPt: Number.isFinite(saved.fontPt) ? Math.min(16, Math.max(10, Number(saved.fontPt))) : base.fontPt,
        lineSpacing: Number.isFinite(saved.lineSpacing) ? Math.min(2.2, Math.max(MIN_LINE_SPACING, Number(saved.lineSpacing))) : base.lineSpacing,
        paragraphSpacing: Number.isFinite(saved.paragraphSpacing) ? Math.min(3, Math.max(0, Number(saved.paragraphSpacing))) : base.paragraphSpacing,
      };
    }
  } catch { /* local browser storage may be unavailable */ }
  return { ...DEFAULT_FORMATS['us-screenplay'] };
}

function readRememberedLocations(projectId: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(`${LOCATION_KEY_PREFIX}${projectId}`) ?? '[]');
    return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string').slice(0, 20) : [];
  } catch { return []; }
}



function sceneHeadingId(blocks: readonly Block[], blockId: string) {
  let sceneId = '';
  for (const block of blocks) {
    if (block.type === 'act') sceneId = '';
    if (block.type === 'scene') sceneId = block.id;
    if (block.id === blockId) return block.type === 'scene' ? block.id : sceneId;
  }
  return '';
}

function Chevron() {
  return <svg className="chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>;
}

/** 選單裡的長文字只顯示前 8 個字。 */
const shortLabel = (text: string, max = 8) => { const chars = Array.from(text.replace(/\s+/g, ' ').trim()); return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join(''); };

function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingProject, setLoadingProject] = useState(false);
  const [listError, setListError] = useState('');
  const [projectError, setProjectError] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [saveError, setSaveError] = useState('');
  const [zoomFactor, setZoomFactor] = useState(1);
  const zoomFactorRef = useRef(1);
  const browserDprRef = useRef(window.devicePixelRatio || 1);
  const [retryTick, setRetryTick] = useState(0);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('script');
  const [storyWorkspaceTab, setStoryWorkspaceTab] = useState<StoryWorkspaceTab>('outline');
  const [bibleCharacterFocus, setBibleCharacterFocus] = useState('');
  const [focusedCardAct, setFocusedCardAct] = useState('');
  const [focusedRelationCharacter, setFocusedRelationCharacter] = useState('');
  const [focusedMindmapBranch, setFocusedMindmapBranch] = useState('');
  const [focusedTimelineScene, setFocusedTimelineScene] = useState('');
  const [focusedKnowledgeFact, setFocusedKnowledgeFact] = useState('');
  const [focusedStoryRecord, setFocusedStoryRecord] = useState<{ kind: 'entity' | 'claim' | 'thread'; id: string } | null>(null);
  const [paragraphMenu, setParagraphMenu] = useState<{ x: number; y: number; blockId: string; selectedText: string; hasSelection: boolean; mode: 'root' | 'pick' | 'role' | 'new'; draft: string; recordId?: string; kind?: 'thread' | 'claim' } | null>(null);
  const paragraphMenuRef = useRef<HTMLDivElement>(null);
  // Rendered in document.body so fixed coordinates stay in viewport CSS pixels at every Electron zoom.
  useLayoutEffect(() => {
    const el = paragraphMenuRef.current;
    if (!el || !paragraphMenu) return;
    const rect = el.getBoundingClientRect();
    let left = paragraphMenu.x;
    let top = paragraphMenu.y;
    if (left + rect.width > window.innerWidth) left = paragraphMenu.x - rect.width;
    if (top + rect.height > window.innerHeight) top = paragraphMenu.y - rect.height;
    left = Math.max(0, Math.min(left, window.innerWidth - rect.width));
    top = Math.max(0, Math.min(top, window.innerHeight - rect.height));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }, [paragraphMenu]);
  useEffect(() => {
    if (!paragraphMenu) return;
    const close = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest('.script-context-menu'))) setParagraphMenu(null); };
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') setParagraphMenu(null); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', keydown); };
  }, [paragraphMenu]);
  const [search, setSearch] = useState('');
  const [focusMode, setFocusMode] = useState(false);
  const [formatSettings, setFormatSettings] = useState<FormatSettings>(() => ({ ...DEFAULT_FORMATS['us-screenplay'] }));
  const [rememberedLocations, setRememberedLocations] = useState<string[]>([]);
  const [locationsOpen, setLocationsOpen] = useState(false);
  const [locationRename, setLocationRename] = useState<string | null>(null);
  const [locationDraft, setLocationDraft] = useState('');
  const [locationRenameInScript, setLocationRenameInScript] = useState(false);
  const [activeEditorId, setActiveEditorId] = useState('');
  const scriptBlockHandlers = useRef({} as ScriptBlockHandlers);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const [sceneSuggestionIndex, setSceneSuggestionIndex] = useState<Record<string, number>>({});
  const [dismissedSceneSuggestion, setDismissedSceneSuggestion] = useState('');
  const [menuOpen, setMenuOpen] = useState<MenuName>(null);
  const menuGroupRef = useRef<HTMLDivElement>(null);
  const [menuAlignment, setMenuAlignment] = useState<'left' | 'right'>('left');
  const [submenuPlacement, setSubmenuPlacement] = useState<{ side: 'left' | 'right'; vertical: 'up' | 'down' }>({ side: 'right', vertical: 'down' });
  const [zoomPopoverOpen, setZoomPopoverOpen] = useState(false);
  const [customZoomValue, setCustomZoomValue] = useState('100');
  const [customZoomError, setCustomZoomError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewState | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [pendingAnalyzerFile, setPendingAnalyzerFile] = useState<File | null>(null);
  const [mapTab, setMapTab] = useState<MapTab>('relations');
  const [coverOpen, setCoverOpen] = useState(false);
  const [elementMenuOpen, setElementMenuOpen] = useState(false);
  const [tagTop, setTagTop] = useState<number | null>(null);
  const [submenu, setSubmenu] = useState<'import' | 'export' | 'recent' | 'paragraph' | null>(null);
  const [newProjectPreset, setNewProjectPreset] = useState<'us-screenplay' | 'taiwan-work'>('taiwan-work');
  const [docFile, setDocFile] = useState<DocFileInfo | null>(null);
  const [savedStamp, setSavedStamp] = useState('');
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(readRecentFiles);
  const [saveAsRequest, setSaveAsRequest] = useState<{ resolve: (value: { name: string; password?: string } | null) => void } | null>(null);
  const [saveAsForm, setSaveAsForm] = useState({ name: '', protect: false, password: '', confirm: '' });
  const [passwordRequest, setPasswordRequest] = useState<{ name: string; wrong: boolean; resolve: (value: string | null) => void } | null>(null);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [licensesText, setLicensesText] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const [namesOpen, setNamesOpen] = useState(false);
  const [nameOptions, setNameOptions] = useState<NameOptions>({ surname: '', gender: 'any', style: 'taiwan' });
  const [convertOpen, setConvertOpen] = useState(false);
  const locked = false;
  const [convertOptions, setConvertOptions] = useState<{ direction: ConvertDirection; phrases: boolean }>({ direction: 'to-simplified', phrases: true });
  const [exportDialog, setExportDialog] = useState<'pdf' | 'docx' | null>(null);
  const [exportOptions, setExportOptions] = useState<{ template: 'hollywood' | 'zh-inline'; sceneNumbers: boolean; includeCover: boolean; anonymous: boolean; revisions: boolean }>({ template: 'hollywood', sceneNumbers: false, includeCover: true, anonymous: false, revisions: true });
  const [pageStarts, setPageStarts] = useState<PageStart[]>([]);
  const [sceneEighths, setSceneEighths] = useState<Record<string, number>>({});
  const [showPageBreaks, setShowPageBreaks] = useState(() => { try { return localStorage.getItem('sceneforge-page-breaks') !== 'off'; } catch { return true; } });
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(() => { try { return localStorage.getItem(AUTO_SAVE_KEY) !== 'off'; } catch { return true; } });
  const [autoSavedAt, setAutoSavedAt] = useState('');
  const [showStoryMarkers, setShowStoryMarkers] = useState(() => { try { return localStorage.getItem(STORY_MARKERS_KEY) === 'on'; } catch { return false; } });
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [findHighlight, setFindHighlight] = useState<{ blockId: string; rects: { left: number; top: number; width: number; height: number }[] } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [snapshotKeep, setSnapshotKeep] = useState<0 | 10 | 20 | 50>(20);
  const [revisionBase, setRevisionBase] = useState<RevisionBase | null>(null);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [reportTab, setReportTab] = useState<'scenes' | 'characters' | 'locations'>('scenes');
  const [goal, setGoal] = useState(() => { try { return Number(localStorage.getItem('sceneforge-goal')) || 1000; } catch { return 1000; } });
  const [goalBase, setGoalBase] = useState<number | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [commentFor, setCommentFor] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const openFindRef = useRef<() => void>(() => undefined);
  const [demoDownload, setDemoDownload] = useState<{ name: string; text?: string } | null>(null);
  const [scriptFonts, setScriptFonts] = useState(DEFAULT_FONTS);
  const [fontList, setFontList] = useState<FontInfo[]>([]);
  const [stats, setStats] = useState<ScriptStats | null>(null);
  const [exportBusy, setExportBusy] = useState('');
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const toastTimer = useRef(0);
  const autoSaveRunningRef = useRef(false);
  const notify = useCallback((text: string) => {
    setToast({ id: Date.now(), text });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);
  const applyDisplayZoom = (factor: number) => {
    const bridge = desktop;
    if (!bridge) return;
    const next = normalizeZoomFactor(factor);
    zoomFactorRef.current = next;
    setZoomFactor(next);
    void bridge.setZoom(next).then((actual) => {
      const normalized = normalizeZoomFactor(actual);
      zoomFactorRef.current = normalized;
      setZoomFactor(normalized);
    }).catch(() => {
      void bridge.getZoom().then((actual) => {
        const normalized = normalizeZoomFactor(actual);
        zoomFactorRef.current = normalized;
        setZoomFactor(normalized);
      }).catch(() => undefined);
    });
  };
  const stepDisplayZoom = (delta: number) => {
    if (!desktop) return;
    applyDisplayZoom(stepZoomPercent(zoomFactorRef.current * 100, delta) / 100);
  };
  const applyCustomDisplayZoom = () => {
    const value = customZoomValue.trim();
    const percent = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(percent) || percent < 50 || percent > 200 || percent % 5 !== 0) {
      setCustomZoomError('輸入 50–200 的整數，並以 5% 為間距。');
      return;
    }
    setCustomZoomError('');
    setZoomPopoverOpen(false);
    applyDisplayZoom(percent / 100);
  };
  useEffect(() => {
    if (!zoomPopoverOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest('.zoom-status-control'))) setZoomPopoverOpen(false); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setZoomPopoverOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [zoomPopoverOpen]);
  useEffect(() => { if (!zoomPopoverOpen) setCustomZoomValue(String(Math.round(zoomFactor * 100))); }, [zoomFactor, zoomPopoverOpen]);
  useEffect(() => {
    let mounted = true;
    const reflectZoom = (factor: number) => {
      if (!mounted) return;
      const normalized = normalizeZoomFactor(factor);
      zoomFactorRef.current = normalized;
      setZoomFactor(normalized);
    };
    const stopZoomListen = desktop?.onZoomChange(reflectZoom);
    if (desktop) void desktop.getZoom().then(reflectZoom).catch(() => undefined);
    const updateBrowserZoom = () => {
      if (desktop) return;
      reflectZoom((window.devicePixelRatio || browserDprRef.current) / browserDprRef.current);
    };
    const trackZoomShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const zoomIn = ['=', '+'].includes(event.key) || event.code === 'NumpadAdd';
      const zoomOut = ['-', '_'].includes(event.key) || event.code === 'NumpadSubtract';
      const reset = event.key === '0' || event.code === 'Numpad0';
      if (!zoomIn && !zoomOut && !reset) return;
      const current = Math.round(zoomFactorRef.current * 100);
      const next = (reset ? 100 : stepZoomPercent(current, zoomIn ? 1 : -1)) / 100;
      zoomFactorRef.current = next;
      setZoomFactor(next);
      if (desktop) {
        event.preventDefault();
        void desktop.setZoom(next).then((actual) => {
          const normalized = normalizeZoomFactor(actual);
          zoomFactorRef.current = normalized;
          setZoomFactor(normalized);
        }).catch(() => undefined);
      }
      // In demo mode the browser owns zoom; only the Electron fallback needs IPC.
    };
    const trackDesktopZoomWheel = (event: WheelEvent) => {
      if (!desktop || !event.ctrlKey || event.deltaY === 0) return;
      const delta = event.deltaY < 0 ? 1 : -1;
      const next = stepZoomPercent(Math.round(zoomFactorRef.current * 100), delta) / 100;
      if (next === zoomFactorRef.current) return;
      zoomFactorRef.current = next;
      setZoomFactor(next);
      void desktop.setZoom(next).then((actual) => {
        const normalized = normalizeZoomFactor(actual);
        zoomFactorRef.current = normalized;
        setZoomFactor(normalized);
      }).catch(() => undefined);
    };
    window.addEventListener('keydown', trackZoomShortcut, true);
    window.addEventListener('wheel', trackDesktopZoomWheel, { capture: true, passive: true });
    window.addEventListener('resize', updateBrowserZoom);
    return () => { mounted = false; stopZoomListen?.(); window.removeEventListener('keydown', trackZoomShortcut, true); window.removeEventListener('wheel', trackDesktopZoomWheel, true); window.removeEventListener('resize', updateBrowserZoom); };
  }, []);
  const [typeFlash, setTypeFlash] = useState({ id: '', n: 0 });
  const lastTypeRef = useRef<{ id: string; type: BlockType } | null>(null);
  const [collapsedActs, setCollapsedActs] = useState<string[]>([]);
  const [studioSource, setStudioSource] = useState<ImportSource | null>(null);
  const [importMemory, setImportMemory] = useState<ImportMemory>(EMPTY_MEMORY);
  const [dragFeedback, setDragFeedback] = useState<DropFeedback | null>(null);
  const memorySaveRef = useRef(0);

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState('');

  const [historyCount, setHistoryCount] = useState({ undo: 0, redo: 0 });

  const projectRef = useRef<Project | null>(null);
  const activeProjectIdRef = useRef('');
  const loadSequenceRef = useRef(0);
  const versionsRef = useRef(new Map<string, number>());
  const saveQueuesRef = useRef(new Map<string, Promise<boolean>>());
  const saveQueueVersionsRef = useRef(new Map<string, number>());
  const projectSaveScheduleRef = useRef<ReturnType<typeof scheduleProjectAutoSave> | null>(null);
  const historyRef = useRef({ past: [] as Project[], future: [] as Project[] });
  const focusRequestRef = useRef<{ id: string; position: number } | null>(null);
  const openPathRef = useRef<(path: string) => void>(() => undefined);
  const fileActionsRef = useRef({ save: async () => false as boolean, saveAs: async () => false as boolean, open: () => undefined as void, create: () => undefined as void });
  const unifiedFileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const updateHistoryCount = useCallback(() => {
    setHistoryCount({ undo: historyRef.current.past.length, redo: historyRef.current.future.length });
  }, []);

  const installProject = useCallback((next: Project | null) => {
    projectRef.current = next;
    setProject(next);
    setActiveEditorId('');
    setAutoSavedAt('');
    setCaretAtEnd(true);
    setSceneSuggestionIndex({});
    setDismissedSceneSuggestion('');
    if (next) {
      activeProjectIdRef.current = next.id;
      // The page format is part of the script (chosen when it was created); older scripts fall back to what this browser remembered.
      const preset = next.settings?.preset;
      setFormatSettings(preset ? { ...DEFAULT_FORMATS[preset] } : readFormatSettings(next.id));
      const file = readDocFile(next.id);
      setDocFile(file.info);
      setSavedStamp(file.stamp || next.updatedAt);
      setRememberedLocations(readRememberedLocations(next.id));
    } else {
      setRememberedLocations([]);
      setDocFile(null);
      setSavedStamp('');
    }
  }, []);

  const loadProject = useCallback(async (projectId: string) => {
    activeProjectIdRef.current = projectId;
    const sequence = ++loadSequenceRef.current;
    installProject(null);
    setProjectError('');
    setLoadingProject(true);
    try {
      const result = await api.getProject(projectId);
      if (sequence !== loadSequenceRef.current) return;
      installProject(result);
      versionsRef.current.set(result.id, 0);
      historyRef.current = { past: [], future: [] };
      updateHistoryCount();
      setSaveStatus('saved');
      setSaveError('');
    } catch (error) {
      if (sequence === loadSequenceRef.current) setProjectError(error instanceof Error ? error.message : '無法開啟專案。');
    } finally {
      if (sequence === loadSequenceRef.current) setLoadingProject(false);
    }
  }, [installProject, updateHistoryCount]);

  const refreshProjects = useCallback(async () => {
    setLoadingList(true);
    setListError('');
    try {
      const result = await api.listProjects();
      setProjects(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '無法讀取專案清單。';
      setListError(message);
      return null;
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void api.listProjects().then(async (result) => {
      if (!mounted) return;
      setProjects(result);
      setListError('');
      setLoadingList(false);
      // One script at a time: start on the welcome page, unless the OS asked us to open a file.
      const pending = await desktop?.takePendingPath().catch(() => null);
      if (pending) openPathRef.current(pending);
    }).catch((error: unknown) => {
      if (!mounted) return;
      setListError(error instanceof Error ? error.message : '無法連線至本機專案伺服器。');
      setLoadingList(false);
    });
    return () => { mounted = false; };
  }, [loadProject]);

  useEffect(() => {
    void api.getImportMemory().then(setImportMemory).catch(() => undefined);
  }, []);

  const updateImportMemory = useCallback((memory: ImportMemory) => {
    setImportMemory(memory);
    window.clearTimeout(memorySaveRef.current);
    memorySaveRef.current = window.setTimeout(() => { void api.saveImportMemory(memory).catch(() => undefined); }, 400);
  }, []);

  const scheduleSave = useCallback((snapshot: Project, version: number) => {
    const previous = saveQueuesRef.current.get(snapshot.id) ?? Promise.resolve(true);
    const task = previous.catch(() => false).then(async () => {
      if (versionsRef.current.get(snapshot.id) !== version) return false;
      if (activeProjectIdRef.current === snapshot.id) setSaveStatus('saving');
      await api.saveProject(snapshot);
      if (versionsRef.current.get(snapshot.id) === version && activeProjectIdRef.current === snapshot.id) {
        setSaveStatus('saved');
        setSaveError('');
      }
      setProjects((items) => items.map((item) => item.id === snapshot.id ? { ...item, title: snapshot.title, updatedAt: snapshot.updatedAt } : item));
      return true;
    }).catch((error: unknown) => {
      if (versionsRef.current.get(snapshot.id) === version && activeProjectIdRef.current === snapshot.id) {
        setSaveStatus('error');
        setSaveError(error instanceof Error ? error.message : '自動儲存失敗。');
      }
      return false;
    });
    saveQueuesRef.current.set(snapshot.id, task);
    saveQueueVersionsRef.current.set(snapshot.id, version);
    return task;
  }, []);

  const flushProjectSave = useCallback(async () => {
    const snapshot = projectRef.current;
    if (!snapshot) return true;
    const version = versionsRef.current.get(snapshot.id) ?? 0;
    projectSaveScheduleRef.current?.flush();
    if (version > 0 && saveQueueVersionsRef.current.get(snapshot.id) !== version) scheduleSave(snapshot, version);
    const queued = saveQueuesRef.current.get(snapshot.id);
    return queued ? await queued : true;
  }, [scheduleSave]);

  useEffect(() => {
    if (!project) return;
    const version = versionsRef.current.get(project.id) ?? 0;
    if (version === 0) return;
    const scheduled = scheduleProjectAutoSave(() => {
      if (projectSaveScheduleRef.current === scheduled) projectSaveScheduleRef.current = null;
      return scheduleSave(project, version);
    }, { target: window, delayMs: 1000, idleTimeoutMs: 1000 });
    projectSaveScheduleRef.current = scheduled;
    return () => {
      scheduled.cancel();
      if (projectSaveScheduleRef.current === scheduled) projectSaveScheduleRef.current = null;
    };
  }, [project, retryTick, scheduleSave]);

  useEffect(() => { delete document.documentElement.dataset.theme; }, []);

  useEffect(() => {
    if (!project) return;
    try { localStorage.setItem(`${FORMAT_KEY_PREFIX}${project.id}`, JSON.stringify(formatSettings)); } catch { /* browser storage is optional */ }
  }, [formatSettings, project?.id]);
  // The page format belongs to the script: follow it when it changes (format menu, undo/redo, edits from another tool).
  const projectPreset = project?.settings?.preset;
  useEffect(() => {
    if (!projectPreset || !(projectPreset in DEFAULT_FORMATS)) return;
    setFormatSettings((current) => current.preset === projectPreset ? current : { ...DEFAULT_FORMATS[projectPreset] });
  }, [projectPreset]);

  useEffect(() => {
    if (!project) return;
    try { localStorage.setItem(`${LOCATION_KEY_PREFIX}${project.id}`, JSON.stringify(rememberedLocations)); } catch { /* browser storage is optional */ }
  }, [rememberedLocations, project?.id]);


  useEffect(() => {
    if (!project) return;
    const page = document.querySelector<HTMLElement>('.script-page');
    if (!page) return;
    fitTextareasIn(page);
    return observeTextareasOnWidthChange(page);
  }, [project?.id]);

  useLayoutEffect(() => {
    if (workspaceView !== 'script' || !activeEditorId) return;
    const editor = document.getElementById(`editor-${activeEditorId}`) as HTMLTextAreaElement | null;
    if (editor && document.activeElement !== editor) editor.focus({ preventScroll: true });
  }, [workspaceView]);

  // Move the caret in the same commit as the edit, so a key pressed right after Enter lands in the new line.
  useLayoutEffect(() => {
    const request = focusRequestRef.current;
    if (!request) return;
    focusRequestRef.current = null;
    const place = () => {
      const editor = document.getElementById(`editor-${request.id}`) as HTMLTextAreaElement | null;
      if (!editor) return false;
      editor.focus();
      editor.setSelectionRange(request.position, request.position);
      return true;
    };
    if (!place()) requestAnimationFrame(place);
  }, [project?.blocks]);

  const mutateProject = useCallback((change: (current: Project) => Project) => {
    const current = projectRef.current;
    if (!current || activeProjectIdRef.current !== current.id) return;
    const changed = change(current);
    if (sameProjectContent(current, changed)) return;
    const next = { ...changed, updatedAt: new Date().toISOString() };
    historyRef.current.past = [...historyRef.current.past.slice(-99), current];
    historyRef.current.future = [];
    updateHistoryCount();
    const version = (versionsRef.current.get(current.id) ?? 0) + 1;
    versionsRef.current.set(current.id, version);
    projectRef.current = next;
    setProject(next);
    setSaveStatus('dirty');
    setSaveError('');
  }, [updateHistoryCount]);

  const changeScriptPreset = useCallback(async (preset: 'taiwan-work' | 'us-screenplay') => {
    const current = projectRef.current;
    if (!current) return;
    const now = current.settings?.preset ?? (formatSettings.preset === 'taiwan-work' ? 'taiwan-work' : 'us-screenplay');
    if (now === preset) return;
    setMenuOpen(null);
    const label = preset === 'taiwan-work' ? '台式劇本' : '美式劇本';
    const layout = preset === 'taiwan-work' ? 'A4、場次號在前、「角色：對白」' : 'US Letter、角色置中、對白縮排';
    const confirmed = await askConfirm({ title: `改成${label}？`, message: `劇本內容不會改變，只換成${layout}的版面。分頁、頁數與片長估計會重新計算；之後可以隨時切回，也可以用「復原」還原。`, confirmLabel: '切換' });
    if (!confirmed) return;
    mutateProject((value) => ({ ...value, settings: { ...(value.settings ?? { preset }), preset } }));
  }, [formatSettings.preset, mutateProject]);

  const undo = useCallback(() => {
    const current = projectRef.current;
    const previous = historyRef.current.past.at(-1);
    if (!current || !previous) return;
    historyRef.current.past = historyRef.current.past.slice(0, -1);
    historyRef.current.future = [...historyRef.current.future, current];
    const next = { ...previous, updatedAt: new Date().toISOString() };
    const version = (versionsRef.current.get(current.id) ?? 0) + 1;
    versionsRef.current.set(current.id, version);
    projectRef.current = next;
    setProject(next);
    setSaveStatus('dirty');
    updateHistoryCount();
  }, [updateHistoryCount]);

  const redo = useCallback(() => {
    const current = projectRef.current;
    const following = historyRef.current.future.at(-1);
    if (!current || !following) return;
    historyRef.current.future = historyRef.current.future.slice(0, -1);
    historyRef.current.past = [...historyRef.current.past, current];
    const next = { ...following, updatedAt: new Date().toISOString() };
    const version = (versionsRef.current.get(current.id) ?? 0) + 1;
    versionsRef.current.set(current.id, version);
    projectRef.current = next;
    setProject(next);
    setSaveStatus('dirty');
    updateHistoryCount();
  }, [updateHistoryCount]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.which === 229) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ['=', '+', '-', '_', '0'].includes(event.key)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'h')) {
        event.preventDefault();
        openFindRef.current();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ['s', 'o', 'n'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        const key = event.key.toLowerCase();
        if (key === 's') void (event.shiftKey ? fileActionsRef.current.saveAs() : fileActionsRef.current.save());
        else if (key === 'o') fileActionsRef.current.open();
        else fileActionsRef.current.create();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        setTimeout(() => { searchInputRef.current?.focus(); searchInputRef.current?.select(); }, 0);
        return;
      }
      if (event.key === 'Escape') {
        setMenuOpen(null);
        setHelpOpen(false);
        setTrashOpen(false);
        setImportPreview(null);
        setLocationsOpen(false);
        setLocationRename(null);
        setNewProjectOpen(false);
        setAboutOpen(false);
        setLicensesText(null);
        // Every modal closes on Esc the same way (confirm dialogs handle Esc themselves).
        if (!document.querySelector('.confirm-backdrop')) {
          setCoverOpen(false); setNamesOpen(false); setConvertOpen(false);
          setCompareOpen(false); setReportsOpen(false); setGoalOpen(false); setBackupsOpen(false);
        }
      }
      const outlineInput = target?.closest('.story-outline-fields');
      if (outlineInput && (event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) redo(); else undo();
        return;
      }
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]') ?? false;
      if (!target?.classList.contains('script-editor')) {
        if (!typing && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          if (event.key.toLowerCase() === 'y' || event.shiftKey) redo(); else undo();
        }
        return;
      }
      const number = Number(event.key);
      const mac = /Mac|iPhone|iPad/i.test(navigator.platform);
      const desktopChord = mac ? event.metaKey && !event.ctrlKey && !event.altKey : event.ctrlKey && !event.metaKey && !event.altKey;
      const demoFallback = IS_DEMO && event.altKey && !event.ctrlKey && !event.metaKey;
      if ((desktopChord || demoFallback) && !event.shiftKey && (number === 0 || (Number.isInteger(number) && number >= 1 && number <= 9))) {
        const type = (Object.keys(TYPE_SHORTCUTS) as BlockType[]).find((key) => TYPE_SHORTCUTS[key] === number);
        if (!type) return;
        event.preventDefault();
        const blockId = target.dataset.blockId;
        if (blockId) mutateProject((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === blockId ? { ...block, type } : block) }));
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
    };
    // Any click outside an open menu or popover closes it.
    const closeOutsideMenu = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (!target.closest('.header-menu, .sf-select-menu')) setMenuOpen(null);
      if (!target.closest('.element-tag-wrap')) setElementMenuOpen(false);
      if (!target.closest('.goal')) setGoalOpen(false);
      if (!target.closest('.comment-pop, .comment-pin, .header-menu')) setCommentFor(null);
    };
    window.addEventListener('keydown', handleShortcut);
    document.addEventListener('pointerdown', closeOutsideMenu);
    return () => {
      window.removeEventListener('keydown', handleShortcut);
      document.removeEventListener('pointerdown', closeOutsideMenu);
    };
  }, [mutateProject, redo, undo]);

  const createProject = async (event?: FormEvent) => {
    event?.preventDefault();
    const title = newProjectTitle.trim() || '未命名劇本';
    const draft: Project = { ...createEmptyProject(title), ...templateContent('blank'), settings: { preset: newProjectPreset, showActHeadings: false, autoContinuation: true } };
    const initialProject = draft.blocks.length ? draft : { ...draft, blocks: [{ id: id(), type: 'scene' as const, text: '' }] };
    setProjectError('');
    try {
      const created = await api.createProject(initialProject);
      setProjects((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      activeProjectIdRef.current = created.id;
      ++loadSequenceRef.current;
      versionsRef.current.set(created.id, 0);
      historyRef.current = { past: [], future: [] };
      updateHistoryCount();
      const firstScene = created.blocks.find((block) => block.type === 'scene') ?? created.blocks[0];
      if (firstScene) focusRequestRef.current = { id: firstScene.id, position: 0 };
      installProject(created);
      setSaveStatus('saved');
      setSaveError('');
      setNewProjectTitle('');
      setNewProjectOpen(false);
      setWorkspaceView('script');
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : '建立專案失敗。');
    }
  };

  const createImportedProject = async (imported: Project) => {
    const copy: Project = { ...imported, id: id(), updatedAt: new Date().toISOString() };
    const created = await api.createProject(copy);
    setProjects((items) => [created, ...items.filter((item) => item.id !== created.id)]);
    activeProjectIdRef.current = created.id;
    ++loadSequenceRef.current;
    versionsRef.current.set(created.id, 0);
    historyRef.current = { past: [], future: [] };
    updateHistoryCount();
    installProject(created);
    setSaveStatus('saved');
    setSaveError('');
    setWorkspaceView('script');
  };

  // ——— Documents: one script open at a time, kept in a .sceneforge file ———
  const dirty = !!project && savedStamp !== project.updatedAt;
  const documentTitle = project ? (docFile?.name ?? project.title) : 'SceneForge';
  const rememberDocFile = (projectId: string, info: DocFileInfo | null, stamp: string) => {
    try {
      if (info) localStorage.setItem(`${DOCFILE_KEY_PREFIX}${projectId}`, JSON.stringify({ path: info.path, name: info.name, stamp }));
      else localStorage.removeItem(`${DOCFILE_KEY_PREFIX}${projectId}`);
    } catch { /* optional */ }
  };
  const addRecent = (entry: RecentFile) => setRecentFiles((items) => {
    const next = [entry, ...items.filter((item) => (entry.path ? item.path !== entry.path : item.projectId !== entry.projectId))].slice(0, 12);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* optional */ }
    return next;
  });
  const forgetRecent = (entry: RecentFile) => setRecentFiles((items) => {
    const next = items.filter((item) => item !== entry);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* optional */ }
    return next;
  });
  const forgetRecentProject = (projectId: string) => setRecentFiles((items) => {
    const next = items.filter((item) => item.projectId !== projectId);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* optional */ }
    return next;
  });
  const clearRecentFiles = async () => {
    setMenuOpen(null);
    setSubmenu(null);
    if (!recentFiles.length) return;
    const confirmed = await askConfirm({ title: '清除最近清單？', message: '這只會清除 SceneForge 內的最近開啟清單，不會刪除劇本檔或資料庫。', confirmLabel: '清除', danger: true });
    if (!confirmed) return;
    try { localStorage.removeItem(RECENT_KEY); } catch { /* optional */ }
    setRecentFiles([]);
  };
  const activateProject = (opened: Project) => {
    setProjects((items) => [opened, ...items.filter((item) => item.id !== opened.id)]);
    activeProjectIdRef.current = opened.id;
    ++loadSequenceRef.current;
    versionsRef.current.set(opened.id, 0);
    historyRef.current = { past: [], future: [] };
    updateHistoryCount();
    installProject(opened);
    setSaveStatus('saved');
    setSaveError('');
    setWorkspaceView('script');
  };
  /** Before replacing the open script: offer to save unsaved changes. Returns false to stay. */
  const settleUnsaved = async () => {
    if (!project || !dirty) return true;
    const choice = await askConfirm({ title: `要儲存「${documentTitle}」嗎？`, message: '不儲存的話，這次的變更不會寫入劇本檔。', confirmLabel: '儲存', cancelLabel: '不儲存', thirdLabel: '取消' });
    if (choice === null) return false;
    if (choice) return await fileActionsRef.current.save();
    return true;
  };
  const askSaveAs = (name: string, protectedFile: boolean) => new Promise<{ name: string; password?: string } | null>((resolve) => {
    setSaveAsForm({ name, protect: protectedFile, password: '', confirm: '' });
    setSaveAsRequest({ resolve });
  });
  const askPassword = (name: string, wrong: boolean) => new Promise<string | null>((resolve) => {
    setPasswordDraft('');
    setPasswordRequest({ name, wrong, resolve });
  });
  const saveDocument = async (forceDialog = false, automatic = false): Promise<boolean> => {
    const current = projectRef.current;
    if (!current) return false;
    let info = docFile;
    // Scripts opened from a 0.4 .sceneforge file are saved as a new .sfe beside it.
    const legacyPath = !!info?.path && !info.path.toLowerCase().endsWith(`.${FILE_EXTENSION}`);
    const baseTitle = info?.name ?? current.title;
    if (desktop) {
      if (forceDialog) {
        const target = await desktop.saveDialog(baseTitle);
        if (!target) return false;
        info = { path: target, name: stripExtension(baseName(target)) };
      } else if (!info?.path || legacyPath) {
        // First save goes straight into the default script folder — no dialog to answer.
        const target = await desktop.defaultPath(baseTitle);
        info = { path: target, name: stripExtension(baseName(target)) };
      }
    } else if (forceDialog || !info) {
      const choice = await askSaveAs(baseTitle, false);
      if (!choice) return false;
      info = { name: choice.name };
    }
    if (!info) return false;
    if (automatic) {
      if (autoSaveRunningRef.current) return false;
      autoSaveRunningRef.current = true;
    }
    try {
      await flushProjectSave();
      const bytes = await encodeDocument(current, APP_CONFIG.version, info.password);
      if (desktop && info.path) await desktop.writeFile(info.path, bytes);
      else downloadBlob(`${safeFileName(info.name)}.${FILE_EXTENSION}`, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
      if (desktop && info.path?.toLowerCase().endsWith(`.${FILE_EXTENSION}`)) await api.registerProjectFile(current.id, info.path);
      setDocFile(info);
      setSavedStamp(current.updatedAt);
      setAutoSavedAt(automatic ? new Date().toISOString() : '');
      rememberDocFile(current.id, info, current.updatedAt);
      addRecent({ path: info.path, projectId: current.id, name: info.name, openedAt: new Date().toISOString() });
      if (!automatic) notify(desktop && info.path && !docFile?.path ? `已存到 ${info.path}` : '已存檔');
      return true;
    } catch (error) {
      setProjectError(error instanceof Error ? `存檔失敗：${error.message}` : '存檔失敗。');
      return false;
    } finally { if (automatic) autoSaveRunningRef.current = false; }
  };
  const openDocumentBytes = async (bytes: Uint8Array, path?: string, fallbackName = '劇本') => {
    const name = path ? stripExtension(baseName(path)) : stripExtension(fallbackName);
    let password: string | undefined;
    let doc;
    for (;;) {
      try { doc = await decodeDocument(bytes, password); break; }
      catch (error) {
        if (error instanceof PasswordRequiredError || error instanceof WrongPasswordError) {
          const answer = await askPassword(name, error instanceof WrongPasswordError);
          if (answer === null) return;
          password = answer;
          continue;
        }
        throw error;
      }
    }
    // The file is the source of truth: it replaces this computer's working copy, which is kept as a snapshot first.
    const incoming = doc.project;
    const known = await api.listProjects().catch(() => [] as ProjectSummary[]);
    let opened: Project;
    if (known.some((item) => item.id === incoming.id)) {
      await api.createSnapshot(incoming.id).catch(() => undefined);
      opened = await api.saveProject(incoming);
    } else {
      opened = await api.createProject(incoming);
    }
    if (path?.toLowerCase().endsWith(`.${FILE_EXTENSION}`)) await api.registerProjectFile(opened.id, path);
    activateProject(opened);
    const info: DocFileInfo = { path, name, password };
    setDocFile(info);
    setSavedStamp(opened.updatedAt);
    rememberDocFile(opened.id, info, opened.updatedAt);
    addRecent({ path, projectId: opened.id, name, openedAt: new Date().toISOString() });
  };
  const openPath = async (path: string) => {
    if (!desktop || !(await settleUnsaved())) return;
    try { await openDocumentBytes(await desktop.readFile(path), path); }
    catch (error) { setProjectError(error instanceof Error ? `無法開啟「${baseName(path)}」：${error.message}` : '無法開啟檔案。'); }
  };
  openPathRef.current = (path: string) => { void openPath(path); };
  const openDocument = async () => {
    setMenuOpen(null);
    if (!(await settleUnsaved())) return;
    if (!desktop) { documentInputRef.current?.click(); return; }
    try {
      const picked = await desktop.openDialog();
      if (picked) await openDocumentBytes(picked.bytes, picked.path);
    } catch (error) { setProjectError(error instanceof Error ? `無法開啟檔案：${error.message}` : '無法開啟檔案。'); }
  };
  const openRecent = async (entry: RecentFile) => {
    if (entry.path) {
      if (!desktop || !(await settleUnsaved())) return;
      try { await openDocumentBytes(await desktop.readFile(entry.path, entry.projectId), entry.path); }
      catch { if (await askConfirm({ title: `找不到「${entry.name}」`, message: '檔案可能已移動或刪除。要從最近清單移除嗎？', confirmLabel: '移除' })) forgetRecent(entry); }
      return;
    }
    if (!(await settleUnsaved())) return;
    await loadProject(entry.projectId);
  };
  const closeDocument = async () => {
    setMenuOpen(null);
    if (!(await settleUnsaved())) return;
    ++loadSequenceRef.current;
    activeProjectIdRef.current = '';
    installProject(null);
  };
  fileActionsRef.current = { save: () => saveDocument(false), saveAs: () => saveDocument(true), open: () => { void openDocument(); }, create: () => { void startFresh(); } };
  useEffect(() => { desktop?.setDocumentState({ title: documentTitle, dirty }); }, [documentTitle, dirty]);
  useEffect(() => {
    desktop?.onOpenPath((path) => openPathRef.current(path));
    desktop?.onSaveBeforeClose((shouldSaveFile) => shouldSaveFile ? fileActionsRef.current.save() : flushProjectSave());
  }, []);
  useEffect(() => {
    try { localStorage.setItem(AUTO_SAVE_KEY, autoSaveEnabled ? 'on' : 'off'); } catch { /* optional */ }
  }, [autoSaveEnabled]);
  useEffect(() => {
    try { localStorage.setItem(STORY_MARKERS_KEY, showStoryMarkers ? 'on' : 'off'); } catch { /* optional */ }
  }, [showStoryMarkers]);
  useEffect(() => {
    const path = docFile?.path;
    if (!desktop || !autoSaveEnabled || !project || !path || !dirty || !path.toLowerCase().endsWith(`.${FILE_EXTENSION}`)) return;
    return scheduleDocumentAutoSave(() => {
      if (!autoSaveRunningRef.current) void saveDocument(false, true);
    }, { target: window, delayMs: 20_000 });
  }, [autoSaveEnabled, docFile?.path, dirty, project?.updatedAt]);

  const importFile = async (file: File) => {
    setMenuOpen(null);
    setProjectError('');
    setImportBusy(true);
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error('檔案超過 30 MiB。大型文件請改用文件索引。');
      const extension = file.name.toLowerCase().split('.').at(-1) ?? '';
      if (extension === 'json') {
        const source = await file.text();
        let parsed: unknown;
        try { parsed = JSON.parse(source); } catch { throw new Error('JSON 格式無效。'); }
        if (isProjectData(parsed)) {
          const imported = validateProjectData(parsed);
          const duplicate = projects.some((item) => item.title === imported.title);
          setImportPreview({ fileName: file.name, title: duplicate ? `${imported.title}（匯入副本）` : imported.title, blocks: imported.blocks, project: imported, warnings: [] });
        } else {
          setPendingAnalyzerFile(file);
          setWorkspaceView('index');
        }
        return;
      }
      await openStudioForFile(file);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : '檔案無法匯入。');
    } finally {
      setImportBusy(false);
    }
  };

  const handleUnifiedImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) await importFile(file);
  };

  const openStudioForFile = async (file: File) => {
    const extracted = await extractFile(file);
    if (!extracted.blocks && !extracted.text.trim()) throw new Error('這個檔案沒有可讀取的文字（掃描版 PDF 需要先 OCR）。');
    setStudioSource({ fileName: file.name, kind: extracted.kind, encoding: extracted.encoding, text: extracted.text, blocks: extracted.blocks });
  };

  const handleDroppedFile = async (file: File) => {
    setProjectError('');
    try {
      const extension = file.name.toLowerCase().split('.').at(-1) ?? '';
      if (SCENEFORGE_EXTENSIONS.has(extension)) {
        if (!(await settleUnsaved())) return;
        const path = desktop?.getPathForFile(file) || undefined;
        const bytes = desktop && path ? await desktop.readFile(path) : new Uint8Array(await file.arrayBuffer());
        await openDocumentBytes(bytes, path, file.name);
        return;
      }
      if (!IMPORT_EXTENSIONS.has(extension)) {
        setProjectError(`不支援「${file.name}」。只接受 .sfe／.sceneforge 劇本及支援的匯入格式。`);
        return;
      }
      await importFile(file);
    } catch (error) {
      setProjectError(error instanceof Error ? `檔案無法開啟或匯入：${error.message}` : '檔案無法開啟或匯入。');
    }
  };

  const confirmStudio = async (value: ImportConfirm) => {
    if (value.target === 'current' && projectRef.current) {
      // Insert after the paragraph the cursor is in (or at the end), with fresh ids.
      const incoming = value.blocks.map((block) => ({ ...block, id: id() }));
      const anchor = activeEditorId;
      mutateProject((current) => {
        const at = anchor ? current.blocks.findIndex((block) => block.id === anchor) : -1;
        const index = at >= 0 ? at + 1 : current.blocks.length;
        const known = new Set(current.entities.map((entity) => entity.name));
        const entities = value.createEntities ? value.characters.filter((name) => !known.has(name)).map((name) => ({ id: id(), name, aliases: [], description: '' })) : [];
        return { ...current, blocks: [...current.blocks.slice(0, index), ...incoming, ...current.blocks.slice(index)], entities: [...current.entities, ...entities] };
      });
      if (!studioSource?.blocks) updateImportMemory(learnFromImport(importMemory, value.result));
      if (incoming[0]) focusRequestRef.current = { id: incoming[0].id, position: 0 };
      setStudioSource(null);
      setWorkspaceView('script');
      notify(`已加入 ${incoming.length} 段（可按 Ctrl+Z 復原）`);
      return;
    }
    if (!(await settleUnsaved())) return;
    setImportBusy(true);
    try {
      const base = createEmptyProject(value.title);
      const entities: Entity[] = value.createEntities ? value.characters.map((name) => ({ id: id(), name, aliases: [], description: '' })) : [];
      const meta = value.result.metadata;
      const pick = (...keys: string[]) => keys.map((key) => meta[key]).find((item) => item?.trim());
      const titlePage: TitlePage = Object.fromEntries(Object.entries({
        title: value.title,
        author: pick('編劇', '编剧', '作者', 'author', 'Author', 'Credit'),
        subtitle: pick('集數', '集数', 'Episode'),
        draft: pick('版本', 'version', 'Draft'),
        date: pick('日期', 'date', 'Draft date'),
        contact: pick('Contact', '聯絡'),
        basedOn: pick('Source', '原著'),
      }).filter(([, item]) => item)) as TitlePage;
      await createImportedProject({ ...base, blocks: value.blocks.length ? value.blocks : base.blocks, entities, titlePage, kind: 'film', settings: { preset: value.preset, showActHeadings: false, autoContinuation: true } });
      if (!studioSource?.blocks) updateImportMemory(learnFromImport(importMemory, value.result));
      setStudioSource(null);
      setProjectError('');
      notify(`已建立「${value.title}」`);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : '建立匯入劇本失敗。');
    } finally { setImportBusy(false); }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setImportBusy(true);
    try {
      const draft = importPreview.project
        ? { ...importPreview.project, title: importPreview.title.trim() || '匯入副本' }
        : {
            ...createEmptyProject(importPreview.title.trim() || '匯入劇本'),
            blocks: importPreview.blocks.length ? importPreview.blocks : [{ id: id(), type: 'scene' as const, text: '' }],
          };
      await createImportedProject(draft);
      setImportPreview(null);
      setProjectError('');
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : '建立匯入副本失敗。');
    } finally { setImportBusy(false); }
  };


  const exportFountain = () => {
    if (!project) return;
    const printable = project.blocks.filter((block) => block.type !== 'note' && (block.type !== 'act' || (project.settings?.showActHeadings ?? project.kind !== 'film')));
    const renderedBlocks = withContinuationCues(printable, formatSettings.preset === 'taiwan-work' ? 'taiwan-work' : 'us-screenplay', project.settings?.autoContinuation !== false);
    const cover = project.titlePage ?? {};
    const titleLines = [
      `Title: ${cover.title || project.title}`,
      cover.subtitle && `Episode: ${cover.subtitle}`,
      cover.author && `Credit: 編劇\nAuthor: ${cover.author}`,
      cover.basedOn && `Source: ${cover.basedOn}`,
      cover.draft && `Draft: ${cover.draft}`,
      cover.date && `Draft date: ${cover.date}`,
      cover.contact && `Contact: ${cover.contact}`,
    ].filter(Boolean).join('\n');
    downloadText(`${safeFileName(project.title)}.fountain`, `${titleLines}\n\n${blocksToFountain(renderedBlocks)}`, 'text/plain;charset=utf-8');
    setMenuOpen(null);
  };

  const exportPlainText = () => {
    if (!project) return;
    const printable = project.blocks.filter((block) => block.type !== 'note' && (block.type !== 'act' || (project.settings?.showActHeadings ?? project.kind !== 'film')));
    const renderedBlocks = withContinuationCues(printable, formatSettings.preset === 'taiwan-work' ? 'taiwan-work' : 'us-screenplay', project.settings?.autoContinuation !== false);
    downloadText(`${safeFileName(project.title)}.txt`, blocksToPlainText(renderedBlocks), 'text/plain;charset=utf-8');
    setMenuOpen(null);
  };




  const toggleMenu = (name: MenuName) => { setZoomPopoverOpen(false); setSubmenu(null); setMenuOpen((open) => open === name ? null : name); };
  const headerMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!menuOpen || event.nativeEvent.isComposing) return;
    const group = event.currentTarget;
    const target = event.target as HTMLElement;
    const names = ['file', 'edit', 'view', 'format', 'tools'] as const;
    if (event.key === 'Escape') {
      event.preventDefault();
      setSubmenu(null);
      setMenuOpen(null);
      requestAnimationFrame(() => group.querySelector<HTMLButtonElement>(`[data-menu-trigger="${menuOpen}"]`)?.focus());
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (target.matches('input, select, textarea')) return;
      event.preventDefault();
      const root = group.querySelector<HTMLElement>(`[data-menu-name="${menuOpen}"] > .header-menu-popover:not(.submenu)`);
      const activeSubmenu = target.closest<HTMLElement>('.header-menu-popover.submenu');
      const menu = activeSubmenu ?? root;
      if (!menu) return;
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>(':scope > button[role^="menuitem"]:not(:disabled), :scope > .has-submenu > button[role^="menuitem"]:not(:disabled)'));
      if (!items.length) return;
      const index = items.indexOf(target.closest('button') as HTMLButtonElement);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      items[index < 0 ? (direction > 0 ? 0 : items.length - 1) : (index + direction + items.length) % items.length]?.focus();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const activeSubmenu = target.closest<HTMLElement>('.header-menu-popover.submenu');
    const submenuCloseKey = submenuPlacement.side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const submenuOpenKey = submenuPlacement.side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (event.key === submenuCloseKey && activeSubmenu) {
      event.preventDefault();
      const parent = activeSubmenu.closest<HTMLElement>('.has-submenu');
      const parentItem = parent?.querySelector<HTMLButtonElement>(':scope > button[role^="menuitem"]');
      setSubmenu(null);
      requestAnimationFrame(() => parentItem?.focus());
      return;
    }
    const submenuParent = target.closest<HTMLElement>('.has-submenu[data-submenu]');
    if (event.key === submenuOpenKey && submenuParent) {
      event.preventDefault();
      const id = submenuParent.dataset.submenu as 'import' | 'export' | 'recent' | 'paragraph' | undefined;
      if (!id) return;
      setSubmenu(id);
      requestAnimationFrame(() => submenuParent.querySelector<HTMLButtonElement>('.submenu button[role^="menuitem"]:not(:disabled)')?.focus());
      return;
    }
    event.preventDefault();
    const index = names.indexOf(menuOpen as typeof names[number]);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = names[(index + direction + names.length) % names.length];
    setSubmenu(null);
    setMenuOpen(next);
    requestAnimationFrame(() => group.querySelector<HTMLButtonElement>(`[data-menu-trigger="${next}"]`)?.focus());
  };

  useLayoutEffect(() => {
    const place = () => {
      const group = menuGroupRef.current;
      if (!group || !menuOpen) {
        setMenuAlignment((value) => value === 'left' ? value : 'left');
        setSubmenuPlacement((value) => value.side === 'right' && value.vertical === 'down' ? value : { side: 'right', vertical: 'down' });
        return;
      }
      const root = group.querySelector<HTMLElement>(`[data-menu-name="${menuOpen}"] > .header-menu-popover:not(.submenu)`);
      const trigger = group.querySelector<HTMLElement>(`[data-menu-trigger="${menuOpen}"]`);
      if (root && trigger) {
        const menuRect = root.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        const menuWidth = root.offsetWidth || menuRect.width;
        const menuHeight = root.offsetHeight || menuRect.height;
        const align = triggerRect.left + menuWidth > window.innerWidth - 8 && triggerRect.right - menuWidth >= 8 ? 'right' : 'left';
        const desiredLeft = align === 'right' ? triggerRect.right - menuWidth : triggerRect.left;
        const desiredTop = triggerRect.bottom + 6 + menuHeight > window.innerHeight - 8 ? triggerRect.top - menuHeight - 6 : triggerRect.bottom + 6;
        root.style.position = 'fixed';
        root.style.right = 'auto';
        root.style.left = `${Math.round(Math.max(8, Math.min(desiredLeft, window.innerWidth - menuWidth - 8)))}px`;
        root.style.top = `${Math.round(Math.max(8, Math.min(desiredTop, window.innerHeight - menuHeight - 8)))}px`;
        setMenuAlignment((value) => value === align ? value : align);
      }
      if (!submenu) {
        setSubmenuPlacement((value) => value.side === 'right' && value.vertical === 'down' ? value : { side: 'right', vertical: 'down' });
        return;
      }
      const host = group.querySelector<HTMLElement>(`.has-submenu[data-submenu="${submenu}"]`);
      const flyout = host?.querySelector<HTMLElement>(':scope > .submenu');
      if (!host || !flyout) return;
      const hostRect = host.getBoundingClientRect();
      const flyoutRect = flyout.getBoundingClientRect();
      const side = hostRect.left + flyoutRect.width + 6 > window.innerWidth - 8 && hostRect.left - flyoutRect.width - 6 >= 8 ? 'left' : 'right';
      const below = window.innerHeight - hostRect.bottom - 6;
      const above = hostRect.top - 6;
      const vertical = flyoutRect.height > below && above > below ? 'up' : 'down';
      setSubmenuPlacement((value) => value.side === side && value.vertical === vertical ? value : { side, vertical });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [menuOpen, submenu, zoomFactor]);


  const renameLocation = (from: string) => {
    const to = locationDraft.trim();
    if (!to || to === from) return;
    setRememberedLocations((items) => [...new Set(items.map((item) => item === from ? to : item))]);
    if (locationRenameInScript && project) mutateProject((current) => ({ ...current, blocks: current.blocks.map((block) => block.type === 'scene' ? { ...block, text: block.text.replace(from, to) } : block) }));
    setLocationRename(null); setLocationDraft(''); setLocationRenameInScript(false);
  };

  const renderRequest = (current: Project) => ({ project: current, format: { paper: formatSettings.paper, fontPt: formatSettings.fontPt, lineSpacing: effectiveScriptLineSpacing(current.blocks, formatSettings.preset, formatSettings.lineSpacing), paragraphSpacing: formatSettings.paragraphSpacing }, fonts: scriptFonts, options: { template: formatSettings.preset === 'taiwan-work' ? 'zh-inline' as const : 'hollywood' as const } });
  const fontFamilyName = (id: string, fallback: string) => { const font = fontList.find((item) => item.id === id); return font?.css ?? font?.family ?? fallback; };

  // The export layout starts from the script's own format: 台式 prints the scene number first and 角色：對白 on one line.
  const openExportDialog = (kind: 'pdf' | 'docx') => {
    setMenuOpen(null); setSubmenu(null);
    if (!project) return;
    setExportOptions((current) => ({ ...current, template: formatSettings.preset === 'taiwan-work' ? 'zh-inline' : 'hollywood', sceneNumbers: formatSettings.preset === 'taiwan-work' ? true : current.sceneNumbers }));
    setExportDialog(kind);
  };
  const exportPdf = () => openExportDialog('pdf');
  const exportDocx = () => openExportDialog('docx');
  const currentExportOptions = (): ExportOptions => ({
    template: exportOptions.template,
    sceneNumbers: exportOptions.sceneNumbers,
    anonymous: exportOptions.anonymous,
    revised: exportOptions.revisions && revisionBase ? revisedIds : [],
  });
  const runExportPdf = async () => {
    if (!project) return;
    setExportDialog(null);
    if (IS_DEMO) { interceptDemoDownload(`${safeFileName(project.title)}.pdf`); return; }
    setExportBusy('正在排版 PDF…');
    try { downloadBlob(`${safeFileName(project.title)}${exportOptions.anonymous ? '-匿名' : ''}.pdf`, await api.renderPdf({ ...renderRequest(project), includeCover: exportOptions.includeCover, options: currentExportOptions() })); notify('PDF 已匯出'); }
    catch (error) { setProjectError(error instanceof Error ? error.message : 'PDF 產生失敗。'); }
    finally { setExportBusy(''); }
  };
  const runExportDocx = async () => {
    if (!project) return;
    setExportDialog(null);
    setExportBusy('正在產生 Word 檔…');
    try {
      const blob = await projectToDocx(project, formatSettings, { latin: fontFamilyName(scriptFonts.latin, 'Courier Prime'), cjk: fontFamilyName(scriptFonts.cjk, 'Noto Sans Mono CJK TC') }, { template: exportOptions.template, sceneNumbers: exportOptions.sceneNumbers, includeCover: exportOptions.includeCover, anonymous: exportOptions.anonymous });
      downloadBlob(`${safeFileName(project.title)}${exportOptions.anonymous ? '-匿名' : ''}.docx`, blob);
      notify('Word 檔已匯出');
    } catch (error) { setProjectError(error instanceof Error ? error.message : 'Word 檔產生失敗。'); }
    finally { setExportBusy(''); }
  };
  const exportFdx = () => {
    if (!project) return;
    downloadText(`${safeFileName(project.title)}.fdx`, projectToFdx(project), 'application/xml;charset=utf-8');
    notify('Final Draft 檔已匯出');
    setMenuOpen(null);
  };

  const refreshFonts = useCallback(async () => {
    if (IS_DEMO) return;
    try {
      // The computer's fonts are read in the background the first time; keep asking until that finishes.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await api.listFonts();
        setFontList(result.fonts);
        if (!result.scanning && (attempt > 0 || result.fonts.some((font) => font.system))) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } catch { /* server without font support */ }
  }, []);
  useEffect(() => { void refreshFonts(); }, [refreshFonts]);
  useEffect(() => {
    if (!project) return;
    if (project.settings?.fonts) { setScriptFonts(project.settings.fonts); return; }
    try { const saved = JSON.parse(localStorage.getItem(`${FONTS_KEY_PREFIX}${project.id}`) ?? 'null'); setScriptFonts(saved?.latin && saved?.cjk ? saved : DEFAULT_FONTS); } catch { setScriptFonts(DEFAULT_FONTS); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  // Fonts travel with the script file, so it looks the same on another computer that has them.
  const chooseFont = (slot: 'latin' | 'cjk', id: string) => {
    const next = { ...scriptFonts, [slot]: id };
    setScriptFonts(next);
    mutateProject((current) => ({ ...current, settings: { ...(current.settings ?? { preset: formatSettings.preset === 'taiwan-work' ? 'taiwan-work' : 'us-screenplay' }), preset: current.settings?.preset ?? (formatSettings.preset === 'taiwan-work' ? 'taiwan-work' : 'us-screenplay'), fonts: next } }));
  };
  // Screen fonts come from the same files the PDF engine embeds, so what you see is what prints.
  const fontSource = (id: string, bold = false) => {
    const font = fontList.find((item) => item.id === id);
    if (font?.system && font.local?.length) return font.local.map((name) => `local("${name.replace(/"/g, '')}")`).join(', ');
    return `url("/api/fonts/${id}/file${bold ? '?bold=1' : ''}")`;
  };
  useEffect(() => {
    if (IS_DEMO) return;
    const css = `
@font-face { font-family: "SF Script Latin"; src: ${fontSource(scriptFonts.latin)}; unicode-range: U+0000-2DFF, U+A640-A6FF, U+FB00-FB4F; font-weight: 400; }
${scriptFonts.latin === 'courier-prime' ? `@font-face { font-family: "SF Script Latin"; src: ${fontSource('courier-prime', true)}; unicode-range: U+0000-2DFF; font-weight: 700; }` : ''}
@font-face { font-family: "SF Script CJK"; src: ${fontSource(scriptFonts.cjk)}; font-weight: 400; }
:root { --font-script: "SF Script Latin", "SF Script CJK", "Courier Prime", "Courier New", "SceneForge Noto Mono CJK TC", monospace; }`;
    let style = document.getElementById('sf-script-fonts');
    if (!style) { style = document.createElement('style'); style.id = 'sf-script-fonts'; document.head.append(style); }
    if (style.textContent === css) return;
    style.textContent = css;
    requestAnimationFrame(() => { const page = document.querySelector<HTMLElement>('.script-page'); if (page) fitTextareasIn(page); });
    document.fonts?.ready.then(() => { const page = document.querySelector<HTMLElement>('.script-page'); if (page) fitTextareasIn(page); }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptFonts, fontList]);

  // Page count and runtime from the real print layout, refreshed shortly after typing pauses.
  useEffect(() => {
    if (!project) { setStats(null); return; }
    if (IS_DEMO) {
      // No print-layout engine in the browser demo: estimate breaks from the editor's own wrapping.
      setStats(null);
      const timer = window.setTimeout(() => {
        if (!document.querySelector('.script-editor')) return; // keep the last estimate while another view is open
        const estimateFormat = { ...formatSettings, lineSpacing: effectiveScriptLineSpacing(project.blocks, formatSettings.preset, formatSettings.lineSpacing) };
        const estimate = estimatePages(project.blocks.filter((block) => block.type !== 'act' || (project.settings?.showActHeadings ?? project.kind !== 'film')), editorLineCount, estimateFormat);
        setPageStarts(estimate.pageStarts);
        setSceneEighths(estimate.sceneEighths);
      }, 500);
      return () => window.clearTimeout(timer);
    }
    let current = true;
    const timer = window.setTimeout(() => {
      api.renderStats(renderRequest(project)).then((result) => {
        if (!current) return;
        setStats(result.stats);
        setPageStarts(result.pageStarts);
        setSceneEighths(result.sceneEighths);
      }).catch(() => {
        if (!current) return;
        setStats(null);
        setPageStarts([]);
      });
    }, 1200);
    return () => { current = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, formatSettings, scriptFonts]);

  const openBackups = () => {
    setMenuOpen(null);
    setBackupsOpen(true);
  };
  // 還原整體備份前先送出排隊中的存檔；還原後重新載入最新的劇本。
  const flushPendingSave = async () => {
    const current = projectRef.current;
    if (current) { const queued = saveQueuesRef.current.get(current.id); if (queued) await queued.catch(() => undefined); }
  };
  const reloadAfterBackupRestore = async () => {
    const list = await refreshProjects();
    if (list?.[0]) await loadProject(list[0].id); else installProject(null);
  };

  // ——— Revision marks & version compare ———
  const revisedIds = useMemo(() => revisionBase && project ? revisedBlockIds(revisionBase.project, project) : [], [revisionBase, project]);
  const revisedSet = useMemo(() => new Set(revisedIds), [revisedIds]);
  const pageStartMap = useMemo(() => new Map(pageStarts.map((item) => [item.blockId, item])), [pageStarts]);
  useEffect(() => {
    setRevisionBase(null);
    if (!project || IS_DEMO) return;
    let baseId = '';
    try { baseId = localStorage.getItem(`sceneforge-revision-${project.id}`) ?? ''; } catch { /* optional */ }
    if (baseId) api.getSnapshot(project.id, baseId).then((snap) => setRevisionBase({ id: baseId, createdAt: snap.createdAt, project: snap.project })).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  const openCompare = () => {
    setMenuOpen(null);
    setCompareOpen(true);
  };
  const useAsRevisionBase = (base: RevisionBase | null) => {
    setRevisionBase(base);
    try { if (project) { if (base) localStorage.setItem(`sceneforge-revision-${project.id}`, base.id); else localStorage.removeItem(`sceneforge-revision-${project.id}`); } } catch { /* optional */ }
    notify(base ? '修訂標記已開啟：與此版本不同的段落會標上 *' : '修訂標記已關閉');
  };
  const clearRevisionBase = () => {
    setRevisionBase(null);
    try { if (project) localStorage.removeItem(`sceneforge-revision-${project.id}`); } catch { /* optional */ }
  };

  // ——— Find & replace ———
  const findMatches = useMemo(() => {
    const query = findQuery;
    if (!findOpen || !query || !project) return [] as { blockId: string; start: number; end: number }[];
    const needle = query.toLocaleLowerCase();
    const out: { blockId: string; start: number; end: number }[] = [];
    for (const block of project.blocks) {
      const hay = block.text.toLocaleLowerCase();
      let at = hay.indexOf(needle);
      while (at >= 0 && out.length < 5000) { out.push({ blockId: block.id, start: at, end: at + query.length }); at = hay.indexOf(needle, at + Math.max(1, query.length)); }
    }
    return out;
  }, [findOpen, findQuery, project]);
  const showMatch = useCallback((index: number) => {
    const match = findMatches[index];
    if (!match) { setFindHighlight(null); return; }
    const editor = document.getElementById(`editor-${match.blockId}`) as HTMLTextAreaElement | null;
    if (!editor) return;
    editor.closest('article')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFindHighlight({ blockId: match.blockId, rects: rangeRects(editor, match.start, match.end).map((rect) => ({ ...rect, left: rect.left + editor.offsetLeft, top: rect.top + editor.offsetTop })) });
  }, [findMatches]);
  useEffect(() => { if (findOpen) showMatch(Math.min(findIndex, Math.max(0, findMatches.length - 1))); else setFindHighlight(null); }, [findOpen, findIndex, findMatches, showMatch]);
  const stepFind = (delta: number) => { if (findMatches.length) setFindIndex((index) => (index + delta + findMatches.length) % findMatches.length); };
  const replaceCurrent = () => {
    const match = findMatches[findIndex];
    if (!match) return;
    mutateProject((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === match.blockId ? { ...block, text: block.text.slice(0, match.start) + replaceText + block.text.slice(match.end) } : block) }));
  };
  const replaceAll = () => {
    if (!findQuery || !findMatches.length) return;
    const count = findMatches.length;
    const needle = findQuery.toLocaleLowerCase();
    mutateProject((current) => ({ ...current, blocks: current.blocks.map((block) => {
      const hay = block.text.toLocaleLowerCase();
      if (!hay.includes(needle)) return block;
      let out = '';
      let from = 0;
      let at = hay.indexOf(needle);
      while (at >= 0) { out += block.text.slice(from, at) + replaceText; from = at + findQuery.length; at = hay.indexOf(needle, from); }
      return { ...block, text: out + block.text.slice(from) };
    }) }));
    notify(`已取代 ${count} 處`);
  };
  const openFind = () => {
    setMenuOpen(null);
    setWorkspaceView('script');
    setFindOpen(true);
    const selected = (document.activeElement as HTMLTextAreaElement | null);
    if (selected?.classList?.contains('script-editor') && selected.selectionEnd > selected.selectionStart) setFindQuery(selected.value.slice(selected.selectionStart, selected.selectionEnd));
    requestAnimationFrame(() => { findInputRef.current?.focus(); findInputRef.current?.select(); });
  };

  openFindRef.current = openFind;

  // ——— Writing goal ———
  const changeGoal = (value: number) => { setGoal(value); try { localStorage.setItem('sceneforge-goal', String(value)); } catch { /* optional */ } };

  // ——— Comments ———
  const commentsByBlock = useMemo(() => {
    const map = new Map<string, ScriptComment[]>();
    for (const comment of project?.comments ?? []) map.set(comment.blockId, [...(map.get(comment.blockId) ?? []), comment]);
    return map;
  }, [project?.comments]);
  const addComment = (blockId: string) => {
    const text = commentDraft.trim();
    if (!text) return;
    mutateProject((current) => ({ ...current, comments: [...(current.comments ?? []), { id: id(), blockId, text, createdAt: new Date().toISOString() }] }));
    setCommentDraft('');
  };
  const updateComment = async (commentId: string, change: Partial<ScriptComment> | null) => {
    if (change) {
      mutateProject((current) => ({ ...current, comments: (current.comments ?? []).flatMap((comment) => comment.id !== commentId ? [comment] : [{ ...comment, ...change }]) }));
      return;
    }
    const comment = projectRef.current?.comments?.find((item) => item.id === commentId);
    if (!comment) return;
    const confirmed = await askConfirm({ title: '刪除這則註解？', message: `「${comment.text.slice(0, 100)}${comment.text.length > 100 ? '…' : ''}」會移除，可以用 Ctrl+Z 復原。`, confirmLabel: '刪除註解', cancelLabel: '取消', danger: true });
    if (!confirmed) return;
    mutateProject((current) => ({ ...current, comments: (current.comments ?? []).filter((item) => item.id !== commentId) }));
    notify('已刪除註解（可復原）');
  };

  // ——— Scene cards ———
  const updateSceneMeta = (sceneId: string, meta: SceneMeta) => mutateProject((current) => ({ ...current, sceneMeta: { ...(current.sceneMeta ?? {}), [sceneId]: meta } }));
  const deleteScene = async (sceneId: string) => {
    const current = projectRef.current;
    if (!current) return;
    const start = current.blocks.findIndex((block) => block.id === sceneId && block.type === 'scene');
    if (start < 0) return;
    let end = current.blocks.length;
    for (let index = start + 1; index < current.blocks.length; index += 1) {
      if (current.blocks[index].type === 'scene' || current.blocks[index].type === 'act') { end = index; break; }
    }
    const deleted = current.blocks.slice(start, end);
    const number = current.blocks.slice(0, start).filter((block) => block.type === 'scene').length + 1;
    const heading = current.blocks[start].text.trim() || '未命名場景';
    const confirmed = await askConfirm({ title: `刪除第 ${number} 場？`, message: `「${heading}」這場的 ${deleted.length} 個段落會一起刪除。可以用 Ctrl+Z 復原。`, confirmLabel: '刪除', cancelLabel: '取消', danger: true });
    if (!confirmed) return;
    const deletedIds = new Set(deleted.map((block) => block.id));
    const fallback = current.blocks.slice(end).find((block) => block.type === 'scene') ?? current.blocks.slice(0, start).reverse().find((block) => block.type === 'scene');
    if (deletedIds.has(activeEditorId)) {
      setActiveEditorId(fallback?.id ?? '');
      focusRequestRef.current = fallback ? { id: fallback.id, position: 0 } : null;
    }
    mutateProject((latest) => removeSceneFromProject(latest, sceneId));
    notify(`已刪除第 ${number} 場（可復原）`);
  };
  const renameActTitle = (actId: string, title: string) => mutateProject((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === actId && block.type === 'act' ? { ...block, text: title } : block) }));
  // Story chronology: rank every scene by the order given (1-based), keeping other card data.
  const reorderStory = (orderedSceneIds: string[]) => mutateProject((current) => {
    const meta = { ...(current.sceneMeta ?? {}) };
    orderedSceneIds.forEach((sceneId, index) => { meta[sceneId] = { ...meta[sceneId], storyOrder: index + 1 }; });
    return { ...current, sceneMeta: meta };
  });
  const renameCharacter = async (from: string, to: string): Promise<string | false> => {
    if (!project || !from || !to) return false;
    const normalizeName = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase();
    const fromKey = normalizeName(from);
    const toKey = normalizeName(to);
    if (fromKey === toKey) return from;
    const primaryNames = profileNames(project);
    const targetEntity = project.entities.find((entity) => normalizeName(entity.name) === toKey && normalizeName(entity.name) !== fromKey);
    const profileName = Object.keys(project.bible ?? {}).find((name) => normalizeName(name) === toKey && normalizeName(name) !== fromKey);
    const scriptName = analyzeStory(project).characters.find((character) => normalizeName(character.name) === toKey && normalizeName(character.name) !== fromKey)?.name;
    const existingName = targetEntity?.name ?? profileName ?? scriptName ?? primaryNames.find((name) => normalizeName(name) === toKey && normalizeName(name) !== fromKey);
    const aliasOwner = project.entities.find((entity) => normalizeName(entity.name) !== fromKey && entity.aliases.some((alias) => normalizeName(alias) === toKey));
    if (!existingName && aliasOwner) {
      setProjectError(`「${to}」已是「${aliasOwner.name}」的其他稱呼，不能改成角色名稱。`);
      return false;
    }
    if (existingName) {
      const sourceEntity = project.entities.find((entity) => normalizeName(entity.name) === toKey);
      const sourceNames = new Set([toKey, ...(sourceEntity?.aliases ?? []).map(normalizeName)]);
      let speaker = '';
      let dialogueLines = 0;
      for (const block of project.blocks) {
        if (block.type === 'scene' || block.type === 'act') speaker = '';
        else if (block.type === 'character') speaker = normalizeName(block.text.replace(/\s*\((?:V\.O\.|O\.S\.|O\.C\.)\)\s*$/iu, ''));
        else if (block.type === 'dialogue' && sourceNames.has(speaker)) dialogueLines += 1;
      }
      const confirm = await askConfirm({
        title: `要把「${existingName}」合併到「${from}」嗎？`,
        message: `「${existingName}」的 ${dialogueLines} 句台詞與人物設定會算在「${from}」名下；${existingName} 的人物設定欄位會補進 ${from} 的空白欄位；劇本文字不會被改。可以用 Ctrl+Z 復原。`,
        confirmLabel: '合併', cancelLabel: '取消', danger: true,
      });
      if (!confirm) return false;
      mutateProject((current) => syncMindMapIdentities(mergeCharacters(current, existingName, from)));
      setProjectError('');
      notify(`已將「${existingName}」合併到「${from}」`);
      return from;
    }
    const ok = await askConfirm({ title: `把「${from}」改名為「${to}」？`, message: `劇本中的角色名稱、動作與對白裡出現的「${from}」、人物關係、知情表與設定集都會一起修改。可以按 Ctrl+Z 復原。`, confirmLabel: '改名' });
    if (!ok) return false;
    const swap = (text: string) => text.split(from).join(to);
    const renameNode = (node: MindNode): MindNode => ({ ...node, text: swap(node.text), children: node.children.map(renameNode) });
    mutateProject((current) => ({
      ...current,
      blocks: current.blocks.map((block) => block.type === 'note' ? block : { ...block, text: swap(block.text) }),
      entities: current.entities.map((entity) => entity.name === from ? { ...entity, name: to } : entity),
      relations: current.relations?.map((relation) => ({ ...relation, from: relation.from === from ? to : relation.from, to: relation.to === from ? to : relation.to })),
      bible: current.bible && Object.fromEntries(Object.entries(current.bible).map(([name, profile]) => [name === from ? to : name, profile])),
      facts: current.facts?.map((fact) => ({ ...fact, known: Object.fromEntries(Object.entries(fact.known).map(([who, scene]) => [who === from ? to : who, scene])) })),
      factColumns: current.factColumns?.map((who) => who === from ? to : who),
      mindmap: current.mindmap && renameNode(current.mindmap),
    }));
    notify(`已將「${from}」改名為「${to}」`);
    return to;
  };
  const updateProfile = (name: string, profile: CharacterProfile) => mutateProject((current) => ({ ...current, bible: { ...(current.bible ?? {}), [name]: profile } }));
  const addCharacterProfileDraft = () => {
    if (!projectRef.current) return;
    const draftId = id();
    const previousDraftId = parseCharacterDraftFocusKey(bibleCharacterFocus);
    mutateProject((current) => {
      const next = previousDraftId ? discardEmptyCharacterDraft(current, previousDraftId) : current;
      return addCharacterDraft(next, draftId);
    });
    setWorkspaceView('story');
    setStoryWorkspaceTab('people');
    setBibleCharacterFocus(characterDraftFocusKey(draftId));
  };
  const commitCharacterProfileDraft = async (draftId: string, name: string): Promise<string | false> => {
    const current = projectRef.current;
    if (!current) return false;
    const attempt = commitCharacterDraft(current, draftId, name);
    if (attempt.status === 'missing' || attempt.status === 'empty-name') return false;
    let mergeInto: string | undefined;
    if (attempt.status === 'duplicate') {
      const duplicate = attempt.duplicate;
      const accepted = await askConfirm({
        title: `角色名稱「${name}」已存在`,
        message: `要將新角色資料合併到「${duplicate}」嗎？只會補入既有設定的空白欄位，不會改寫劇本文字。可以用 Ctrl+Z 復原。`,
        confirmLabel: '合併到既有角色', cancelLabel: '返回修改',
      });
      if (!accepted) return false;
      mergeInto = duplicate;
    }
    const transaction: { result: ReturnType<typeof commitCharacterDraft> | null } = { result: null };
    mutateProject((latest) => {
      transaction.result = commitCharacterDraft(latest, draftId, name, mergeInto ? { mergeInto } : undefined);
      return transaction.result.status === 'committed' || transaction.result.status === 'merged' ? transaction.result.project : latest;
    });
    const result = transaction.result;
    if (!result || (result.status !== 'committed' && result.status !== 'merged')) return false;
    setProjectError('');
    notify(result.status === 'merged' ? `已將新增資料合併到「${result.name}」` : `已新增角色「${result.name}」`);
    return result.name;
  };
  const deleteCharacterProfile = (name: string) => {
    mutateProject((current) => { const bible = { ...(current.bible ?? {}) }; delete bible[name]; return { ...current, bible }; });
    notify(`已刪除「${name}」人物設定（可復原）`);
  };
  const updateAliases = (name: string, aliases: string[]) => mutateProject((current) => {
    const existing = current.entities.find((entity) => entity.name === name);
    return syncMindMapIdentities({ ...current, entities: existing ? current.entities.map((entity) => entity.id === existing.id ? { ...entity, aliases } : entity) : [...current.entities, { id: id(), name, aliases, description: '' }] });
  });
  const dismissIdentity = (key: string) => mutateProject((current) => ({ ...current, dismissedIdentitySuggestions: [...new Set([...(current.dismissedIdentitySuggestions ?? []), key])] }));
  const mergeIdentity = ([primary, alias]: [string, string], key: string) => mutateProject((current) => {
    const existing = current.entities.find((entity) => entity.name === primary);
    const updated = existing ? current.entities.map((entity) => entity.id === existing.id ? { ...entity, aliases: [...new Set([...entity.aliases, alias])] } : entity) : [...current.entities, { id: id(), name: primary, aliases: [alias], description: '' }];
    return syncMindMapIdentities({ ...current, entities: updated, dismissedIdentitySuggestions: [...new Set([...(current.dismissedIdentitySuggestions ?? []), key])] });
  });
  const openStoryRecord = (tab: StoryWorkspaceTab, record?: { kind: 'claim' | 'thread'; id: string }) => { setWorkspaceView('story'); setStoryWorkspaceTab(tab === 'records' ? 'records' : tab); if (record) setFocusedStoryRecord(record); setParagraphMenu(null); };
  const linkParagraphThread = (recordId: string, mode: 'setup' | 'payoff') => {
    if (!paragraphMenu) return;
    const sceneId = sceneHeadingId(project?.blocks ?? [], paragraphMenu.blockId);
    if (!sceneId) return;
    mutateProject((current) => {
      const threadProject = current.claims.some((claim) => claim.id === recordId) ? setStoryRecordKind(current, recordId, 'thread') : current;
      return { ...threadProject, threads: threadProject.threads.map((thread) => thread.id === recordId ? { ...thread, [mode === 'setup' ? 'setupBlockId' : 'payoffBlockId']: sceneId } : thread) };
    });
    openStoryRecord('records', { kind: 'thread', id: recordId });
  };
  const createParagraphRecord = () => {
    if (!paragraphMenu || !project || paragraphMenu.mode !== 'new') return;
    const title = (paragraphMenu.draft || paragraphMenu.selectedText).trim();
    if (!title) return;
    const sceneId = sceneHeadingId(project.blocks, paragraphMenu.blockId);
    if (!sceneId) return;
    if (paragraphMenu.kind === 'claim') {
      const claim: Claim = { id: id(), text: title, status: 'confirmed', sourceBlockId: sceneId };
      mutateProject((current) => ({ ...current, claims: [...current.claims, claim], recordOrder: [...getStoryRecordOrder(current), claim.id] }));
      openStoryRecord('records', { kind: 'claim', id: claim.id });
      return;
    }
    const thread: Thread = { id: id(), title, status: 'open', setupBlockId: sceneId };
    mutateProject((current) => ({ ...current, threads: [...current.threads, thread], recordOrder: [...getStoryRecordOrder(current), thread.id] }));
    openStoryRecord('records', { kind: 'thread', id: thread.id });
  };
  const linkParagraphClaim = (recordId: string) => {
    if (!paragraphMenu) return;
    const sceneId = sceneHeadingId(project?.blocks ?? [], paragraphMenu.blockId);
    if (!sceneId) return;
    mutateProject((current) => ({ ...current, claims: current.claims.map((claim) => claim.id === recordId ? { ...claim, sourceBlockId: sceneId } : claim) }));
    openStoryRecord('records', { kind: 'claim', id: recordId });
  };
  const saveReferenceNote = (sourceRef: { documentId: string; title: string; excerpt: string; locator?: string }) => {
    const thread: Thread = { id: id(), title: sourceRef.excerpt.trim().slice(0, 300) || sourceRef.title, status: 'open', sourceRef };
    mutateProject((current) => ({ ...current, threads: [...current.threads, thread] }));
    setFocusedStoryRecord({ kind: 'thread', id: thread.id }); setWorkspaceView('story'); setStoryWorkspaceTab('records');
  };
  const castNames = () => new Set(project ? analyzeStory(project).characters.map((info) => info.name) : []);
  const applyName = async (name: string) => {
    const target = activeBlock?.type === 'character' ? activeBlock : null;
    if (target) { changeBlockText(target.id, name); notify(`已填入角色「${name}」`); setNamesOpen(false); return; }
    try { await navigator.clipboard.writeText(name); notify(`已複製「${name}」`); } catch { notify(name); }
  };
  const runConvert = async () => {
    if (!project) return;
    setConvertOpen(false);
    setExportBusy('正在轉換…');
    try {
      const converted = await convertProject(project, convertOptions.direction, convertOptions.phrases);
      mutateProject(() => converted);
      notify(convertOptions.direction === 'to-simplified' ? '已轉為簡體（可按 Ctrl+Z 復原）' : '已轉為繁體（可按 Ctrl+Z 復原）');
    } catch (error) { setProjectError(error instanceof Error ? error.message : '轉換失敗。'); }
    finally { setExportBusy(''); }
  };
  const exportBible = async () => {
    if (!project) return;
    const analysis = analyzeStory(project);
    const names = [...new Set([...analysis.characters.map((info) => info.name), ...Object.keys(project.bible ?? {})])];
    const sections = names.map((name) => {
      const info = analysis.characters.find((item) => item.name === name);
      const profile = project.bible?.[name] ?? {};
      return {
        name,
        stats: info ? `台詞 ${info.lines} 句・出場 ${info.scenes.length} 場` : '',
        fields: PROFILE_FIELDS.filter((field) => profile[field]?.trim()).map((field) => ({ label: PROFILE_LABELS[field].label, value: profile[field]!.trim() })),
      };
    }).filter((section) => section.fields.length || section.stats);
    const outline: { title: string; summary: string; scenes: string[] }[] = [];
    let number = 0;
    for (const block of project.blocks) {
      if (block.type === 'act') outline.push({ title: block.text.trim(), summary: project.sceneMeta?.[block.id]?.summary ?? '', scenes: [] });
      if (block.type === 'scene') {
        number += 1;
        if (!outline.length) outline.push({ title: '開場', summary: '', scenes: [] });
        const summary = project.sceneMeta?.[block.id]?.summary;
        outline[outline.length - 1].scenes.push(`${number}. ${block.text.trim()}${summary ? `　${summary}` : ''}`);
      }
    }
    setExportBusy('正在產生設定集…');
    try { downloadBlob(`${safeFileName(project.title)}-設定集.docx`, await bibleToDocx(project, sections, outline, unitName(project.kind))); notify('設定集已匯出'); }
    catch (error) { setProjectError(error instanceof Error ? error.message : '設定集匯出失敗。'); }
    finally { setExportBusy(''); }
  };
  const moveScene = (sceneId: string, target: { beforeSceneId?: string; endOfActId?: string }) => {
    if (target.beforeSceneId === sceneId) return;
    mutateProject((current) => {
      const blocks = [...current.blocks];
      const start = blocks.findIndex((block) => block.id === sceneId);
      if (start < 0) return current;
      let end = start + 1;
      while (end < blocks.length && blocks[end].type !== 'scene' && blocks[end].type !== 'act') end += 1;
      const chunk = blocks.splice(start, end - start);
      let insertAt = blocks.length;
      if (target.beforeSceneId) insertAt = blocks.findIndex((block) => block.id === target.beforeSceneId);
      else if (target.endOfActId !== undefined) {
        const actIndex = target.endOfActId ? blocks.findIndex((block) => block.id === target.endOfActId) : -1;
        insertAt = blocks.findIndex((block, index) => index > actIndex && block.type === 'act');
        if (insertAt < 0) insertAt = blocks.length;
      }
      if (insertAt < 0) return current;
      blocks.splice(insertAt, 0, ...chunk);
      return { ...current, blocks };
    });
    notify('已調整場景順序');
  };


  useEffect(() => {
    const onDemoDownload = (event: Event) => setDemoDownload((event as CustomEvent<{ name: string; text?: string }>).detail);
    window.addEventListener('sf-demo-download', onDemoDownload);
    return () => window.removeEventListener('sf-demo-download', onDemoDownload);
  }, []);

  const openTrash = () => {
    setMenuOpen(null);
    setTrashOpen(true);
  };

  const moveProjectToTrash = async (projectId: string) => {
    const target = projects.find((item) => item.id === projectId);
    if (!target) return;
    if (!(await askConfirm({ title: `將「${target.title}」移至垃圾桶？`, message: '專案內容、版本快照與對應的 .sfe 檔會一起移入 SceneForge 垃圾桶，可在期限內還原。', confirmLabel: '移至垃圾桶', danger: true }))) return;
    try {
      const recentPath = recentFiles.find((item) => item.projectId === projectId)?.path;
      const filePath = (projectRef.current?.id === projectId ? docFile?.path : undefined) ?? readDocFile(projectId).info?.path ?? recentPath;
      if (desktop && filePath?.toLowerCase().endsWith(`.${FILE_EXTENSION}`)) await api.registerProjectFile(projectId, filePath);
      if (projectRef.current?.id === projectId) {
        const queued = saveQueuesRef.current.get(projectId);
        if (queued) await queued.catch(() => undefined);
        const latest = projectRef.current;
        if (latest) await api.saveProject(latest);
      }
      await api.trashProject(projectId);
      const [remaining, trash] = await Promise.all([api.listProjects(), api.listTrash()]);
      if (remaining.some((item) => item.id === projectId) || !trash.projects.some((item) => item.id === projectId)) throw new Error('移至垃圾桶後的讀回驗證失敗。');
      setProjects(remaining);
      forgetRecentProject(projectId);
      if (projectRef.current?.id === projectId) {
        ++loadSequenceRef.current;
        activeProjectIdRef.current = '';
        installProject(null);
        setWorkspaceView('script');
      }
      setProjectError('');
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : '無法將專案移至垃圾桶。');
    }
  };

  const afterTrashRestore = async (projectId: string) => {
    const restoredPath = await api.getProjectFilePath(projectId).catch(() => null);
    if (restoredPath) {
      const restored = await api.getProject(projectId);
      const previous = readDocFile(projectId).info;
      const info = { path: restoredPath, name: stripExtension(baseName(restoredPath)), password: previous?.password };
      rememberDocFile(projectId, info, restored.updatedAt);
      setDocFile(info);
      forgetRecentProject(projectId);
      addRecent({ path: restoredPath, projectId, name: info.name, openedAt: new Date().toISOString() });
    }
    setProjects(await api.listProjects());
    await loadProject(projectId);
  };

  const addBlock = (type: BlockType = 'action') => {
    const newBlock: Block = { id: id(), type, text: '' };
    focusRequestRef.current = { id: newBlock.id, position: 0 };
    mutateProject((current) => ({ ...current, blocks: [...current.blocks, newBlock] }));
  };

  const sceneStyle = formatSettings.preset === 'taiwan-work' ? 'taiwan' as const : 'hollywood' as const;
  // Mind maps saved before a merge still read 「男孩」: show them with merged names (saved on next edit).
  const mindmapProject = useMemo(() => project ? syncMindMapIdentities(project) : null, [project?.mindmap, project?.entities, project?.blocks]);
  const continuationCueIds = useMemo(() => project && project.settings?.autoContinuation !== false ? getContinuationCueIds(project.blocks) : new Set<string>(), [project?.blocks, project?.settings?.autoContinuation]);
  // 伏筆標記：每個場景標題有幾個鋪陳／回收（只在開啟標記時計算）。
  const storyMarkerCounts = useMemo(() => {
    const counts = new Map<string, { setup: number; payoff: number }>();
    if (!project || !showStoryMarkers) return counts;
    const bump = (blockId: string | undefined, key: 'setup' | 'payoff') => {
      const heading = sceneHeadingId(project.blocks, blockId ?? '');
      if (!heading) return;
      const entry = counts.get(heading) ?? { setup: 0, payoff: 0 };
      entry[key] += 1;
      counts.set(heading, entry);
    };
    for (const thread of project.threads) { bump(thread.setupBlockId, 'setup'); bump(thread.payoffBlockId, 'payoff'); }
    return counts;
  }, [project?.blocks, project?.threads, showStoryMarkers]); // eslint-disable-line react-hooks/exhaustive-deps
  const sceneLocationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const block of project?.blocks ?? []) if (block.type === 'scene') {
      const location = extractRememberedLocation(block.text);
      if (location) counts.set(location, (counts.get(location) ?? 0) + 1);
    }
    return counts;
  }, [project?.blocks]);
  const sceneLocations = useMemo(() => [...new Set([...rememberedLocations, ...sceneLocationCounts.keys()])]
    .sort((a, b) => (sceneLocationCounts.get(b) ?? 0) - (sceneLocationCounts.get(a) ?? 0) || a.localeCompare(b, 'zh-Hant')),
  [sceneLocationCounts, rememberedLocations]);

  const knownNames = useMemo(() => {
    const names = new Set<string>(project ? analyzeStory(project).characters.map((info) => info.name) : []);
    for (const entity of project?.entities ?? []) if (entity.name.trim()) names.add(entity.name.trim());
    return [...names];
  }, [project]);

  /** Pick-list for a character cue: the other half of the conversation first, then prefix matches. */
  const characterCandidates = (block: Block): string[] => {
    const typed = block.text;
    if (!typed.trim()) {
      const matches = knownNames;
      const partner = characterPartner(block);
      return partner ? [partner, ...matches.filter((name) => name !== partner)].slice(0, 8) : matches.slice(0, 8);
    }
    const people = knownNames.map((name) => ({
      name,
      aliases: project?.entities.find((entity) => entity.name === name)?.aliases ?? [],
    }));
    return getCharacterCandidates(typed, people, sceneStyle);
  };
  const characterCompletion = (block: Block): string => {
    const list = characterCandidates(block);
    const pick = list[(sceneSuggestionIndex[block.id] ?? 0) % Math.max(1, list.length)] ?? '';
    return pick.slice(block.text.length);
  };
  const characterPartner = (block: Block): string => {
    const typed = block.text;
    if (!typed.trim()) {
      const blocks = project?.blocks ?? [];
      const index = blocks.findIndex((item) => item.id === block.id);
      const recent: string[] = [];
      for (let cursor = index - 1; cursor >= 0 && recent.length < 2; cursor -= 1) {
        if (blocks[cursor].type === 'scene') break;
        if (blocks[cursor].type === 'character') { const name = speakerKey(blocks[cursor].text); if (name && !recent.includes(name)) recent.push(name); }
      }
      return recent[1] ?? '';
    }
    return '';
  };

  const acceptPick = (block: Block, text: string) => {
    focusRequestRef.current = { id: block.id, position: text.length };
    setSceneSuggestionIndex((items) => ({ ...items, [block.id]: 0 }));
    mutateProject((current) => ({ ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, text } : item) }));
  };

  const neighbourBlock = (blockId: string, direction: 1 | -1): Block | undefined => {
    if (!project) return undefined;
    const blocks = project.blocks;
    const index = blocks.findIndex((item) => item.id === blockId);
    if (index < 0) return undefined;
    const showActs = project.settings?.showActHeadings ?? project.kind !== 'film';
    for (let cursor = index + direction; cursor >= 0 && cursor < blocks.length; cursor += direction) if (blocks[cursor].type !== 'act' || showActs) return blocks[cursor];
    return undefined;
  };
  const focusBlockAt = (blockId: string, position: (editor: HTMLTextAreaElement) => number) => {
    const editor = document.getElementById(`editor-${blockId}`) as HTMLTextAreaElement | null;
    if (!editor) return;
    const offset = position(editor);
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(offset, offset);
    editor.scrollIntoView({ block: 'nearest' });
  };

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>, block: Block) => {
    const currentText = event.currentTarget.value;
    const native = event.nativeEvent;
    const atEnd = event.currentTarget.selectionStart === currentText.length && event.currentTarget.selectionEnd === currentText.length;
    if (native.isComposing || native.keyCode === 229 || native.which === 229) return;
    const el = event.currentTarget;
    const collapsed = el.selectionStart === el.selectionEnd;
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    // While a pick-list is open it owns the arrow keys; Esc closes it and hands them back to the editor.
    const typingInPick = dismissedSceneSuggestion !== block.id;

    if (block.type === 'character' && atEnd && typingInPick && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const list = characterCandidates(block);
      if (list.length > 0) {
        event.preventDefault();
        const current = sceneSuggestionIndex[block.id] ?? 0;
        setSceneSuggestionIndex((items) => ({ ...items, [block.id]: (current + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length }));
        return;
      }
    }
    if (event.key === 'Escape' && block.type === 'character') {
      setDismissedSceneSuggestion(block.id);
      return;
    }
    if (event.key === 'Escape' && block.type === 'scene') {
      setDismissedSceneSuggestion(block.id);
      return;
    }

    if (block.type === 'scene' && atEnd && typingInPick && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const completion = getSceneCompletion(currentText, sceneLocations, sceneSuggestionIndex[block.id] ?? 0, sceneStyle);
      if (completion.stage && completion.candidates.length > 0) {
        event.preventDefault();
        const current = sceneSuggestionIndex[block.id] ?? 0;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next = (current + delta + completion.candidates.length) % completion.candidates.length;
        setSceneSuggestionIndex((items) => ({ ...items, [block.id]: next }));
        setDismissedSceneSuggestion('');
        return;
      }
    }

    // Text-editor movement across paragraphs: up/down by visual line keeping the column,
    // left/right across paragraph edges, Backspace/Delete merge paragraphs.
    if (plain && collapsed && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const edge = caretEdge(el);
      const up = event.key === 'ArrowUp';
      if (up ? edge.first : edge.last) {
        const target = neighbourBlock(block.id, up ? -1 : 1);
        if (target) {
          event.preventDefault();
          focusBlockAt(target.id, (editor) => offsetOnEdgeLine(editor, up ? 'last' : 'first', edge.x));
        }
        return;
      }
    }
    if (plain && collapsed && event.key === 'ArrowLeft' && el.selectionStart === 0) {
      const target = neighbourBlock(block.id, -1);
      if (target) { event.preventDefault(); focusBlockAt(target.id, (editor) => editor.value.length); }
      return;
    }
    if (plain && collapsed && event.key === 'ArrowRight' && atEnd && !(block.type === 'character' && typingInPick && characterCompletion(block))) {
      const target = neighbourBlock(block.id, 1);
      if (target) { event.preventDefault(); focusBlockAt(target.id, () => 0); }
      return;
    }
    if (plain && collapsed && event.key === 'Backspace' && el.selectionStart === 0) {
      const target = neighbourBlock(block.id, -1);
      if (target) {
        event.preventDefault();
        focusRequestRef.current = { id: target.id, position: target.text.length };
        mutateProject((current) => ({ ...current, blocks: current.blocks.flatMap((item) => item.id === block.id ? [] : item.id === target.id ? [{ ...item, text: item.text + currentText }] : [item]) }));
      }
      return;
    }
    if (plain && collapsed && event.key === 'Delete' && atEnd) {
      const target = neighbourBlock(block.id, 1);
      if (target) {
        event.preventDefault();
        focusRequestRef.current = { id: block.id, position: currentText.length };
        mutateProject((current) => ({ ...current, blocks: current.blocks.flatMap((item) => item.id === target.id ? [] : item.id === block.id ? [{ ...item, text: currentText + target.text }] : [item]) }));
      }
      return;
    }

    if (event.key === 'Tab' && block.type === 'scene' && atEnd && dismissedSceneSuggestion !== block.id) {
      const completion = getSceneCompletion(currentText, sceneLocations, sceneSuggestionIndex[block.id] ?? 0, sceneStyle);
      if (completion.stage) {
        event.preventDefault();
        const candidate = completion.candidates[completion.candidateIndex] ?? completion.candidates[0];
        if (candidate) {
          const accepted = acceptSceneCompletion(currentText, candidate, sceneStyle);
          focusRequestRef.current = { id: block.id, position: accepted.text.length };
          mutateProject((current) => ({ ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, text: accepted.text } : item) }));
          setSceneSuggestionIndex((items) => ({ ...items, [block.id]: 0 }));
          setDismissedSceneSuggestion('');
        }
        return;
      }
    }

    if (block.type === 'character' && atEnd && !event.shiftKey && dismissedSceneSuggestion !== block.id && (event.key === 'Tab' || event.key === 'ArrowRight' || event.key === 'Enter')) {
      const ghost = characterCompletion(block);
      if (ghost) {
        const full = `${currentText}${ghost}`;
        if (event.key !== 'Enter') {
          event.preventDefault();
          focusRequestRef.current = { id: block.id, position: full.length };
          mutateProject((current) => ({ ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, text: full } : item) }));
          return;
        }
        if (currentText.trim()) {
          event.preventDefault();
          const nextBlock: Block = { id: id(), type: 'dialogue', text: '' };
          focusRequestRef.current = { id: nextBlock.id, position: 0 };
          mutateProject((current) => {
            const index = current.blocks.findIndex((item) => item.id === block.id);
            const blocks = [...current.blocks];
            blocks[index] = { ...blocks[index], text: full };
            blocks.splice(index + 1, 0, nextBlock);
            return { ...current, blocks };
          });
          return;
        }
      }
    }

    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const type = (event.shiftKey ? TAB_PREV : TAB_NEXT)[block.type];
      let text = currentText;
      if (type === 'parenthetical' && !text.trim()) text = '（）';
      if (block.type === 'parenthetical' && /^[（(]\s*[）)]$/.test(text)) text = '';
      focusRequestRef.current = { id: block.id, position: type === 'parenthetical' && text === '（）' ? 1 : text.length };
      mutateProject((current) => ({ ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, type, text } : item) }));
      return;
    }

    // Enter on an empty cue or line of dialogue steps out of the conversation.
    if (event.key === 'Enter' && !event.shiftKey && !currentText.trim() && (block.type === 'character' || block.type === 'dialogue' || block.type === 'parenthetical')) {
      event.preventDefault();
      focusRequestRef.current = { id: block.id, position: 0 };
      mutateProject((current) => ({ ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, type: 'action', text: '' } : item) }));
      return;
    }

    const intent = getEditorIntent({ key: event.key, shiftKey: event.shiftKey, isComposing: native.isComposing, keyCode: native.keyCode, which: native.which });
    if (intent === 'split-block') {
      event.preventDefault();
      const start = event.currentTarget.selectionStart;
      const end = event.currentTarget.selectionEnd;
      const before = currentText.slice(0, start);
      const after = currentText.slice(end);
      const nextBlock: Block = { id: id(), type: blockAfterEnter(block.type), text: after };
      focusRequestRef.current = { id: nextBlock.id, position: 0 };
      mutateProject((current) => {
        const index = current.blocks.findIndex((item) => item.id === block.id);
        if (index < 0) return current;
        const blocks = [...current.blocks];
        blocks[index] = { ...blocks[index], text: before };
        blocks.splice(index + 1, 0, nextBlock);
        return { ...current, blocks };
      });
      return;
    }
    if (intent === 'next-block' || intent === 'previous-block') {
      event.preventDefault();
      const index = project?.blocks.findIndex((item) => item.id === block.id) ?? -1;
      const nextIndex = intent === 'next-block' ? index + 1 : index - 1;
      if (nextIndex >= 0 && nextIndex < (project?.blocks.length ?? 0)) {
        const next = project?.blocks[nextIndex];
        if (next) document.getElementById(`editor-${next.id}`)?.focus();
      } else if (intent === 'next-block') {
        const nextType = BLOCK_ORDER[(BLOCK_ORDER.indexOf(block.type) + 1) % BLOCK_ORDER.length];
        addBlock(nextType);
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    }
  };

  const changeBlockText = (blockId: string, text: string) => {
    setDismissedSceneSuggestion('');
    setSceneSuggestionIndex((items) => ({ ...items, [blockId]: 0 }));
    mutateProject((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === blockId ? { ...block, text } : block) }));
  };

  const editClipboard = async (action: 'cut' | 'copy' | 'paste') => {
    const blockId = activeEditorId;
    const input = blockId ? document.getElementById(`editor-${blockId}`) as HTMLTextAreaElement | null : null;
    if (!input) { document.execCommand(action); return; }
    const value = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const restoreEditor = (position = start, selectionEnd = end) => requestAnimationFrame(() => {
      const editor = document.getElementById(`editor-${blockId}`) as HTMLTextAreaElement | null;
      editor?.focus({ preventScroll: true });
      editor?.setSelectionRange(position, selectionEnd);
    });
    if (action === 'copy' || action === 'cut') {
      if (start === end) return;
      try { await navigator.clipboard.writeText(value.slice(start, end)); }
      catch { input.focus({ preventScroll: true }); input.setSelectionRange(start, end); document.execCommand('copy'); }
      if (action === 'cut') {
        changeBlockText(blockId, value.slice(0, start) + value.slice(end));
        restoreEditor(start, start);
      } else restoreEditor();
      return;
    }
    try {
      const pasted = await navigator.clipboard.readText();
      changeBlockText(blockId, value.slice(0, start) + pasted + value.slice(end));
      restoreEditor(start + pasted.length, start + pasted.length);
    } catch { notify('無法讀取剪貼簿，請使用 Ctrl+V 貼上。'); }
  };

  const handleEditorBlur = (event: FocusEvent<HTMLTextAreaElement>, block: Block) => {
    if (block.type !== 'scene' || !project) return;
    const location = extractRememberedLocation(event.currentTarget.value);
    if (!location) return;
    const next = [location, ...rememberedLocations.filter((item) => item !== location)];
    setRememberedLocations(next);
  };

  const setBlockType = (blockId: string, type: BlockType) => {
    mutateProject((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === blockId ? { ...block, type } : block) }));
    requestAnimationFrame(() => document.getElementById(`editor-${blockId}`)?.focus());
  };




  const addRelation = (relation: Omit<Relation, 'id'>) => mutateProject((current) => ({ ...current, relations: [...(current.relations ?? []), { ...relation, id: id() }] }));
  const removeRelation = async (relationId: string) => {
    const relation = projectRef.current?.relations?.find((item) => item.id === relationId);
    if (!relation) return;
    const confirmed = await askConfirm({ title: '刪除這段人物關係？', message: `「${relation.from}」與「${relation.to}」的「${relation.label || relation.type}」關係會移除。可以用 Ctrl+Z 復原。`, confirmLabel: '刪除關係', cancelLabel: '取消', danger: true });
    if (!confirmed) return;
    mutateProject((current) => ({ ...current, relations: (current.relations ?? []).filter((item) => item.id !== relationId) }));
    notify('已刪除人物關係（可復原）');
  };
  const changeMindmap = async (tree: MindNode | undefined) => {
    const current = projectRef.current;
    // Compare with what the map displayed (merged identities folded in); otherwise a node folded
    // away by a character merge (男孩 → Ryan) looks like a deletion on every edit.
    const previous = current ? syncMindMapIdentities(current).mindmap : undefined;
    const nodesById = (root: MindNode | undefined) => {
      const nodes = new Map<string, string>();
      const visit = (node: MindNode) => { nodes.set(node.id, node.text); node.children.forEach(visit); };
      if (root) visit(root);
      return nodes;
    };
    const oldNodes = nodesById(previous);
    const nextNodes = nodesById(tree);
    const removed = [...oldNodes].filter(([nodeId]) => !nextNodes.has(nodeId));
    const sameShape = (a: MindNode | undefined, b: MindNode | undefined): boolean => !!a && !!b && a.text === b.text && a.children.length === b.children.length && a.children.every((child, index) => sameShape(child, b.children[index]));
    const regenerated = current ? mindmapFromProject(current) : undefined;
    if (removed.length && !sameShape(tree, regenerated)) {
      const labels = removed.slice(0, 5).map(([, text]) => `「${text}」`).join('、');
      const more = removed.length > 5 ? `等 ${removed.length} 個主題` : ` ${removed.length} 個主題`;
      const confirmed = await askConfirm({ title: `刪除心智圖中的${more.trim()}？`, message: `${labels}${removed.length > 5 ? '…' : ''}及其分支會從心智圖移除。可以用 Ctrl+Z 復原。`, confirmLabel: '刪除主題', cancelLabel: '取消', danger: true });
      if (!confirmed) return;
      notify(`已刪除心智圖 ${removed.length} 個主題（可復原）`);
    }
    mutateProject((latest) => {
      const { mindmap: _previous, ...rest } = latest;
      return tree ? { ...rest, mindmap: tree } : rest;
    });
  };
  const jumpToBlock = (blockId: string) => {
    setWorkspaceView('script');
    const jump = () => {
      const workspace = document.querySelector<HTMLElement>('.script-workspace');
      if (workspace?.hidden) { requestAnimationFrame(jump); return; }
      document.getElementById(`block-${blockId}`)?.scrollIntoView({ behavior: 'instant', block: 'start' });
      document.getElementById(`editor-${blockId}`)?.focus({ preventScroll: true });
    };
    requestAnimationFrame(jump);
  };

  const outline = useMemo(() => {
    const acts: { id: string; title: string; scenes: { block: Block; number: number }[] }[] = [];
    let number = 0;
    for (const block of project?.blocks ?? []) {
      if (block.type === 'act') acts.push({ id: block.id, title: block.text.trim() || '未命名幕', scenes: [] });
      else if (block.type === 'scene') {
        number += 1;
        if (!acts.length) acts.push({ id: '', title: '開場', scenes: [] });
        acts[acts.length - 1].scenes.push({ block, number });
      }
    }
    return acts;
  }, [project?.blocks]);
  const hasActs = outline.some((act) => act.id);

  useEffect(() => {
    if (!project) return;
    try { setCollapsedActs(JSON.parse(localStorage.getItem(`${COLLAPSED_ACTS_KEY_PREFIX}${project.id}`) ?? '[]')); } catch { setCollapsedActs([]); }
    // 使用者規則：關閉後再開啟一律從最上面開始，不自動捲到上次位置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const toggleAct = (actId: string) => setCollapsedActs((items) => {
    const next = items.includes(actId) ? items.filter((item) => item !== actId) : [...items, actId];
    try { if (project) localStorage.setItem(`${COLLAPSED_ACTS_KEY_PREFIX}${project.id}`, JSON.stringify(next)); } catch { /* optional */ }
    return next;
  });
  const updateTitlePage = (change: Partial<TitlePage>) => mutateProject((current) => ({ ...current, titlePage: { ...(current.titlePage ?? {}), ...change } }));

  const sceneBlocks = useMemo(() => (project?.blocks ?? []).map((block, index) => ({ block, index })).filter(({ block }) => block.type === 'scene'), [project?.blocks]);
  const storyAnalysis = useMemo(() => project ? analyzeStory(project) : null, [project]);
  const storyCharacterNames = useMemo(() => project ? profileNames(project) : [], [project]);
  // 圖譜與人物設定的左側清單一律依出場場次排序（主角在上、路人在下）。
  const relationRailPeople = useMemo(() => {
    const characters = storyAnalysis?.characters ?? [];
    const byName = new Map(characters.map((person) => [person.name, person] as const));
    return sortByAppearance(characters.map((person) => person.name), characters).map((name) => byName.get(name)!);
  }, [storyAnalysis]);
  const bibleRailNames = useMemo(() => sortByAppearance(storyCharacterNames, storyAnalysis?.characters ?? []), [storyCharacterNames, storyAnalysis]);
  const visibleScenes = useMemo(() => {
    if (!search.trim()) return sceneBlocks;
    const query = search.trim().toLocaleLowerCase();
    return sceneBlocks.filter(({ block }) => block.text.toLocaleLowerCase().includes(query));
  }, [sceneBlocks, search]);
  const wordCount = useMemo(() => countScriptLength(project?.blocks ?? []), [project?.blocks]);
  useEffect(() => {
    if (!project) { setGoalBase(null); return; }
    const key = `sceneforge-goal-base-${project.id}-${new Date().toLocaleDateString('sv')}`;
    try {
      const stored = localStorage.getItem(key);
      if (stored === null) { localStorage.setItem(key, String(wordCount)); setGoalBase(wordCount); } else setGoalBase(Number(stored));
    } catch { setGoalBase(wordCount); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  const todayWritten = goalBase === null ? 0 : Math.max(0, wordCount - goalBase);

  const startFresh = async () => {
    setMenuOpen(null);
    if (!(await settleUnsaved())) return;
    setNewProjectTitle('');
    setNewProjectOpen(true);
    setTimeout(() => document.getElementById('new-project-title')?.focus(), 0);
  };

  const hasDocumentFile = desktop ? !!docFile?.path : !!docFile?.name;
  const autoSavedTime = autoSavedAt ? new Date(autoSavedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
  const saveLabel = saveStatus === 'error' && saveError ? `儲存失敗：${saveError}` : saveStatus === 'saving' ? statusText.saving : !hasDocumentFile ? '尚未存檔（已暫存於 App）' : dirty ? (autoSaveEnabled ? '待自動存檔' : '未存檔') : autoSavedTime ? `已自動存檔 ${autoSavedTime}` : '已儲存';
  const isMacPlatform = /Mac|iPhone|iPad/i.test(navigator.platform);
  const zoomPercent = Math.round(zoomFactor * 100);
  const positionedSubmenuClass = `header-menu-popover submenu${submenuPlacement.side === 'left' ? ' submenu-left' : ''}${submenuPlacement.vertical === 'up' ? ' submenu-up' : ''}`;
  const rootMenuAlignmentClass = menuAlignment === 'right' ? ' popover-right' : '';
  const searchShortcut = isMacPlatform ? '⌘ K' : 'Ctrl K';
  const typeShortcut = (number: number) => isMacPlatform ? `⌘${number}` : `Ctrl+${number}`;
  const activeBlock = project?.blocks.find((block) => block.id === activeEditorId);
  useLayoutEffect(() => { syncSegmentThumbs(); });
  // The paragraph-type button lives in the page's left margin, level with the active line, so it
  // never sits on top of the text whatever the layout (台式 names, indented dialogue…).
  useLayoutEffect(() => {
    const place = () => {
      const page = document.querySelector<HTMLElement>('.script-page');
      const article = activeEditorId ? document.getElementById(`block-${activeEditorId}`) : null;
      if (!page || !article) { setTagTop(null); return; }
      setTagTop(Math.round(article.getBoundingClientRect().top - page.getBoundingClientRect().top));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [activeEditorId, project?.blocks, formatSettings, workspaceView, showPageBreaks, pageStarts]);
  useEffect(() => {
    const onResize = () => syncSegmentThumbs();
    window.addEventListener('resize', onResize);
    document.fonts?.ready.then(onResize).catch(() => undefined);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Any element change (menu, Tab, shortcut, Enter) flashes the margin tag so a switch is never silent.
  useEffect(() => {
    if (!activeBlock) { lastTypeRef.current = null; setElementMenuOpen(false); return; }
    const last = lastTypeRef.current;
    if (last && last.id === activeBlock.id && last.type !== activeBlock.type) setTypeFlash((flash) => ({ id: activeBlock.id, n: flash.n + 1 }));
    if (!last || last.id !== activeBlock.id) setElementMenuOpen(false);
    lastTypeRef.current = { id: activeBlock.id, type: activeBlock.type };
  }, [activeBlock?.id, activeBlock?.type]);

  const currentSceneId = useMemo(() => {
    if (!project || !activeEditorId) return '';
    const index = project.blocks.findIndex((block) => block.id === activeEditorId);
    for (let cursor = index; cursor >= 0; cursor -= 1) if (project.blocks[cursor].type === 'scene') return project.blocks[cursor].id;
    return '';
  }, [project, activeEditorId]);
  const editorStyle = {
    '--script-font-size': `${formatSettings.fontPt}pt`,
    '--script-line-height': String(effectiveScriptLineSpacing(project?.blocks ?? [], formatSettings.preset, formatSettings.lineSpacing)),
    '--script-paragraph-gap': `${formatSettings.paragraphSpacing}em`,
    '--script-paper-name': formatSettings.paper,
  } as CSSProperties;

  // 劇本段落透過 ref 取用最新的處理函式，段落本身才能保持 memo（打字時只重畫正在編輯的那一段）。
  scriptBlockHandlers.current = { setParagraphMenu, setCommentFor, setCommentDraft, setActiveEditorId, setCaretAtEnd, setDismissedSceneSuggestion, handleEditorBlur, handleEditorKeyDown, changeBlockText, characterCandidates, characterCompletion, acceptPick, updateComment: (commentId, change) => { void updateComment(commentId, change); }, addComment };

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''}${project ? '' : ' no-project'} format-${formatSettings.preset} paper-${formatSettings.paper}`} style={editorStyle}
      onDragEnter={(event) => { const feedback = inspectDrop(event.dataTransfer); if (feedback) { event.preventDefault(); setDragFeedback(feedback); } }}
      onDragOver={(event) => { const feedback = inspectDrop(event.dataTransfer); if (feedback) { event.preventDefault(); setDragFeedback(feedback); event.dataTransfer.dropEffect = feedback.kind === 'reject' ? 'none' : 'copy'; } }}
      onDragLeave={(event) => { if (event.relatedTarget === null || !(event.currentTarget as Node).contains(event.relatedTarget as Node)) setDragFeedback(null); }}
      onDrop={(event) => { const feedback = inspectDrop(event.dataTransfer); if (!feedback) return; event.preventDefault(); setDragFeedback(null); const files = Array.from(event.dataTransfer.files); if (feedback.kind === 'reject' || files.length !== 1) { setProjectError(feedback.message || '一次只能放入一個支援的檔案。'); return; } void handleDroppedFile(files[0]); }}>
      <header className="topbar">
        <button className="brand" aria-label={`關於 ${APP_CONFIG.name}`} title={`關於 ${APP_CONFIG.name}`} onClick={() => { setMenuOpen(null); setAboutOpen(true); }}>
          <img className="brand-logo" src={logoUrl} alt="" aria-hidden="true" draggable={false} />
          <span className="brand-name">{APP_CONFIG.name}</span>
        </button>
        <div className="top-left">
          <div className="menu-group" ref={menuGroupRef} onKeyDown={headerMenuKeyDown}>
            <div className="header-menu" data-menu-name="file">
              <button className="toolbar-button menu-trigger" data-menu-trigger="file" aria-haspopup="menu" aria-expanded={menuOpen === 'file'} onClick={() => toggleMenu('file')} onMouseEnter={() => { if (menuOpen && menuOpen !== 'file') { setSubmenu(null); setMenuOpen('file'); } }}>檔案<Chevron /></button>
              {menuOpen === 'file' && <div className={`header-menu-popover file-popover${rootMenuAlignmentClass}`} role="menu" aria-label="檔案">
                <button role="menuitem" onMouseEnter={() => setSubmenu(null)} onClick={() => void startFresh()}><span>開新檔案…</span></button>
                <button role="menuitem" onMouseEnter={() => setSubmenu(null)} onClick={() => void openDocument()}><span>開啟舊檔…</span></button>
                <div className="has-submenu" data-submenu="recent" onMouseEnter={() => setSubmenu('recent')}>
                  <button role="menuitem" aria-haspopup="menu" aria-expanded={submenu === 'recent'} disabled={!recentFiles.length} onClick={() => setSubmenu('recent')}><span>最近開啟</span><span className="submenu-arrow" aria-hidden="true">›</span></button>
                  {submenu === 'recent' && <div className={positionedSubmenuClass} role="menu" aria-label="最近開啟">
                    {recentFiles.slice(0, 10).map((entry) => <button key={entry.path ?? entry.projectId} role="menuitem" title={entry.path ?? entry.name} onClick={() => { setMenuOpen(null); void openRecent(entry); }}><span>{entry.name}</span><small>{new Date(entry.openedAt).toLocaleDateString('zh-TW')}</small></button>)}
                  </div>}
                </div>
                {desktop && <button role="menuitem" disabled={!recentFiles.length} onMouseEnter={() => setSubmenu(null)} onClick={() => void clearRecentFiles()}><span>清除最近清單…</span></button>}
                <hr />
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); void saveDocument(false); }}><span>儲存</span></button>
                <button className="menu-check-toggle" role="menuitemcheckbox" aria-checked={autoSaveEnabled} onMouseEnter={() => setSubmenu(null)} onClick={() => setAutoSaveEnabled((enabled) => !enabled)}><span>自動存檔</span><small>{autoSaveEnabled ? '開' : '關'}</small></button>
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); void saveDocument(true); }}><span>另存新檔…</span></button>
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => void closeDocument()}><span>關閉劇本</span></button>
                <button className="danger" role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { const projectId = project?.id; setMenuOpen(null); if (projectId) void moveProjectToTrash(projectId); }}><span>移至垃圾桶…</span></button>
                <hr />
                <div className="has-submenu" data-submenu="import" onMouseEnter={() => setSubmenu('import')}>
                  <button role="menuitem" aria-haspopup="menu" aria-expanded={submenu === 'import'} onClick={() => setSubmenu('import')}><span>匯入</span><span className="submenu-arrow" aria-hidden="true">›</span></button>
                  {submenu === 'import' && <div className={positionedSubmenuClass} role="menu" aria-label="匯入">
                    <button role="menuitem" onClick={() => { setMenuOpen(null); unifiedFileInputRef.current?.click(); }}><span>劇本或文字檔…</span><small>TXT · Word · PDF · FDX · MD</small></button>
                    <button role="menuitem" onClick={() => { setMenuOpen(null); setWorkspaceView('index'); }}><span>文件索引來源…</span><small>PDF · 對話紀錄</small></button>
                    <p>匯入時可選擇加到目前劇本，或建立新劇本。</p>
                  </div>}
                </div>
                <div className="has-submenu" data-submenu="export" onMouseEnter={() => setSubmenu('export')}>
                  <button role="menuitem" aria-haspopup="menu" aria-expanded={submenu === 'export'} disabled={!project} onClick={() => setSubmenu('export')}><span>匯出</span><span className="submenu-arrow" aria-hidden="true">›</span></button>
                  {submenu === 'export' && project && <div className={positionedSubmenuClass} role="menu" aria-label="匯出">
                    <button role="menuitem" onClick={() => void exportPdf()}><span>PDF</span><small>內嵌字型・專業分頁</small></button>
                    <button role="menuitem" onClick={() => void exportDocx()}><span>Word</span><small>.docx</small></button>
                    <button role="menuitem" onClick={exportFdx}><span>Final Draft</span><small>.fdx</small></button>
                    <button role="menuitem" onClick={exportFountain}><span>Fountain</span><small>.fountain</small></button>
                    <button role="menuitem" onClick={exportPlainText}><span>純文字</span><small>.txt</small></button>
                  </div>}
                </div>
                <hr />
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); setCoverOpen(true); }}><span>封面設定…</span></button>
                <hr />
                <button role="menuitem" onMouseEnter={() => setSubmenu(null)} onClick={() => void openBackups()}><span>整體資料備份…</span></button>
                <button role="menuitem" onMouseEnter={() => setSubmenu(null)} onClick={() => void openTrash()}><span>垃圾桶</span></button>
              </div>}
            </div>
            <div className="header-menu" data-menu-name="edit">
              <button className="toolbar-button menu-trigger" data-menu-trigger="edit" aria-haspopup="menu" aria-expanded={menuOpen === 'edit'} disabled={!project} onClick={() => toggleMenu('edit')} onMouseEnter={() => { if (menuOpen && menuOpen !== 'edit') { setSubmenu(null); setMenuOpen('edit'); } }}>編輯<Chevron /></button>
              {menuOpen === 'edit' && <div className={`header-menu-popover edit-popover${rootMenuAlignmentClass}`} role="menu" aria-label="編輯">
                <button role="menuitem" disabled={!project || !historyCount.undo} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); undo(); }}><span>復原</span><kbd>Ctrl+Z</kbd></button>
                <button role="menuitem" disabled={!project || !historyCount.redo} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); redo(); }}><span>重做</span><kbd>Ctrl+Y</kbd></button>
                <hr />
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => void editClipboard('cut')}><span>剪下</span></button>
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => void editClipboard('copy')}><span>複製</span></button>
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => void editClipboard('paste')}><span>貼上</span></button>
                <hr />
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); openFind(); }}><span>尋找與取代…</span><kbd>Ctrl+F</kbd></button>
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); setNamesOpen(true); }}><span>人名產生器…</span><small>姓氏・性別・風格</small></button>
                <hr />
                <span className="menu-label" role="none">插入段落</span>
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); addBlock('act'); }}><span>新增{unitName(project?.kind)}</span></button>
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); addBlock('scene'); }}><span>新增場景</span></button>
                <button role="menuitem" disabled={!project} onMouseEnter={() => setSubmenu(null)} onClick={() => { setMenuOpen(null); addBlock('action'); }}><span>新增段落</span></button>
                <button role="menuitem" disabled={!activeBlock} onMouseEnter={() => setSubmenu(null)} onClick={() => { if (activeBlock) { setMenuOpen(null); setCommentFor(activeBlock.id); setCommentDraft(''); } }}><span>為此段新增註解</span></button>
              </div>}
            </div>
            <div className="header-menu" data-menu-name="view">
              <button className="toolbar-button menu-trigger" data-menu-trigger="view" aria-haspopup="menu" aria-expanded={menuOpen === 'view'} onClick={() => toggleMenu('view')} onMouseEnter={() => { if (menuOpen && menuOpen !== 'view') { setSubmenu(null); setMenuOpen('view'); } }}>檢視<Chevron /></button>
              {menuOpen === 'view' && <div className={`header-menu-popover view-popover${rootMenuAlignmentClass}`} role="menu" aria-label="檢視">
                <Switch className="menu-switch" checked={showPageBreaks} disabled={!project} onChange={(next) => { setShowPageBreaks(next); try { localStorage.setItem('sceneforge-page-breaks', next ? 'on' : 'off'); } catch { /* optional */ } }} label="在稿紙上顯示分頁" />
                <Switch className="menu-switch" checked={showStoryMarkers} disabled={!project} onChange={(next) => { setShowStoryMarkers(next); }} label="顯示伏筆標記" />
                <hr />
                <Switch className="menu-switch" checked={focusMode} disabled={!project} onChange={(next) => { setFocusMode(next); }} label="專注模式" />
                <button role="menuitem" disabled={!desktop} onClick={() => { setMenuOpen(null); void desktop?.toggleFullscreen(); }}><span>切換全螢幕</span><kbd>F11</kbd></button>

              </div>}
            </div>
            <div className="header-menu" data-menu-name="format">
              <button className="toolbar-button menu-trigger" data-menu-trigger="format" aria-haspopup="menu" aria-expanded={menuOpen === 'format'} onClick={() => toggleMenu('format')} onMouseEnter={() => { if (menuOpen && menuOpen !== 'format') { setSubmenu(null); setMenuOpen('format'); } }}>格式<Chevron /></button>
              {menuOpen === 'format' && <div className={`header-menu-popover format-popover${rootMenuAlignmentClass}`} role="menu" aria-label="格式">
                {project && <div className="format-fixed">
                  <span className="menu-label">劇本格式</span>
                  <div className="format-preset-switch" role="radiogroup" aria-label="劇本格式" data-seg>
                    {(['taiwan-work', 'us-screenplay'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={formatSettings.preset === value} className={formatSettings.preset === value ? 'active' : ''} onClick={() => void changeScriptPreset(value)}>{value === 'taiwan-work' ? '台式劇本' : '美式劇本'}</button>)}
                  </div>
                  <small>{formatSettings.paper === 'a4' ? 'A4' : 'US Letter'} · {formatSettings.fontPt} pt</small>
                  <p>切換只換版面，內容不變；分頁、頁數與片長會重新計算。</p>
                </div>}
                <span className="menu-label" role="none">劇本字型</span>
                <div className="font-pickers">
                  <div className="font-picker"><span>英文</span><Select ariaLabel="英文劇本字型" className="format-font-select" value={scriptFonts.latin} options={(fontList.length ? fontList : [{ id: 'courier-prime', family: 'Courier Prime', bundled: true, latin: true, cjk: false }]).filter((font) => font.latin).map((font) => ({ value: font.id, label: `${font.family}${font.bundled ? '（內建）' : ''}` }))} onChange={(value) => chooseFont('latin', value)} /></div>
                  <div className="font-picker"><span>中文</span><Select ariaLabel="中文劇本字型" className="format-font-select" value={scriptFonts.cjk} options={(fontList.length ? fontList : [{ id: 'noto-mono-cjk', family: 'Noto Sans Mono CJK TC', bundled: true, latin: false, cjk: true }]).filter((font) => font.cjk).map((font) => ({ value: font.id, label: `${font.family}${font.bundled ? '（內建）' : ''}` }))} onChange={(value) => chooseFont('cjk', value)} /></div>
                </div>
                <p>排版依實際字寬計算，換字型後頁數會跟著變；片長估計以標準劇本行數計算，不受字型影響。</p>
                <hr />
                {project && <Switch className="menu-switch" checked={project.settings?.autoContinuation !== false} onChange={(next) => { mutateProject((current) => ({ ...current, settings: { ...(current.settings ?? { preset: formatSettings.preset === 'taiwan-work' ? 'taiwan-work' : 'us-screenplay' }), autoContinuation: next } })); }} label="自動加上（續）／(CONT'D)" />}
                {project && <Switch className="menu-switch" checked={project.settings?.showActHeadings ?? project.kind !== 'film'} onChange={(next) => { mutateProject((current) => ({ ...current, settings: { ...(current.settings ?? { preset: formatSettings.preset === 'taiwan-work' ? 'taiwan-work' : 'us-screenplay' }), showActHeadings: next } })); }} label="在稿紙與輸出顯示幕／集標題" />}
              </div>}
            </div>
            <div className="header-menu" data-menu-name="tools">
              <button className="toolbar-button menu-trigger" data-menu-trigger="tools" aria-haspopup="menu" aria-expanded={menuOpen === 'tools'} onClick={() => toggleMenu('tools')} onMouseEnter={() => { if (menuOpen && menuOpen !== 'tools') { setSubmenu(null); setMenuOpen('tools'); } }}>工具<Chevron /></button>
              {menuOpen === 'tools' && <div className={`header-menu-popover tools-popover${rootMenuAlignmentClass}`} role="menu" aria-label="工具">
                <span className="menu-label" role="none">劇本管理</span>
                <button role="menuitem" disabled={!project} onClick={() => { setMenuOpen(null); setLocationsOpen(true); setLocationRename(null); setLocationDraft(''); }}><span>管理場景地點…</span></button>
                <button role="menuitem" disabled={!project} onClick={() => { setMenuOpen(null); setReportsOpen(true); }}><span>製作報表…</span></button>
                <button role="menuitem" disabled={!project} onClick={() => void openCompare()}><span>版本比對與修訂…</span></button>
                <hr />
                <span className="menu-label" role="none">寫作工具</span>
                <button role="menuitem" disabled={!project} onClick={() => { setMenuOpen(null); setGoalOpen(true); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.goal-button')?.focus()); }}><span>今日寫作目標…</span></button>
                <button role="menuitem" disabled={!project} onClick={() => { setMenuOpen(null); setConvertOpen(true); }}><span>繁簡轉換…</span><small>整份劇本，可復原</small></button>
              </div>}
            </div>
          </div>
          <div className="history-buttons">
            <button className="icon-button" aria-label="復原" title="復原" disabled={!project || !historyCount.undo} onClick={undo}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5 4 8.5 7.5 12" /><path d="M4.5 8.5h7a4.5 4.5 0 0 1 0 9H9" /></svg></button>
            <button className="icon-button" aria-label="重做" title="重做" disabled={!project || !historyCount.redo} onClick={redo}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 5 16 8.5 12.5 12" /><path d="M15.5 8.5h-7a4.5 4.5 0 0 0 0 9H11" /></svg></button>
          </div>
        </div>
        <div className="project-heading">
          {project ? <input className="project-title" aria-label="劇本名稱" value={project.title} size={Math.max(4, Array.from(project.title).length + 1)} onChange={(event) => mutateProject((current) => ({ ...current, title: event.target.value }))} /> : <span className="project-heading-empty">SceneForge</span>}
        </div>
        {project && <nav className="workspace-tabs" aria-label="工作區" data-seg>
          <button className={workspaceView === 'script' ? 'active' : ''} aria-pressed={workspaceView === 'script'} onClick={() => setWorkspaceView('script')}>劇本</button>
          <button className={workspaceView === 'story' ? 'active' : ''} aria-pressed={workspaceView === 'story'} onClick={() => setWorkspaceView('story')}>故事</button>
          <button className={workspaceView === 'map' ? 'active' : ''} aria-pressed={workspaceView === 'map'} onClick={() => setWorkspaceView('map')}>圖譜</button>
        </nav>}
        {project && <span className={`save-state ${saveStatus === 'error' ? 'save-error' : dirty ? 'save-dirty' : 'save-saved'}`} title={saveLabel}>
          <span className="save-dot" />{saveStatus === 'error' ? <button className="text-button" onClick={() => { setSaveError(''); setSaveStatus('dirty'); setRetryTick((tick) => tick + 1); }}>重試</button> : <button className="text-button save-label" onClick={() => void saveDocument(false)}>{saveLabel}</button>}
        </span>}
        <div className="top-actions">
          <input ref={unifiedFileInputRef} className="visually-hidden" type="file" accept=".txt,.md,.markdown,.fountain,.fdx,.docx,.pdf,.rtf,.html,.htm,.json,text/plain,application/json" onChange={(event) => void handleUnifiedImport(event)} aria-label="選取劇本或專案檔案" />
          <div className="icon-group">
            <button className="icon-button" aria-label="快捷鍵說明" title="快捷鍵" onClick={() => { setMenuOpen(null); setHelpOpen(true); }}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="5" width="15" height="10" rx="2" /><path d="M5.5 8h1M9.5 8h1M13.5 8h1M6.5 12h7" /></svg>
            </button>

            {project && <button className={`icon-button ${focusMode ? 'pressed' : ''}`} aria-label={focusMode ? '離開專注模式' : '專注模式'} title={focusMode ? '離開專注模式' : '專注模式'} onClick={() => setFocusMode((value) => !value)}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 3H3v4.5M12.5 3H17v4.5M3 12.5V17h4.5M17 12.5V17h-4.5" /></svg>
            </button>}
          </div>
        </div>
      </header>

      {listError && <div className="global-error" role="alert"><span>{listError}</span><button onClick={() => void refreshProjects()}>重新連線</button></div>}
      {projectError && <div className="global-error" role="alert"><span>{projectError}</span><button onClick={() => setProjectError('')}>關閉</button></div>}
      <div className="workspace-grid" id="workspace">
        <aside className="left-rail" aria-label="工作區導覽">
          {project && <div className="rail-section project-cover-section"><button className="cover-link" onClick={() => setCoverOpen(true)}>
            <span className="cover-thumb" aria-hidden="true"><i /><i /><i /></span>
            <span><strong><TruncateText text={project.titlePage?.title || project.title} className="cover-title" /></strong><small><TruncateText text={project.titlePage?.author ? `編劇 ${project.titlePage.author}` : '封面：劇名、作者、版本'} className="cover-meta" /></small></span>
          </button></div>}
          {workspaceView === 'script' && <div className="rail-section outline-section">
            <div className="section-heading"><span>幕與場景</span>
              <span className="section-tools">
                {project && <button className={`small-add${searchOpen || search ? ' pressed' : ''}`} aria-label="搜尋場景" title="搜尋場景" onClick={() => { const next = !searchOpen; setSearchOpen(next); if (next) setTimeout(() => searchInputRef.current?.focus(), 0); else setSearch(''); }}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" /><path d="m12.5 12.5 4 4" /></svg></button>}
                {!hasActs && <span className="section-count">{sceneBlocks.length} 場</span>}
              </span>
            </div>
            {project && (searchOpen || search) && <label className="rail-search"><input ref={searchInputRef} aria-label="搜尋場景" placeholder="搜尋場景…" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearch(''); setSearchOpen(false); } }} /></label>}
            
            {!project ? <p className="quiet-line">開啟或建立劇本後，場景會列在這裡。</p> : !sceneBlocks.length && !hasActs ? <p className="quiet-line">尚無場景。</p> : <div className="outline-tree">
              {outline.map((act) => {
                const query = search.trim().toLocaleLowerCase();
                const scenes = query ? act.scenes.filter(({ block }) => block.text.toLocaleLowerCase().includes(query)) : act.scenes;
                const collapsed = !query && act.id && collapsedActs.includes(act.id);
                const holdsCurrent = act.scenes.some(({ block }) => block.id === currentSceneId);
                return <section key={act.id || 'prelude'} className={`act-group${collapsed ? ' collapsed' : ''}`}>
                  {hasActs && <div className={`act-row${holdsCurrent ? ' current' : ''}`}>
                    {act.id ? <button className="act-toggle" aria-label={collapsed ? `展開${act.title}` : `收合${act.title}`} aria-expanded={!collapsed} onClick={() => toggleAct(act.id)}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 3 3 3-3 3" /></svg></button> : <span className="act-toggle" />}
                    <button className="act-title" onClick={() => act.id ? jumpToBlock(act.id) : act.scenes[0] && jumpToBlock(act.scenes[0].block.id)}><TruncateText text={act.title} className="act-title-text" /></button>
                    {(() => { const target = project?.kind ? EPISODE_TARGET[project.kind] : undefined; const eighths = act.scenes.reduce((sum, { block }) => sum + (sceneEighths[block.id] ?? 0), 0); const minutes = eighths / 8; const over = !!target && !!act.id && minutes > target[1]; return <span className={`act-count${over ? ' over' : ''}`} title={target && act.id ? `目標每集 ${target[0]}–${target[1]} 分鐘` : undefined}>{act.scenes.length} 場{target && act.id && eighths > 0 ? ` · 約 ${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} 分` : ''}</span>; })()}
                  </div>}
                  {!collapsed && <ol className="scene-list">{scenes.map(({ block, number }) => <li key={block.id}><button className={`scene-link ${currentSceneId === block.id ? 'current' : ''}`} aria-current={currentSceneId === block.id ? 'location' : undefined} onClick={() => jumpToBlock(block.id)}><span className="scene-number">{number}</span><TruncateText text={block.text || '未命名場景'} className="scene-title" /></button></li>)}</ol>}
                </section>;
              })}
              {search.trim() && !visibleScenes.length && <p className="quiet-line">沒有符合的場景</p>}
            </div>}
          </div>}
          {workspaceView === 'map' && project && <div className="rail-section outline-section workspace-rail-section">
            <div className="section-heading"><span>{MAP_TABS.find((tab) => tab.id === mapTab)?.label}</span></div>
            {mapTab === 'relations' && <nav className="rail-nav-list" aria-label="人物列表">{relationRailPeople.map((person) => <button key={person.name} className={focusedRelationCharacter === person.name ? 'active' : ''} onClick={() => setFocusedRelationCharacter(person.name)}><span className="gp-avatar" style={avatarStyle(person.name, project?.bible?.[person.name])}>{Array.from(person.name)[0]}</span><TruncateText text={person.name} /><small>{person.lines} 句</small></button>)}</nav>}
            {mapTab === 'mindmap' && project.mindmap && <nav className="rail-nav-list" aria-label="心智圖分支">{project.mindmap.children.map((branch) => <button key={branch.id} className={focusedMindmapBranch === branch.id ? 'active' : ''} onClick={() => setFocusedMindmapBranch(branch.id)}><span className="rail-dot" /><TruncateText text={branch.text || '未命名分支'} /><small>{branch.children.length}</small></button>)}</nav>}
            {mapTab === 'timeline' && <nav className="rail-nav-list" aria-label="時間線事件">{storyAnalysis?.scenes.map((scene) => <button key={scene.id} className={focusedTimelineScene === scene.id ? 'active' : ''} onClick={() => setFocusedTimelineScene(scene.id)}><span className="scene-number">{scene.index + 1}</span><TruncateText text={scene.title} /></button>)}</nav>}
          </div>}
          {workspaceView === 'story' && project && <div className="rail-section outline-section workspace-rail-section">
            <div className="section-heading"><span>{STORY_TABS.find((tab) => tab.id === storyWorkspaceTab)?.label}</span></div>
            {storyWorkspaceTab === 'people' && <nav className="rail-nav-list" aria-label="人物設定清單">
              {bibleRailNames.map((name) => <button key={name} className={bibleCharacterFocus === name ? 'active' : ''} onClick={() => setBibleCharacterFocus(name)}><span className="gp-avatar" style={avatarStyle(name, project.bible?.[name])}>{Array.from(name)[0]}</span><TruncateText text={name} /></button>)}
              {(project.characterDrafts ?? []).map((draft) => {
                const focusKey = characterDraftFocusKey(draft.id);
                const name = draft.fields.name?.trim() ?? '';
                return <button key={focusKey} className={`character-draft-link${bibleCharacterFocus === focusKey ? ' active' : ''}`} aria-label={name || '（未命名角色）'} onClick={() => setBibleCharacterFocus(focusKey)}>
                  <span className="gp-avatar" style={avatarStyle(name)}>{Array.from(name.normalize('NFKC'))[0] ?? '＋'}</span>
                  <TruncateText text={name || '（未命名角色）'} />
                  {!name && <small className="character-draft-warning" aria-label="尚未輸入名稱" title="尚未輸入名稱">!</small>}
                </button>;
              })}
            </nav>}
            {storyWorkspaceTab === 'records' && <nav className="rail-nav-list story-record-rail" aria-label="伏筆與設定清單">{[
              ...project.claims.map((item) => ({ kind: 'claim' as const, id: item.id, text: item.text || '未命名伏筆與設定' })),
              ...project.threads.map((item) => ({ kind: 'thread' as const, id: item.id, text: item.title || '未命名伏筆與設定' })),
            ].map((item) => <button key={`${item.kind}:${item.id}`} className={focusedStoryRecord?.id === item.id ? 'active' : ''} onClick={() => setFocusedStoryRecord({ kind: item.kind, id: item.id })}><TruncateText text={item.text} /></button>)}</nav>}
            {storyWorkspaceTab === 'references' && <div className="reference-rail-host"><div id="reference-library-rail" className="reference-library-rail" /></div>}
            {storyWorkspaceTab === 'knowledge' && <nav className="rail-nav-list" aria-label="知情表資訊">{(project.facts ?? []).map((fact, index) => <button key={fact.id} className={focusedKnowledgeFact === fact.id ? 'active' : ''} onClick={() => setFocusedKnowledgeFact(fact.id)}><span className="rail-dot" /><TruncateText text={fact.text || `未命名資訊 ${index + 1}`} /></button>)}</nav>}
            {storyWorkspaceTab === 'cards' && <nav className="rail-nav-list" aria-label="分場大綱分幕">{outline.map((act) => <button key={act.id || 'prelude'} className={focusedCardAct === act.id ? 'active' : ''} onClick={() => setFocusedCardAct(act.id)}><span className="rail-dot" /><TruncateText text={act.title} /><small>{act.scenes.length} 場</small></button>)}</nav>}
          </div>}
        </aside>

        <main className="manuscript-pane" aria-label={workspaceView === 'script' ? '劇本編輯區' : workspaceView === 'index' ? '文件索引' : workspaceView === 'map' ? '圖譜工作區' : '故事工作區'}>
          {workspaceView === 'index' ? <section className="index-view"><Analyzer key={project?.id ?? 'none'} projectId={project?.id ?? ''} pendingImportFile={pendingAnalyzerFile} onImportHandled={() => setPendingAnalyzerFile(null)} onSaveNote={saveReferenceNote} /></section>
            : workspaceView === 'map' ? <section className="tool-workspace map-view">
              <div className="map-tabs" role="tablist" aria-label="圖譜類型" data-seg>{MAP_TABS.map((tab) => <button key={tab.id} role="tab" aria-selected={mapTab === tab.id} className={mapTab === tab.id ? 'active' : ''} onClick={() => setMapTab(tab.id)}>{tab.label}</button>)}</div>
              {!project ? <div className="graph-empty"><h2>先開啟一份劇本</h2><p>圖譜會從劇本內容自動產生。</p></div>
                : mapTab === 'relations' ? <RelationGraph project={project} onAddRelation={addRelation} onRemoveRelation={removeRelation} onJumpToScene={jumpToBlock} focusCharacter={focusedRelationCharacter} onFocusCharacter={(name) => setFocusedRelationCharacter(name ?? '')} />
                  : mapTab === 'timeline' ? <StoryTimeline project={project} onMeta={updateSceneMeta} onReorder={reorderStory} onDeleteScene={deleteScene} onOpen={jumpToBlock} focusedSceneId={focusedTimelineScene} onSelectScene={setFocusedTimelineScene} />
                    : <MindMap project={mindmapProject ?? project} onChange={changeMindmap} focusBranch={focusedMindmapBranch} onOpenScene={jumpToBlock} onLeave={() => setFocusedMindmapBranch('')} />}
            </section>
            : workspaceView === 'story' ? <section className="tool-workspace story-view">
              <div className="map-tabs story-workspace-tabs" role="tablist" aria-label="故事類型" data-seg>{STORY_TABS.map((tab) => <button key={tab.id} role="tab" aria-selected={storyWorkspaceTab === tab.id} className={storyWorkspaceTab === tab.id ? 'active' : ''} onClick={() => setStoryWorkspaceTab(tab.id)}>{tab.label}</button>)}</div>
              {!project ? <div className="graph-empty"><h2>先開啟一份劇本</h2><p>故事大綱、設定與分場資料會保存在目前劇本中。</p></div>
            : storyWorkspaceTab === 'outline' ? <StoryOutline project={project} onChange={(storyOutline) => mutateProject((current) => ({ ...current, storyOutline }))} />
            : storyWorkspaceTab === 'people' ? <SeriesBible project={project} sceneEighths={sceneEighths} onProfile={updateProfile} onAddDraft={addCharacterProfileDraft} onDraftChange={(change) => mutateProject(change)} onCommitDraft={commitCharacterProfileDraft} onDeleteProfile={deleteCharacterProfile} onMeta={updateSceneMeta} onOpen={jumpToBlock} onExport={() => void exportBible()} onRename={renameCharacter} activeTab="people" focusCharacter={bibleCharacterFocus} onFocusCharacter={setBibleCharacterFocus} onAliases={updateAliases} onDismissIdentity={dismissIdentity} onMergeIdentity={mergeIdentity} />
                : storyWorkspaceTab === 'records' ? <UnifiedStoryRecords project={project} focusRecordId={focusedStoryRecord?.id} onChange={(change) => mutateProject(change)} onOpen={jumpToBlock} />

                : storyWorkspaceTab === 'knowledge' ? <KnowledgeMatrix project={project} onChange={(change) => mutateProject((current) => ({ ...current, ...change }))} focusFactId={focusedKnowledgeFact} onFocusFact={setFocusedKnowledgeFact} />
                : storyWorkspaceTab === 'references' ? <section className="index-view"><Analyzer key={project?.id ?? 'none'} projectId={project?.id ?? ''} railMode pendingImportFile={pendingAnalyzerFile} onImportHandled={() => setPendingAnalyzerFile(null)} onSaveNote={saveReferenceNote} /></section>
                : <SceneBoard project={project} sceneEighths={sceneEighths} onMove={moveScene} onMeta={updateSceneMeta} onDeleteScene={deleteScene} onRenameAct={renameActTitle} onOpen={jumpToBlock} focusActId={focusedCardAct} />}
            </section>
            : null}
          <section className="script-workspace" hidden={workspaceView !== 'script'}>
            {loadingProject && <div className="workspace-empty"><span className="empty-kicker">SCENEFORGE</span><h1>正在開啟劇本</h1><p>正在載入本機文件…</p></div>}
            {!loadingProject && !project && <div className="workspace-empty welcome">
              <img className="welcome-logo" src={logoUrl} alt="" aria-hidden="true" draggable={false} />
              <h1>{recentFiles.length || projects.length ? '歡迎回來' : '每個故事，都值得一張好紙'}</h1>
              <p>專為中文編劇打造：輸入法不誤觸、格式自動成形，任何檔案丟進來都能變成劇本。</p>
              <div className="welcome-cards">
                <button onClick={() => void startFresh()}><span className="wc-icon">＋</span><strong>開新檔案</strong><small>設定劇名與格式</small></button>
                <button onClick={() => void openDocument()}><span className="wc-icon">▤</span><strong>開啟舊檔</strong><small>.sfe 劇本</small></button>
                <button onClick={() => unifiedFileInputRef.current?.click()}><span className="wc-icon">↥</span><strong>匯入其他檔案</strong><small>Word、PDF、FDX、TXT</small></button>
              </div>
              {(desktop ? recentFiles.length > 0 : projects.length > 0) && <section className="recent-list" aria-label="最近開啟">
                <h2>最近開啟</h2>
                <ul>{desktop
                  ? recentFiles.slice(0, 8).map((entry) => <li key={entry.path ?? entry.projectId}>
                    <button type="button" className="recent-open" onClick={() => void openRecent(entry)} title={entry.path}><span className="project-list-glyph" aria-hidden="true">{Array.from(entry.name.trim())[0] || 'S'}</span><span><strong>{entry.name}</strong><small>{entry.path ?? '尚未存檔'}</small></span><time>{new Date(entry.openedAt).toLocaleDateString('zh-TW')}</time></button>
                    <button type="button" className="recent-trash icon-button" aria-label={`將「${entry.name}」移至垃圾桶`} title="移至垃圾桶" onClick={() => void moveProjectToTrash(entry.projectId)}>×</button>
                  </li>)
                  : projects.slice(0, 8).map((item) => <li key={item.id}>
                    <button type="button" className="recent-open" onClick={() => void loadProject(item.id)}><span className="project-list-glyph" aria-hidden="true">{Array.from(item.title.trim())[0] || 'S'}</span><span><strong>{item.title}</strong><small>本機自動備份</small></span><time>{new Date(item.updatedAt).toLocaleDateString('zh-TW')}</time></button>
                    <button type="button" className="recent-trash icon-button" aria-label={`將「${item.title}」移至垃圾桶`} title="移至垃圾桶" onClick={() => void moveProjectToTrash(item.id)}>×</button>
                  </li>)}
                </ul>
              </section>}
            </div>}
            {project && project.titlePage?.print !== false && <section className="print-cover" aria-hidden="true">
              <div className="pc-main"><h1>{project.titlePage?.title || project.title}</h1>{project.titlePage?.subtitle && <p className="pc-sub">{project.titlePage.subtitle}</p>}{project.titlePage?.author && <p className="pc-by">編劇<br /><strong>{project.titlePage.author}</strong></p>}{project.titlePage?.basedOn && <p className="pc-based">{project.titlePage.basedOn}</p>}</div>
              <div className="pc-foot"><span>{project.titlePage?.contact}</span><span>{[project.titlePage?.draft, project.titlePage?.date].filter(Boolean).join('　')}</span></div>
            </section>}
            {project && findOpen && <div className="find-bar" role="search" aria-label="尋找與取代">
              <input ref={findInputRef} value={findQuery} placeholder="尋找" aria-label="尋找" onChange={(event) => { setFindQuery(event.target.value); setFindIndex(0); }}
                onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); stepFind(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') setFindOpen(false); }} />
              <span className="find-count">{findQuery ? (findMatches.length ? `${Math.min(findIndex + 1, findMatches.length)} / ${findMatches.length}` : '沒有結果') : ''}</span>
              <button className="icon-button" aria-label="上一個" disabled={!findMatches.length} onClick={() => stepFind(-1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 12 4-4 4 4" /></svg></button>
              <button className="icon-button" aria-label="下一個" disabled={!findMatches.length} onClick={() => stepFind(1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg></button>
              <span className="find-sep" />
              <input value={replaceText} placeholder="取代為" aria-label="取代為" onChange={(event) => setReplaceText(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); replaceCurrent(); } if (event.key === 'Escape') setFindOpen(false); }} />
              <button className="toolbar-button" disabled={!findMatches.length} onClick={replaceCurrent}>取代</button>
              <button className="toolbar-button" disabled={!findMatches.length} onClick={replaceAll}>全部取代</button>
              <button className="icon-button" aria-label="關閉尋找" onClick={() => setFindOpen(false)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
            </div>}
            {project && <div className="editor-scroll" key={project.id}>
              <div className="script-page" aria-label="劇本稿紙">
                {activeBlock && tagTop !== null && <div className="element-tag-wrap floating" style={{ top: `calc(${tagTop}px + (1em * var(--script-line-height, 1.5) - 24px) / 2)` }} onMouseDown={(event) => event.preventDefault()}>
                  <button key={typeFlash.id === activeBlock.id ? typeFlash.n : 0} type="button" className={`element-tag${typeFlash.id === activeBlock.id && typeFlash.n ? ' flash' : ''}`} aria-haspopup="menu" aria-expanded={elementMenuOpen} title="段落類型" onClick={() => setElementMenuOpen((open) => !open)}>{BLOCK_LABELS[activeBlock.type]}<Chevron /></button>
                  {elementMenuOpen && <div className="element-menu" role="menu" aria-label="變更段落類型">
                    {BLOCK_ORDER.map((type) => <button key={type} type="button" role="menuitemradio" aria-checked={activeBlock.type === type} onClick={() => { setElementMenuOpen(false); setBlockType(activeBlock.id, type); }}>{BLOCK_LABELS[type]}</button>)}
                  </div>}
                </div>}
                {project.blocks.length === 0 ? <p className="script-empty-copy">此稿目前沒有段落。從上方「編輯」選單新增段落。</p> : <div className="block-list">
                  {project.blocks.map((block, index) => {
                    if (block.type === 'act' && !(project.settings?.showActHeadings ?? project.kind !== 'film')) return null;
                    const isActive = activeEditorId === block.id;
                    const commentOpen = commentFor === block.id;
                    return <ScriptBlock key={block.id}
                      block={block}
                      index={index}
                      handlers={scriptBlockHandlers}
                      sceneStyle={sceneStyle}
                      emptyHints={EMPTY_HINTS}
                      locked={locked}
                      isActive={isActive}
                      caretAtEnd={isActive ? caretAtEnd : false}
                      suggestionDismissed={isActive ? dismissedSceneSuggestion === block.id : false}
                      suggestionIndex={isActive ? sceneSuggestionIndex[block.id] ?? 0 : 0}
                      sceneLocations={isActive ? sceneLocations : NO_LOCATIONS}
                      isContinuationCue={block.type === 'character' && !!block.text.trim() && project.settings?.autoContinuation !== false && continuationCueIds.has(block.id)}
                      pageStart={showPageBreaks ? pageStartMap.get(block.id) : undefined}
                      comments={commentsByBlock.get(block.id) ?? NO_COMMENTS}
                      setupCount={storyMarkerCounts.get(block.id)?.setup ?? 0}
                      payoffCount={storyMarkerCounts.get(block.id)?.payoff ?? 0}
                      revised={revisedSet.has(block.id)}
                      commentOpen={commentOpen}
                      commentDraft={commentOpen ? commentDraft : ''}
                      findRects={findHighlight?.blockId === block.id ? findHighlight.rects : null}
                      bible={project.bible} />;
                  })}
                </div>}
              </div>
            </div>}

          </section>
        </main>


      </div>
      <footer className="statusbar">
        <span className="status-left" />
        {project && <span className="status-metrics">{exportBusy && <span className="status-busy">{exportBusy}</span>}{stats && <><span title="依目前紙張、字型與行距實際排版">{stats.pages} 頁</span><span title="以標準劇本每頁 55 行、一頁約一分鐘估算">約 {stats.minutes} 分鐘</span></>}<span>{sceneBlocks.length} 場</span><span title="不含空白與標點">{(stats?.characters ?? wordCount).toLocaleString('zh-TW')} 字</span></span>}
        <span className="status-mode">
          {revisionBase && <span className="status-revision" title={`修訂基準：${new Date(revisionBase.createdAt).toLocaleString('zh-TW')}`}>修訂 {revisedIds.length} 段</span>}
          {project && <span className="goal">
            <button className="goal-button" onClick={() => setGoalOpen((open) => !open)} title="今日寫作目標">
              <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" className="goal-track" /><circle cx="10" cy="10" r="7" className="goal-fill" style={{ strokeDashoffset: 44 - 44 * Math.min(1, todayWritten / Math.max(1, goal)) }} /></svg>
              今日 {todayWritten.toLocaleString('zh-TW')} / {goal.toLocaleString('zh-TW')} 字
            </button>
            {goalOpen && <div className="goal-pop"><strong>今日寫作目標</strong><div>{[300, 500, 1000, 2000, 3000].map((value) => <button key={value} className={goal === value ? 'active' : ''} onClick={() => { changeGoal(value); setGoalOpen(false); }}>{value.toLocaleString('zh-TW')}</button>)}</div><p>{todayWritten >= goal ? '今天的目標已達成。' : `還差 ${(goal - todayWritten).toLocaleString('zh-TW')} 字。`}</p></div>}
          </span>}
          <span className="status-format">{formatSettings.paper === 'a4' ? 'A4' : 'US Letter'} · {formatSettings.fontPt} pt</span>
          <span className="zoom-status-control">
            <button type="button" className="zoom-control-step" aria-label="縮小顯示比例" title="縮小（Ctrl+-）" disabled={!desktop || zoomPercent <= 50} onClick={() => stepDisplayZoom(-1)}>−</button>
            <button type="button" className="zoom-control-current" aria-label={`選擇顯示比例，目前 ${zoomPercent}%`} title={desktop ? '選擇顯示比例' : '示範版請使用瀏覽器快捷鍵'} aria-haspopup="dialog" aria-expanded={zoomPopoverOpen} onClick={() => { setMenuOpen(null); setSubmenu(null); setCustomZoomValue(String(zoomPercent)); setCustomZoomError(''); setZoomPopoverOpen((open) => !open); }}>{zoomPercent}%</button>
            <button type="button" className="zoom-control-step" aria-label="放大顯示比例" title="放大（Ctrl+=）" disabled={!desktop || zoomPercent >= 200} onClick={() => stepDisplayZoom(1)}>＋</button>
            {zoomPopoverOpen && <div className="zoom-popover" role="dialog" aria-label="顯示比例">
              <div className="zoom-presets" role="radiogroup" aria-label="顯示比例預設" data-seg-ignore>
                {ZOOM_PERCENTAGES.map((percent) => <button key={percent} type="button" role="radio" aria-checked={zoomPercent === percent} disabled={!desktop} onClick={() => { setCustomZoomError(''); setZoomPopoverOpen(false); applyDisplayZoom(percent / 100); }}>{percent}%</button>)}
              </div>
              <form className="zoom-custom-form" noValidate onSubmit={(event) => { event.preventDefault(); applyCustomDisplayZoom(); }}>
                <label htmlFor="zoom-custom-value">自訂比例 <small>50–200%，每次 5%</small></label>
                <div className="zoom-custom-row"><input id="zoom-custom-value" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={3} value={customZoomValue} aria-invalid={!!customZoomError} disabled={!desktop} onChange={(event) => { setCustomZoomValue(event.target.value.replace(/[^0-9]/g, '')); setCustomZoomError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyCustomDisplayZoom(); } }} /><span>%</span><button type="submit" className="button-primary button-small" disabled={!desktop}>套用</button></div>
                {customZoomError && <p className="zoom-custom-error" role="alert">{customZoomError}</p>}
                {!desktop && <p className="zoom-custom-help">示範版請使用瀏覽器原生顯示比例快捷鍵。</p>}
              </form>
            </div>}
          </span>
        </span>
      </footer>
      {paragraphMenu && createPortal(<div ref={paragraphMenuRef} className="script-context-menu" role="menu" aria-label="段落動作" style={{ left: paragraphMenu.x, top: paragraphMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
        {(() => {
          const inScene = !!sceneHeadingId(project?.blocks ?? [], paragraphMenu.blockId);
          const records = [
            ...(project?.claims ?? []).map((claim) => ({ id: claim.id, title: claim.text || '未命名項目', kind: 'claim' as const })),
            ...(project?.threads ?? []).map((thread) => ({ id: thread.id, title: thread.title || '未命名項目', kind: 'thread' as const })),
          ];
          const go = (patch: Partial<NonNullable<typeof paragraphMenu>>) => setParagraphMenu((menu) => menu && ({ ...menu, ...patch }));
          const back = (mode: 'root' | 'pick') => <button className="context-back" onClick={() => go({ mode })}>← 返回</button>;
          if (paragraphMenu.mode === 'root') return <>
            {paragraphMenu.hasSelection && <><div className="context-caption" title={paragraphMenu.selectedText}>已選取：「{Array.from(paragraphMenu.selectedText).slice(0, 36).join('')}{Array.from(paragraphMenu.selectedText).length > 36 ? '…' : ''}」</div><hr className="context-separator" /> </>}
            <button role="menuitem" disabled={!inScene} title={!inScene ? '請在場景內使用' : undefined} onClick={() => go({ mode: 'pick' })}><span>伏筆與設定</span><span className="context-more" aria-hidden="true">›</span></button>
          </>;
          if (paragraphMenu.mode === 'pick') return <>
            {back('root')}
            <div className="context-heading">伏筆與設定</div>
            <button role="menuitem" className="context-new" onClick={() => go({ mode: 'new', kind: 'thread', draft: paragraphMenu.selectedText || paragraphMenu.draft })}>＋ 新增一筆…</button>
            {!!records.length && <><hr className="context-separator" /><div className="context-subheading">加入既有紀錄</div></>}
            {!!records.length && <div className="context-record-list">{records.map((record) => <button key={record.id} role="menuitem" className="context-record" title={record.title} onClick={() => record.kind === 'claim' ? linkParagraphClaim(record.id) : go({ mode: 'role', recordId: record.id })}><span className="context-record-title">{shortLabel(record.title)}</span><em className={`context-kind ${record.kind}`}>{record.kind === 'claim' ? '設定' : '伏筆'}</em></button>)}</div>}
          </>;
          if (paragraphMenu.mode === 'role') {
            const record = records.find((item) => item.id === paragraphMenu.recordId);
            return <>
              {back('pick')}
              <div className="context-heading" title={record?.title}>「{shortLabel(record?.title ?? '')}」這一場是…</div>
              <button role="menuitem" onClick={() => record && linkParagraphThread(record.id, 'setup')}>鋪陳</button>
              <button role="menuitem" onClick={() => record && linkParagraphThread(record.id, 'payoff')}>回收</button>
            </>;
          }
          return <>
            {back('pick')}
            <div className="context-heading">新增伏筆與設定</div>
            <div className="context-kind-switch" role="radiogroup" aria-label="類型" data-seg>
              {(['thread', 'claim'] as const).map((kind) => <button key={kind} type="button" role="radio" aria-checked={(paragraphMenu.kind ?? 'thread') === kind} className={(paragraphMenu.kind ?? 'thread') === kind ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => go({ kind })}>{kind === 'thread' ? '伏筆' : '設定'}</button>)}
            </div>
            <p className="context-hint">{(paragraphMenu.kind ?? 'thread') === 'thread' ? '之後會回收的細節；這一場記為鋪陳' : '需要前後一致的事實；這一場記為出處'}</p>
            <div className="context-create"><input aria-label="伏筆與設定名稱" autoFocus value={paragraphMenu.draft} onChange={(event) => go({ draft: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && paragraphMenu.draft.trim()) createParagraphRecord(); }} /><button className="button-primary button-small" disabled={!paragraphMenu.draft.trim() || !inScene} onClick={createParagraphRecord}>新增</button></div>
          </>;
        })()}
      </div>, document.body)}
      {helpOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false); }}>
        <section className="app-dialog keyboard-dialog" role="dialog" aria-modal="true" aria-labelledby="keyboard-help-title">
          <header><div><p className="eyebrow">輸入與導覽</p><h2 id="keyboard-help-title">鍵盤快捷鍵</h2></div><button className="dialog-close" aria-label="關閉快捷鍵說明" onClick={() => setHelpOpen(false)}>×</button></header>
          <p className="dialog-copy">在稿紙輸入區使用段落切換鍵。桌面版使用 Ctrl+1–9（Mac：⌘1–9）；示範版亦支援 Alt+1–9，避免瀏覽器攔截 Ctrl+數字。</p>
          <div className="shortcut-list">{BLOCK_ORDER.map((type) => <div key={type}><span>{BLOCK_LABELS[type]}</span>{TYPE_SHORTCUTS[type] !== undefined ? <kbd>{typeShortcut(TYPE_SHORTCUTS[type]!)}</kbd> : <span className="shortcut-unavailable">—</span>}</div>)}</div>
          <div className="shortcut-notes"><p><kbd>Enter</kbd> 場景→動作；角色→對白；括號→對白；對白→動作。</p><p><kbd>Shift+Enter</kbd> 段內換行。場景標題 <kbd>Tab</kbd> 逐欄接受場景類型、記憶地點和 DAY／NIGHT；方向鍵切換候選，Esc 關閉建議。</p><p><kbd>{searchShortcut}</kbd> 搜尋場景。組字期間（含 keyCode 229）所有結構快捷鍵停用。</p></div>
        </section>
      </div>}
      {importPreview && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !importBusy) setImportPreview(null); }}>
        <section className="app-dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-preview-title">
          <header><div><p className="eyebrow">不覆寫原稿</p><h2 id="import-preview-title">匯入預覽</h2></div><button className="dialog-close" aria-label="關閉匯入預覽" disabled={importBusy} onClick={() => setImportPreview(null)}>×</button></header>
          <p className="dialog-copy">{importPreview.fileName} · {importPreview.project ? 'SceneForge 專案 JSON' : '劇本文字'} · {importPreview.blocks.length} 段。原始檔案不會修改；確認後會建立獨立新專案，既有專案保持不變。</p>
          <label className="dialog-field">新專案名稱<input value={importPreview.title} onChange={(event) => setImportPreview((current) => current ? { ...current, title: event.target.value } : current)} maxLength={100} /></label>
          {Object.keys(importPreview.metadata ?? {}).length > 0 && <section className="import-metadata" aria-label="Markdown 匯入中繼資料"><strong>匯入中繼資料（不列入劇本）</strong><dl>{Object.entries(importPreview.metadata ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></section>}
          {importPreview.warnings.length > 0 && <section className="import-warnings" aria-label="低信心匯入提醒"><strong>需人工核對的來源行</strong><ul>{importPreview.warnings.map((warning, index) => <li key={`${warning.line}-${index}`}><b>第 {warning.line} 行</b> · {warning.reason}<pre>{warning.content}</pre></li>)}</ul></section>}
          {importPreview.originalSource !== undefined && <details className="import-original-source"><summary>查看完整原始 Markdown（匯入前可下載）</summary><button className="text-button" type="button" onClick={() => downloadText(importPreview.fileName, importPreview.originalSource ?? '', 'text/markdown;charset=utf-8')}>下載原始 Markdown</button><pre>{importPreview.originalSource}</pre></details>}
          <div className="preview-block-list" aria-label="劇本分類預覽">{importPreview.blocks.slice(0, 14).map((block, index) => <p key={block.id}><span>{BLOCK_LABELS[block.type]}</span>{block.text || '（空白）'}</p>)}{importPreview.blocks.length > 14 && <p className="preview-more">另有 {importPreview.blocks.length - 14} 段</p>}</div>
          <footer><button className="text-button" disabled={importBusy} onClick={() => setImportPreview(null)}>取消</button><button className="button-primary" disabled={importBusy} onClick={() => void confirmImport()}>{importBusy ? '正在建立…' : '建立為新劇本'}</button></footer>
        </section>
      </div>}
      {coverOpen && project && <CoverDialog project={project} onChange={updateTitlePage} onClose={() => setCoverOpen(false)} />}
      {exportDialog && project && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExportDialog(null); }}>
        <section className="app-dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
          <header><div><p className="eyebrow">匯出</p><h2 id="export-title">{exportDialog === 'pdf' ? 'PDF' : 'Word（.docx）'}</h2></div><button className="dialog-close" aria-label="關閉" onClick={() => setExportDialog(null)}>×</button></header>
          <p className="dialog-copy">版面依劇本格式：{formatSettings.preset === 'taiwan-work' ? '台式劇本' : '美式劇本'}（{formatSettings.paper === 'a4' ? 'A4' : 'US Letter'}）。</p>
          <div className="export-options">
            <Switch className="studio-switch" checked={exportOptions.sceneNumbers} onChange={(next) => setExportOptions((current) => ({ ...current, sceneNumbers: next }))} label="場次編號" />
            <Switch className="studio-switch" checked={exportOptions.includeCover} onChange={(next) => setExportOptions((current) => ({ ...current, includeCover: next }))} label="包含封面" />
            <Switch className="studio-switch" checked={exportOptions.anonymous} onChange={(next) => setExportOptions((current) => ({ ...current, anonymous: next }))} label="匿名投稿（移除作者、聯絡方式與檔案資訊）" />
            {exportDialog === 'pdf' && <Switch className="studio-switch" disabled={!revisionBase} checked={exportOptions.revisions && !!revisionBase} onChange={(next) => setExportOptions((current) => ({ ...current, revisions: next }))} label={<>修訂標記 *{revisionBase ? `（${revisedIds.length} 段）` : '（先在「版本比對與修訂」選擇基準版本）'}</>} />}
          </div>
          <footer><button className="text-button" onClick={() => setExportDialog(null)}>取消</button><button className="button-primary" onClick={() => void (exportDialog === 'pdf' ? runExportPdf() : runExportDocx())}>匯出 {exportDialog === 'pdf' ? 'PDF' : 'Word'}</button></footer>
        </section>
      </div>}
      {compareOpen && project && <CompareDialog project={project} demo={IS_DEMO} revisionBase={revisionBase} revisedCount={revisedIds.length} snapshotKeep={snapshotKeep} onSnapshotKeepChange={setSnapshotKeep} onRevisionBase={useAsRevisionBase} onRevisionBaseRemoved={clearRevisionBase} notify={notify} onError={setProjectError} onClose={() => setCompareOpen(false)} />}
      {reportsOpen && project && <ReportsDialog project={project} sceneEighths={sceneEighths} demo={IS_DEMO} tab={reportTab} onTabChange={setReportTab} notify={notify} onError={setProjectError} onClose={() => setReportsOpen(false)} />}
      {namesOpen && <NamesDialog options={nameOptions} onOptionsChange={setNameOptions} exclude={castNames} onPick={(name) => void applyName(name)} fillsCue={activeBlock?.type === 'character'} onClose={() => setNamesOpen(false)} />}
      {convertOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConvertOpen(false); }}>
        <section className="app-dialog convert-dialog" role="dialog" aria-modal="true" aria-labelledby="convert-title">
          <header><div><p className="eyebrow">整份劇本</p><h2 id="convert-title">繁簡轉換</h2></div><button className="dialog-close" aria-label="關閉" onClick={() => setConvertOpen(false)}>×</button></header>
          <div className="export-templates">
            <button role="radio" aria-checked={convertOptions.direction === 'to-simplified'} className={convertOptions.direction === 'to-simplified' ? 'active' : ''} onClick={() => setConvertOptions((current) => ({ ...current, direction: 'to-simplified' }))}><strong>繁 → 简</strong></button>
            <button role="radio" aria-checked={convertOptions.direction === 'to-traditional'} className={convertOptions.direction === 'to-traditional' ? 'active' : ''} onClick={() => setConvertOptions((current) => ({ ...current, direction: 'to-traditional' }))}><strong>简 → 繁</strong></button>
          </div>
          <Switch className="studio-switch" checked={convertOptions.phrases} onChange={(next) => setConvertOptions((current) => ({ ...current, phrases: next }))} label="同時轉換兩岸用語（如：軟體 ↔ 软件、滑鼠 ↔ 鼠标）" />
          <p className="dialog-copy">轉換整份劇本，包含角色名、封面、關係圖、設定集與註解。完成後可以按 Ctrl+Z 復原；建議先在「版本比對」建立快照。</p>
          <footer><button className="text-button" onClick={() => setConvertOpen(false)}>取消</button><button className="button-primary" onClick={() => void runConvert()}>開始轉換</button></footer>
        </section>
      </div>}
      <input ref={documentInputRef} className="visually-hidden" type="file" accept=".sfe,.sceneforge,.json" aria-label="開啟劇本檔" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void file.arrayBuffer().then((buffer) => openDocumentBytes(new Uint8Array(buffer), undefined, file.name)).catch((error: unknown) => setProjectError(error instanceof Error ? `無法開啟檔案：${error.message}` : '無法開啟檔案。')); }} />
      {newProjectOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewProjectOpen(false); }}>
        <form className="app-dialog new-doc-dialog" role="dialog" aria-modal="true" aria-labelledby="new-doc-title" onSubmit={(event) => void createProject(event)}>
          <header><div><p className="eyebrow">開新檔案</p><h2 id="new-doc-title">新劇本</h2></div><button type="button" className="dialog-close" aria-label="關閉" onClick={() => setNewProjectOpen(false)}>×</button></header>
          <label className="dialog-field">劇名<input id="new-project-title" value={newProjectTitle} onChange={(event) => setNewProjectTitle(event.target.value)} placeholder="未命名劇本" maxLength={100} /></label>
          <div className="dialog-field"><span>格式</span>
            <div className="choice-grid two">
              <button type="button" role="radio" aria-checked={newProjectPreset === 'taiwan-work'} className={newProjectPreset === 'taiwan-work' ? 'active' : ''} onClick={() => setNewProjectPreset('taiwan-work')}><span className="tpl-preview tpl-inline" aria-hidden="true"><i /><i /><i /><i /></span><strong>台式劇本</strong><small>A4・場次號在前・角色：對白</small></button>
              <button type="button" role="radio" aria-checked={newProjectPreset === 'us-screenplay'} className={newProjectPreset === 'us-screenplay' ? 'active' : ''} onClick={() => setNewProjectPreset('us-screenplay')}><span className="tpl-preview tpl-hollywood" aria-hidden="true"><i /><i /><i /><i /></span><strong>美式劇本</strong><small>US Letter・角色置中・對白縮排</small></button>
            </div>
            <small className="field-note">建立時先放入一個空白場景；格式之後可在「格式」選單切換。</small>
          </div>
          <footer><button type="button" className="text-button" onClick={() => setNewProjectOpen(false)}>取消</button><button className="button-primary" type="submit">建立</button></footer>
        </form>
      </div>}
      {saveAsRequest && <div className="dialog-backdrop" role="presentation">
        <form className="app-dialog save-as-dialog" role="dialog" aria-modal="true" aria-labelledby="save-as-title" onSubmit={(event) => {
          event.preventDefault();
          const name = saveAsForm.name.trim() || '未命名劇本';
          saveAsRequest.resolve({ name });
          setSaveAsRequest(null);
        }}>
          <header><div><p className="eyebrow">另存新檔</p><h2 id="save-as-title">儲存劇本</h2></div><button type="button" className="dialog-close" aria-label="取消" onClick={() => { saveAsRequest.resolve(null); setSaveAsRequest(null); }}>×</button></header>
          {!desktop && <label className="dialog-field">檔名<input autoFocus value={saveAsForm.name} onChange={(event) => setSaveAsForm((form) => ({ ...form, name: event.target.value }))} maxLength={100} /></label>}
          <footer><button type="button" className="text-button" onClick={() => { saveAsRequest.resolve(null); setSaveAsRequest(null); }}>取消</button><button className="button-primary" type="submit">下載檔案</button></footer>
        </form>
      </div>}
      {passwordRequest && <div className="dialog-backdrop" role="presentation">
        <form className="app-dialog password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-title" onSubmit={(event) => { event.preventDefault(); if (!passwordDraft) return; passwordRequest.resolve(passwordDraft); setPasswordRequest(null); }}>
          <header><div><p className="eyebrow">有密碼保護</p><h2 id="password-title">{passwordRequest.name}</h2></div><button type="button" className="dialog-close" aria-label="取消" onClick={() => { passwordRequest.resolve(null); setPasswordRequest(null); }}>×</button></header>
          <input className="password-input" type="password" autoFocus placeholder="輸入密碼" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} />
          {passwordRequest.wrong && <p className="dialog-error">密碼不正確，請再試一次。</p>}
          <footer><button type="button" className="text-button" onClick={() => { passwordRequest.resolve(null); setPasswordRequest(null); }}>取消</button><button className="button-primary" type="submit" disabled={!passwordDraft}>開啟</button></footer>
        </form>
      </div>}
      {locationsOpen && project && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setLocationsOpen(false); setLocationRename(null); } }}>
        <section className="app-dialog locations-dialog" role="dialog" aria-modal="true" aria-labelledby="locations-title">
          <header><div><p className="eyebrow">場景標題補全</p><h2 id="locations-title">管理場景地點</h2></div><button className="dialog-close" aria-label="關閉場景地點管理" onClick={() => { setLocationsOpen(false); setLocationRename(null); }}>×</button></header>
          <p className="dialog-copy">場景標題中的地點會自動列入，依使用次數排序。重新命名可選擇同步更改劇本標題。</p>
          {!sceneLocations.length ? <p className="dialog-empty">目前沒有場景地點。從場景標題擷取的地點會自動出現在這裡。</p> : <ul className="location-list" aria-label="場景地點清單">{sceneLocations.map((location) => <li key={location}>
            {locationRename === location ? <form className="location-rename" onSubmit={(event) => { event.preventDefault(); renameLocation(location); }}>
              <input autoFocus aria-label={`重新命名地點 ${location}`} value={locationDraft} onChange={(event) => setLocationDraft(event.target.value)} maxLength={100} />
              <Switch className="studio-switch" checked={locationRenameInScript} onChange={setLocationRenameInScript} label="同時更改劇本中的場景標題" />
              <button className="button-primary button-small" type="submit" disabled={!locationDraft.trim()}>儲存</button>
              <button className="text-button" type="button" onClick={() => { setLocationRename(null); setLocationDraft(''); }}>取消</button>
            </form> : <><span title={location}>{location}</span><div><small className="location-use-count">{sceneLocationCounts.get(location) ?? 0} 場</small><button className="button-ghost button-small" type="button" onClick={() => { setLocationRename(location); setLocationDraft(location); setLocationRenameInScript(false); }}>重新命名</button></div></>}
          </li>)}</ul>}
          <footer><button className="button-primary" onClick={() => { setLocationsOpen(false); setLocationRename(null); }}>完成</button></footer>
        </section>
      </div>}
      {aboutOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}>
        <section className="app-dialog about-dialog" role="dialog" aria-modal="true" aria-label="關於 SceneForge">
          <img className="brand-logo about-logo" src={logoUrl} alt="" aria-hidden="true" draggable={false} />
          <h2>SceneForge</h2>
          <p className="about-version">版本 {APP_CONFIG.version}</p>
          <p className="dialog-copy">為中文編劇而生的劇本寫作軟體。</p>
          <p className="dialog-copy">免費、開源（MIT License）。</p>
          <footer><button className="text-button" onClick={() => { setAboutOpen(false); void fetch('./THIRD_PARTY_LICENSES.txt').then((response) => response.ok ? response.text() : Promise.reject(new Error(String(response.status)))).then(setLicensesText, () => setLicensesText('無法載入第三方授權清單。')); }}>第三方授權</button><button className="button-primary" onClick={() => setAboutOpen(false)}>好</button></footer>
        </section>
      </div>}
      {licensesText !== null && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLicensesText(null); }}>
        <section className="app-dialog licenses-dialog" role="dialog" aria-modal="true" aria-labelledby="licenses-title">
          <header><div><p className="eyebrow">關於 SceneForge</p><h2 id="licenses-title">第三方授權</h2></div><button className="dialog-close" aria-label="關閉" onClick={() => setLicensesText(null)}>×</button></header>
          <p className="dialog-copy">SceneForge 使用了以下開放原始碼軟體與字型，感謝這些作者。</p>
          <pre className="demo-output">{licensesText}</pre>
        </section>
      </div>}
      {demoDownload && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDemoDownload(null); }}>
        <section className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="demo-dl-title">
          <header><div><p className="eyebrow">示範版</p><h2 id="demo-dl-title">{demoDownload.name}</h2></div><button className="dialog-close" aria-label="關閉" onClick={() => setDemoDownload(null)}>×</button></header>
          <p className="dialog-copy">這個示範頁在瀏覽器沙盒裡執行，無法下載檔案。電腦版會直接存成「{demoDownload.name}」。{demoDownload.text ? '以下是實際會輸出的內容：' : 'PDF 與 Word 請使用電腦版匯出。'}</p>
          {demoDownload.text && <pre className="demo-output">{demoDownload.text.slice(0, 20000)}</pre>}
        </section>
      </div>}
      <ConfirmHost />
      {toast && <div className="toast" key={toast.id} role="status"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3L15 6.5" /></svg>{toast.text}</div>}
      {studioSource && <ImportStudio source={studioSource} memory={importMemory} busy={importBusy} currentTitle={project ? documentTitle : undefined} onMemoryChange={updateImportMemory} onConfirm={(value) => void confirmStudio(value)} onClose={() => setStudioSource(null)} />}
      {dragFeedback && <div className={dragFeedback.kind === 'reject' ? "drop-overlay drop-reject" : "drop-overlay drop-accept"} role="status" aria-live="polite"><div><span className="drop-seal">{dragFeedback.kind === 'reject' ? "×" : "↥"}</span><strong>{dragFeedback.kind === 'reject' ? "不接受此項目" : dragFeedback.kind === 'accept' ? "可放開" : "檢查拖入項目"}</strong><p>{dragFeedback.message}</p></div></div>}
      {backupsOpen && <BackupsDialog demo={IS_DEMO} onClose={() => setBackupsOpen(false)} notify={notify} onError={setProjectError} beforeRestore={flushPendingSave} onRestored={reloadAfterBackupRestore} />}
      {trashOpen && <TrashDialog onClose={() => setTrashOpen(false)} notify={notify} onRestored={afterTrashRestore} />}
    </div>
  );
}

export default App;
