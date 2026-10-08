import type { Block } from './types';

type ScriptPreset = 'us-screenplay' | 'taiwan-work' | 'custom';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Preserve the US 12pt/line pitch for Latin scripts; add CJK breathing room only for screenplay content. */
export function effectiveScriptLineSpacing(blocks: readonly Pick<Block, 'type' | 'text'>[], preset: ScriptPreset, requested: number): number {
  const base = Math.max(1, Number(requested) || 1);
  if (preset !== 'us-screenplay') return base;
  return blocks.some((block) => block.type !== 'note' && CJK.test(block.text)) ? Math.max(1.25, base) : base;
}
