import type { CharacterProfile } from './types';

export type CharacterTier = 'lead' | 'support' | 'extra';
export const TIER_LABELS: Record<CharacterTier, string> = { lead: '主要角色', support: '次要角色', extra: '路人' };

type Info = { name: string; lines: number; scenes: number[] };

/**
 * 依台詞量與出場場次自動分級，人物設定可手動覆寫。
 * 主要：台詞量前段且出場至少 3 場（最多 4 人，至少 1 人）。
 * 路人：只出場 1 場，或台詞不到 3 句且出場不到 2 場。
 */
export function autoTiers(characters: Info[]): Map<string, CharacterTier> {
  const result = new Map<string, CharacterTier>();
  const ranked = [...characters].sort((a, b) => b.lines - a.lines || b.scenes.length - a.scenes.length);
  const maxLines = Math.max(1, ranked[0]?.lines ?? 1);
  let leads = 0;
  ranked.forEach((info, index) => {
    const scenes = new Set(info.scenes).size;
    if (index === 0 && info.lines > 0) { result.set(info.name, 'lead'); leads += 1; return; }
    if (leads < 4 && scenes >= 3 && info.lines >= maxLines * 0.25) { result.set(info.name, 'lead'); leads += 1; return; }
    if (scenes <= 1 || (info.lines < 3 && scenes < 2)) { result.set(info.name, 'extra'); return; }
    result.set(info.name, 'support');
  });
  return result;
}

export function resolveTier(name: string, auto: Map<string, CharacterTier>, profile?: CharacterProfile): CharacterTier {
  return profile?.tier ?? auto.get(name) ?? 'support';
}
