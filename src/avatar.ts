import type { CSSProperties } from 'react';

/** A deterministic hue for the character's canonical, normalized name. */
export function avatarHue(name: string): number {
  const canonical = name.normalize('NFKC').trim();
  if (!canonical) return 35;
  let hash = 2166136261;
  for (const character of canonical) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return (hash >>> 0) % 360;
}

export function avatarStyle(name: string, profile?: { avatarHue?: number }): CSSProperties {
  return { '--avatar-hue': String(resolveAvatarHue(name, profile)) } as CSSProperties;
}


/**
 * 使用者可在人物設定挑的頭像色（色相）。低彩度，和紙／黃銅配色協調。
 * 存在 CharacterProfile.avatarHue；沒選就用名字算出的色相。
 */
export const AVATAR_HUES: { hue: number; label: string }[] = [
  { hue: 8, label: '朱' }, { hue: 28, label: '赭' }, { hue: 42, label: '黃銅' }, { hue: 88, label: '苔' },
  { hue: 150, label: '松' }, { hue: 188, label: '青' }, { hue: 212, label: '藍灰' }, { hue: 250, label: '靛' },
  { hue: 290, label: '紫' }, { hue: 330, label: '胭脂' },
];

type ProfileLike = { avatarHue?: number } | undefined;

/** 解析一個角色實際使用的色相：使用者自選優先。 */
export function resolveAvatarHue(name: string, profile?: ProfileLike): number {
  const custom = profile?.avatarHue;
  return typeof custom === 'number' && Number.isFinite(custom) ? ((Math.round(custom) % 360) + 360) % 360 : avatarHue(name);
}

/** SVG 用的實際顏色（與 .gp-avatar 的 CSS 公式一致）。 */
export const avatarFill = (hue: number) => `hsl(${hue} 23% 84%)`;
export const avatarInk = (hue: number) => `hsl(${hue} 28% 25%)`;
