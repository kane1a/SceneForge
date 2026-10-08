export const BLOCK_TYPES = ['scene', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'shot', 'act', 'note', 'message', 'titlecard'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export interface Block {
  id: string;
  type: BlockType;
  text: string;
}

export interface Entity {
  id: string;
  name: string;
  aliases: string[];
  description: string;
}

export type ClaimStatus = 'candidate' | 'confirmed' | 'archived';
export interface Claim {
  id: string;
  text: string;
  status: ClaimStatus;
  sourceBlockId?: string;
  characterId?: string;
  sourceRef?: { documentId: string; title: string; excerpt: string; locator?: string };
  /** Hidden carry-over links to round-trip a temporary foreshadowing conversion. */
  threadLinks?: { setupBlockId?: string; payoffBlockId?: string };
  /** Preserve the richer in-progress state when a thread is temporarily shown as a setting. */
  threadStatus?: ThreadStatus;
}

export type ThreadStatus = 'open' | 'progress' | 'resolved' | 'abandoned';
export interface Thread {
  id: string;
  title: string;
  status: ThreadStatus;
  setupBlockId?: string;
  payoffBlockId?: string;
  characterId?: string;
  /** Marks a new blank record so it can be discarded until edited. */
  emptyDraft?: boolean;
  sourceRef?: { documentId: string; title: string; excerpt: string; locator?: string };
}

export const RELATION_TYPES = ['family', 'love', 'friend', 'ally', 'mentor', 'work', 'rival', 'enemy', 'other'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
/** An author-confirmed relationship between two characters, keyed by character name. */
export interface Relation {
  id: string;
  from: string;
  to: string;
  type: RelationType;
  label?: string;
  /** Scene-heading block id from which this relation holds; a later relation for the same pair supersedes it. */
  sinceScene?: string;
}

export type MindMapMarker = 'todo' | 'done' | 'important' | 'question' | 'foreshadow' | 'turn';

export interface MindNode {
  id: string;
  text: string;
  children: MindNode[];
  collapsed?: boolean;
  /** For main branches: which side of the centre topic the writer placed it on. */
  side?: 'left' | 'right';
  /** Free-form writer notes, kept separate from the visible topic label. */
  note?: string;
  /** Linked screenplay scene-heading block id. */
  sceneId?: string;
  marker?: MindMapMarker;
  /** Palette index (0..7), inherited by every node in the branch. */
  color?: number;
  /** True for nodes refreshed from screenplay analysis. */
  generated?: boolean;
  /** True when writer text has diverged from generated screenplay content. */
  edited?: boolean;
}

/** Cover page metadata — kept apart from the script body and printed as its own page. */
export interface TitlePage {
  title?: string;
  subtitle?: string;
  author?: string;
  basedOn?: string;
  draft?: string;
  date?: string;
  contact?: string;
  notes?: string;
  print?: boolean;
}

export interface StoryOutline {
  logline?: string;
  synopsis?: string;
  core?: string;
}

export interface Project {
  id: string;
  title: string;
  updatedAt: string;
  blocks: Block[];
  entities: Entity[];
  claims: Claim[];
  threads: Thread[];
  /** Stable display order shared by legacy claims and threads in the unified story-record list. */
  recordOrder?: string[];
  relations?: Relation[];
  mindmap?: MindNode;
  titlePage?: TitlePage;
  /** Index-card data keyed by scene-heading block id. */
  sceneMeta?: Record<string, SceneMeta>;
  comments?: ScriptComment[];
  /** Film uses 幕 for act blocks; series and short dramas use 集 (episodes). */
  kind?: ProjectKind;
  /** Knowledge matrix: who learns each fact, and in which scene. */
  facts?: StoryFact[];
  /** Who the knowledge matrix tracks, left to right (character names or AUDIENCE). */
  factColumns?: string[];
  /** User-authored one-sentence story, synopsis, and core message. */
  storyOutline?: StoryOutline;
  /** Series bible: character profiles keyed by character name. */
  bible?: Record<string, CharacterProfile>;
  /** Incomplete character profiles; drafts are excluded from story analysis until named and committed. */
  characterDrafts?: CharacterDraft[];
  /** Page format (chosen when the script is created, then fixed) and screen/print fonts. */
  settings?: ProjectSettings;
  /** Project-scoped state for suggestion dismissals, manually hidden locations, and heuristic candidate triage. */
  dismissedIdentitySuggestions?: string[];
  ignoredStoryCandidates?: string[];
  hiddenLocations?: string[];
}

export type FormatPreset = 'us-screenplay' | 'taiwan-work';
export interface ProjectSettings { preset: FormatPreset; fonts?: { latin: string; cjk: string }; showActHeadings?: boolean; autoContinuation?: boolean }

export type ProjectKind = 'film' | 'series' | 'short';
/** `known` maps a character name (or AUDIENCE) to the scene-heading id where they learn the fact. */
export interface StoryFact { id: string; text: string; known: Record<string, string> }
export const AUDIENCE = '__audience';
export const PROFILE_FIELDS = ['age', 'role', 'look', 'personality', 'want', 'need', 'flaw', 'arc', 'backstory', 'notes'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type CharacterProfile = Partial<Record<ProfileField, string>> & {
  /** 使用者自選的頭像色相（0–359）；沒有就依名字計算。 */
  avatarHue?: number;
  /** 手動指定的角色層級；沒有就自動分級。 */
  tier?: 'lead' | 'support' | 'extra';
};
export interface CharacterDraft { id: string; fields: CharacterProfile & { name?: string }; touched?: boolean }

export type SceneColor = '' | 'gold' | 'rose' | 'jade' | 'sky' | 'violet' | 'slate';
/** Index-card data; for act blocks the summary is the act / episode outline. */
export interface SceneMeta { summary?: string; color?: SceneColor; storyTime?: string; storyOrder?: number }
export interface ScriptComment { id: string; blockId: string; text: string; createdAt: string; resolved?: boolean }

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface TrashedProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
  deletedAt: string;
  snapshotCount: number;
  sfeFile?: boolean;
}

export interface TrashedItemSummary {
  id: string;
  kind: 'snapshot' | 'backup';
  title: string;
  projectId?: string | null;
  originalId?: string | null;
  originalName?: string | null;
  createdAt: string;
  deletedAt: string;
}

export interface SnapshotSummary {
  id: string;
  createdAt: string;
  title: string;
}

export type StoryTab = 'characters' | 'claims' | 'threads';
