import type { BlockType } from './types';

export const APP_CONFIG = {
  name: 'SceneForge',
  version: '0.6.27',
  locale: 'zh-Hant',
  apiBase: '/api',
  accent: '#ad6948',
} as const;

export const BLOCK_LABELS: Record<BlockType, string> = {
  scene: '場景',
  action: '動作',
  character: '角色',
  dialogue: '對白',
  parenthetical: '括號',
  transition: '轉場',
  shot: '鏡頭',
  act: '幕',
  note: '筆記',
  message: '訊息',
  titlecard: '字卡',
};

export const BLOCK_ORDER: BlockType[] = ['scene', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'shot', 'titlecard', 'act', 'message', 'note'];

export const CLAIM_STATUS_LABELS = {
  candidate: '待確認',
  confirmed: '已確認',
  archived: '已封存',
} as const;

export const THREAD_STATUS_LABELS = {
  open: '未展開',
  progress: '進行中',
  resolved: '已收束',
  abandoned: '已放棄',
} as const;
