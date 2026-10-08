const normalize = (value) => value.normalize('NFKC').trim().toLocaleLowerCase();
const EXTENSIONS = {
  hollywood: ['(V.O.)', '(O.S.)', '(O.C.)'],
  taiwan: ['（畫外音）', '（畫外）'],
};

/** Return only meaningful cue completions. Exact identities are never replaced by another name. */
export function getCharacterCandidates(typedValue, people, style) {
  const typed = typedValue.trim();
  if (!typed) return [];

  const openAt = Math.max(typed.lastIndexOf('('), typed.lastIndexOf('（'));
  if (openAt >= 0) {
    const name = typed.slice(0, openAt).trim();
    const partialExtension = typed.slice(openAt);
    const identity = normalize(name);
    const isKnownCue = people.some((person) => [person.name, ...(person.aliases ?? [])].some((candidate) => normalize(candidate) === identity));
    if (!isKnownCue) return [];
    const candidates = EXTENSIONS[style].filter((extension) => normalize(extension).startsWith(normalize(partialExtension)));
    if (candidates.some((extension) => normalize(extension) === normalize(partialExtension))) return [];
    const separator = style === 'hollywood' ? ' ' : '';
    return candidates.map((extension) => `${name}${separator}${extension}`);
  }

  const exact = normalize(typed);
  if (people.some((person) => [person.name, ...(person.aliases ?? [])].some((candidate) => normalize(candidate) === exact))) return [];
  return [...new Set(people
    .filter((person) => normalize(person.name).startsWith(exact))
    .map((person) => person.name))].slice(0, 8);
}
