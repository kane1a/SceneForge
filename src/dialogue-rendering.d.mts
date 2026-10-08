import type { Block } from './types';
export type ContinuationFormat = 'us-screenplay' | 'taiwan-work';
export function getContinuationCueIds(blocks: readonly Block[]): Set<string>;
export function withContinuationCues(blocks: readonly Block[], format?: ContinuationFormat, enabled?: boolean): Block[];
