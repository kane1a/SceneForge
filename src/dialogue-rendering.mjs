const EXTENSIONS = /\s*(?:\((?:V\.O\.|O\.S\.|O\.C\.|CONT'D)\)|（(?:續|畫外音|畫外)）)\s*$/iu;
const CONTINUATION = /(?:\(CONT'D\)|（續）)\s*$/iu;

function canonicalSpeaker(text) {
  let name = text.trim().replace(/[：:]$/u, '').trim();
  while (EXTENSIONS.test(name)) name = name.replace(EXTENSIONS, '').trim();
  return name.normalize('NFKC').toLocaleLowerCase();
}

/** Return character cue IDs that speak again after their own previous cue in the same scene. */
export function getContinuationCueIds(blocks) {
  const ids = new Set();
  let inScene = false;
  let lastSpeaker = '';
  let lastSpeakerSpoke = false;
  for (const block of blocks) {
    if (block.type === 'scene' || block.type === 'act') {
      inScene = block.type === 'scene';
      lastSpeaker = '';
      lastSpeakerSpoke = false;
      continue;
    }
    if (block.type === 'character') {
      const speaker = canonicalSpeaker(block.text);
      if (inScene && speaker && speaker === lastSpeaker && lastSpeakerSpoke) ids.add(block.id);
      lastSpeaker = speaker;
      lastSpeakerSpoke = false;
      continue;
    }
    if (block.type === 'dialogue' && lastSpeaker) lastSpeakerSpoke = true;
  }
  return ids;
}

/** Add rendered continuation text to cloned character cues; source block text is never changed. */
export function withContinuationCues(blocks, format = 'us-screenplay', enabled = true) {
  if (!enabled) return blocks.map((block) => ({ ...block }));
  const ids = getContinuationCueIds(blocks);
  const suffix = format === 'taiwan-work' ? '（續）' : " (CONT'D)";
  return blocks.map((block) => {
    if (block.type !== 'character' || !ids.has(block.id) || CONTINUATION.test(block.text)) return { ...block };
    return { ...block, text: `${block.text.trimEnd()}${suffix}` };
  });
}
