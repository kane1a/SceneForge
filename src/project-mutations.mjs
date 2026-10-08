const norm = (value) => String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase();
const textValue = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

function clearRemovedReference(object, field, removedIds) {
  return removedIds.has(object?.[field]) ? { ...object, [field]: undefined } : object;
}

/** Remove a scene heading and all following blocks before the next scene or act. */
export function removeSceneFromProject(project, sceneId) {
  const start = project.blocks.findIndex((block) => block.id === sceneId && block.type === 'scene');
  if (start < 0) throw new Error(`找不到場景：${sceneId}`);
  let end = project.blocks.length;
  for (let index = start + 1; index < project.blocks.length; index += 1) {
    if (project.blocks[index].type === 'scene' || project.blocks[index].type === 'act') {
      end = index;
      break;
    }
  }
  const deleted = project.blocks.slice(start, end);
  const removedIds = new Set(deleted.map((block) => block.id));
  return {
    ...project,
    blocks: project.blocks.filter((_, index) => index < start || index >= end),
    sceneMeta: project.sceneMeta ? Object.fromEntries(Object.entries(project.sceneMeta).filter(([id]) => !removedIds.has(id))) : project.sceneMeta,
    comments: Array.isArray(project.comments) ? project.comments.filter((comment) => !removedIds.has(comment.blockId)) : project.comments,
    claims: Array.isArray(project.claims) ? project.claims.map((claim) => clearRemovedReference(claim, 'sourceBlockId', removedIds)) : project.claims,
    threads: Array.isArray(project.threads) ? project.threads.map((thread) => ({
      ...clearRemovedReference(clearRemovedReference(thread, 'setupBlockId', removedIds), 'payoffBlockId', removedIds),
    })) : project.threads,
    facts: Array.isArray(project.facts) ? project.facts.map((fact) => {
      if (!fact.known || typeof fact.known !== 'object') return fact;
      return { ...fact, known: Object.fromEntries(Object.entries(fact.known).filter(([, id]) => !removedIds.has(id))) };
    }) : project.facts,
    relations: Array.isArray(project.relations) ? project.relations.map((relation) => clearRemovedReference(relation, 'sinceScene', removedIds)) : project.relations,
  };
}

function dedupeRelations(relations) {
  const seen = new Set();
  return relations.filter((relation) => {
    const key = JSON.stringify(Object.fromEntries(Object.entries(relation)
      .filter(([field]) => !['id', 'createdAt', 'updatedAt'].includes(field))
      .sort(([a], [b]) => a.localeCompare(b))));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeEntities(entities, target) {
  const seen = new Set();
  return entities.filter((entity) => {
    if (entity.id === target.id) {
      if (seen.has(`id:${entity.id}`)) return false;
      seen.add(`id:${entity.id}`);
      return true;
    }
    const key = `name:${norm(entity.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renameExactMindMapNames(node, sourceNames, targetName) {
  if (!node || typeof node !== 'object') return node;
  return {
    ...node,
    text: sourceNames.has(norm(node.text)) ? targetName : node.text,
    children: Array.isArray(node.children) ? node.children.map((child) => renameExactMindMapNames(child, sourceNames, targetName)) : node.children,
  };
}

/** Merge a source character into a target without altering manuscript block text. */
export function mergeCharacters(project, fromName, toName) {
  if (norm(fromName) === norm(toName)) throw new Error('來源與目標角色不可相同');
  const entities = Array.isArray(project.entities) ? project.entities : [];
  const sourceEntity = entities.find((entity) => norm(entity.name) === norm(fromName));
  const targetEntity = entities.find((entity) => norm(entity.name) === norm(toName));
  const sourceProfile = project.bible?.[fromName] ?? {};
  const targetProfile = project.bible?.[toName] ?? {};
  const sourceId = sourceEntity?.id;
  const target = targetEntity ?? { id: globalThis.crypto?.randomUUID?.() ?? `character-${Date.now()}`, name: toName, aliases: [] };
  const sourceNames = [...new Set([fromName, ...(sourceEntity?.aliases ?? [])].filter((name) => typeof name === 'string' && name.trim()))];
  const thirdPartyNames = new Set(entities
    .filter((entity) => entity !== sourceEntity && entity !== targetEntity)
    .flatMap((entity) => [entity.name, ...(entity.aliases ?? [])])
    .map(norm));
  const aliasCandidates = [...(target.aliases ?? []), ...sourceNames].filter((name) => {
    const key = norm(name);
    return key && key !== norm(target.name) && !thirdPartyNames.has(key);
  });
  const aliases = [];
  const seenAliases = new Set();
  for (const alias of aliasCandidates) {
    const key = norm(alias);
    if (!seenAliases.has(key)) {
      seenAliases.add(key);
      aliases.push(alias);
    }
  }
  const mergedTarget = { ...target, name: target.name || toName, aliases };
  const mergedProfile = { ...targetProfile };
  for (const [field, sourceValue] of Object.entries(sourceProfile)) {
    const incoming = textValue(sourceValue).trim();
    if (!incoming) continue;
    const existing = textValue(mergedProfile[field]).trim();
    if (!existing) mergedProfile[field] = sourceValue;
    else mergedProfile[field] = `${existing}\n（合併自 ${fromName}）\n${incoming}`;
  }

  const nextEntities = [];
  let targetInserted = false;
  for (const entity of entities) {
    if (entity === sourceEntity) continue;
    if (entity === targetEntity) {
      nextEntities.push(mergedTarget);
      targetInserted = true;
    } else nextEntities.push(entity);
  }
  if (!targetInserted) nextEntities.push(mergedTarget);
  const oldKeys = new Set(sourceNames.map(norm));
  const targetName = mergedTarget.name;
  const blockIndex = new Map(project.blocks.map((block, index) => [block.id, index]));
  const facts = Array.isArray(project.facts) ? project.facts.map((fact) => {
    if (!fact.known || typeof fact.known !== 'object') return fact;
    const known = { ...fact.known };
    const sourceValues = Object.entries(known).filter(([name]) => oldKeys.has(norm(name))).map(([, value]) => value).filter(Boolean);
    for (const name of Object.keys(known)) if (oldKeys.has(norm(name))) delete known[name];
    const targetValue = known[targetName];
    if (sourceValues.length) {
      const values = targetValue ? [targetValue, ...sourceValues] : sourceValues;
      known[targetName] = values.reduce((best, value) => {
        const a = blockIndex.has(best) ? blockIndex.get(best) : Number.MAX_SAFE_INTEGER;
        const b = blockIndex.has(value) ? blockIndex.get(value) : Number.MAX_SAFE_INTEGER;
        return b < a ? value : best;
      });
    }
    return { ...fact, known };
  }) : project.facts;
  const relations = Array.isArray(project.relations) ? dedupeRelations(project.relations.map((relation) => {
    const updated = { ...relation };
    for (const field of ['from', 'to', 'source', 'target']) {
      if (oldKeys.has(norm(updated[field])) || (sourceId && updated[field] === sourceId)) updated[field] = targetName;
    }
    for (const field of ['fromId', 'toId', 'sourceId', 'targetId']) {
      if (sourceId && updated[field] === sourceId) updated[field] = mergedTarget.id;
    }
    return updated;
  }).filter((relation) => !(relation.from && relation.to && norm(relation.from) === norm(relation.to)))) : project.relations;
  const factColumns = Array.isArray(project.factColumns) ? project.factColumns.map((name) => oldKeys.has(norm(name)) ? targetName : name) : project.factColumns;
  const dedupedFactColumns = factColumns ? factColumns.filter((name, index) => factColumns.findIndex((item) => norm(item) === norm(name)) === index) : factColumns;
  const claims = Array.isArray(project.claims) ? project.claims.map((claim) => {
    if ((sourceId && claim.characterId === sourceId) || (claim.characterId && oldKeys.has(norm(claim.characterId)))) return { ...claim, characterId: mergedTarget.id };
    return claim;
  }) : project.claims;
  const threads = Array.isArray(project.threads) ? project.threads.map((thread) => {
    if ((sourceId && thread.characterId === sourceId) || (thread.characterId && oldKeys.has(norm(thread.characterId)))) return { ...thread, characterId: mergedTarget.id };
    return thread;
  }) : project.threads;
  const bible = { ...(project.bible ?? {}) };
  delete bible[fromName];
  bible[targetName] = mergedProfile;
  // Server schema requires every entity to carry string description + aliases.
  const safeEntities = dedupeEntities(nextEntities, mergedTarget).map((entity) => ({ ...entity, aliases: Array.isArray(entity.aliases) ? entity.aliases : [], description: typeof entity.description === 'string' ? entity.description : '' }));
  return { ...project, entities: safeEntities, bible, relations, facts, factColumns: dedupedFactColumns, claims, threads, mindmap: project.mindmap ? renameExactMindMapNames(project.mindmap, oldKeys, targetName) : project.mindmap };
}

/** Change a unified record's kind while keeping its identity and compatible links. */
export function setStoryRecordKind(project, recordId, kind) {
  if (kind === 'thread') {
    const claim = (project.claims ?? []).find((item) => item.id === recordId);
    if (!claim) throw new Error(`找不到設定紀錄：${recordId}`);
    const carriedLinks = claim.threadLinks;
    const originalSource = carriedLinks?.setupBlockId ?? carriedLinks?.payoffBlockId;
    const sourceUnchanged = !!carriedLinks && claim.sourceBlockId === originalSource;
    const setupBlockId = sourceUnchanged ? carriedLinks?.setupBlockId : claim.sourceBlockId;
    const thread = {
      id: claim.id,
      title: claim.text,
      status: claim.status === 'confirmed' ? 'resolved' : claim.status === 'archived' ? 'abandoned' : claim.threadStatus === 'progress' ? 'progress' : 'open',
      ...(setupBlockId ? { setupBlockId } : {}),
      ...(claim.threadLinks?.payoffBlockId ? { payoffBlockId: claim.threadLinks.payoffBlockId } : {}),
      ...(claim.characterId ? { characterId: claim.characterId } : {}),
      ...(claim.sourceRef ? { sourceRef: claim.sourceRef } : {}),
    };
    return { ...project, claims: (project.claims ?? []).filter((item) => item.id !== recordId), threads: [...(project.threads ?? []).filter((item) => item.id !== recordId), thread] };
  }
  const thread = (project.threads ?? []).find((item) => item.id === recordId);
  if (!thread) throw new Error(`找不到伏筆紀錄：${recordId}`);
  const claim = {
    id: thread.id,
    text: thread.title,
    status: thread.status === 'resolved' ? 'confirmed' : thread.status === 'abandoned' ? 'archived' : 'candidate',
    ...(thread.status === 'progress' ? { threadStatus: 'progress' } : {}),
    ...((thread.setupBlockId ?? thread.payoffBlockId) ? { sourceBlockId: thread.setupBlockId ?? thread.payoffBlockId } : {}),
    ...((thread.setupBlockId || thread.payoffBlockId) ? { threadLinks: { ...(thread.setupBlockId ? { setupBlockId: thread.setupBlockId } : {}), ...(thread.payoffBlockId ? { payoffBlockId: thread.payoffBlockId } : {}) } } : {}),
    ...(thread.characterId ? { characterId: thread.characterId } : {}),
    ...(thread.sourceRef ? { sourceRef: thread.sourceRef } : {}),
  };
  return { ...project, threads: (project.threads ?? []).filter((item) => item.id !== recordId), claims: [...(project.claims ?? []).filter((item) => item.id !== recordId), claim] };
}

/** Return a filtered, duplicate-free display order and append records not yet indexed. */
export function getStoryRecordOrder(project) {
  const records = [...(project.claims ?? []), ...(project.threads ?? [])];
  const valid = new Set(records.map((item) => item.id));
  const seen = new Set();
  const order = [];
  for (const id of project.recordOrder ?? []) {
    if (valid.has(id) && !seen.has(id)) { seen.add(id); order.push(id); }
  }
  for (const item of records) {
    if (!seen.has(item.id)) { seen.add(item.id); order.push(item.id); }
  }
  return order;
}

/** Promote a legacy claim to the unified thread model without changing its ID or list position. */
export function convertClaimToThread(project, recordId, updates = {}) {
  const claim = (project.claims ?? []).find((item) => item.id === recordId);
  if (!claim) throw new Error(`找不到設定紀錄：${recordId}`);
  const carriedLinks = claim.threadLinks;
  const originalSource = carriedLinks?.setupBlockId ?? carriedLinks?.payoffBlockId;
  const sourceUnchanged = !!carriedLinks && claim.sourceBlockId === originalSource;
  const setupBlockId = sourceUnchanged ? carriedLinks?.setupBlockId : claim.sourceBlockId;
  const thread = {
    id: claim.id,
    title: claim.text,
    status: claim.status === 'archived' ? 'abandoned' : 'open',
    ...(setupBlockId ? { setupBlockId } : {}),
    ...(carriedLinks?.payoffBlockId ? { payoffBlockId: carriedLinks.payoffBlockId } : {}),
    ...(claim.characterId ? { characterId: claim.characterId } : {}),
    ...(claim.sourceRef ? { sourceRef: claim.sourceRef } : {}),
  };
  for (const key of ['title', 'status', 'setupBlockId', 'payoffBlockId', 'characterId', 'sourceRef']) {
    if (!Object.hasOwn(updates, key)) continue;
    if (updates[key] === undefined || updates[key] === '') delete thread[key];
    else thread[key] = updates[key];
  }
  const recordOrder = getStoryRecordOrder(project);
  return {
    ...project,
    claims: (project.claims ?? []).filter((item) => item.id !== recordId),
    threads: [...(project.threads ?? []).filter((item) => item.id !== recordId), thread],
    recordOrder,
  };
}

const PROFILE_FIELD_NAMES = new Set(['age', 'role', 'look', 'personality', 'want', 'need', 'flaw', 'arc', 'backstory', 'notes']);
export const CHARACTER_DRAFT_FOCUS_PREFIX = 'sceneforge-character-draft:';

export function characterDraftFocusKey(draftId) {
  return `${CHARACTER_DRAFT_FOCUS_PREFIX}${draftId}`;
}

export function parseCharacterDraftFocusKey(value) {
  return typeof value === 'string' && value.startsWith(CHARACTER_DRAFT_FOCUS_PREFIX)
    ? value.slice(CHARACTER_DRAFT_FOCUS_PREFIX.length)
    : '';
}

export function addCharacterDraft(project, draftId = globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now().toString(36)}`) {
  if (typeof draftId !== 'string' || !draftId.trim()) throw new Error('角色草稿需要有效的 ID');
  const drafts = Array.isArray(project.characterDrafts) ? project.characterDrafts : [];
  if (drafts.some((draft) => draft.id === draftId)) throw new Error(`角色草稿 ID 已存在：${draftId}`);
  return { ...project, characterDrafts: [...drafts, { id: draftId, fields: {} }] };
}

export function updateCharacterDraft(project, draftId, fields) {
  const drafts = Array.isArray(project.characterDrafts) ? project.characterDrafts : [];
  if (!drafts.some((draft) => draft.id === draftId)) throw new Error(`找不到角色草稿：${draftId}`);
  const patch = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (key !== 'name' && !PROFILE_FIELD_NAMES.has(key)) continue;
    if (typeof value === 'string') patch[key] = value;
  }
  return {
    ...project,
    characterDrafts: drafts.map((draft) => draft.id === draftId ? { ...draft, fields: { ...draft.fields, ...patch }, touched: draft.touched || Object.keys(patch).length > 0 } : draft),
  };
}

function characterDraftHasContent(draft) {
  return draft?.touched === true || Object.values(draft?.fields ?? {}).some((value) => typeof value === 'string' && value.trim().length > 0);
}

export function discardEmptyCharacterDraft(project, draftId) {
  const drafts = Array.isArray(project.characterDrafts) ? project.characterDrafts : [];
  const draft = drafts.find((item) => item.id === draftId);
  if (!draft || characterDraftHasContent(draft)) return project;
  return { ...project, characterDrafts: drafts.filter((item) => item.id !== draftId) };
}

function duplicateCharacterName(project, name) {
  const aliases = (project.entities ?? []).flatMap((entity) => (entity.aliases ?? []).map(() => entity.name));
  const speakers = (project.blocks ?? []).filter((block) => block.type === 'character').map((block) => block.text.trim().replace(/[：:]$/u, ''));
  const names = [
    ...(project.entities ?? []).map((entity) => entity.name),
    ...Object.keys(project.bible ?? {}),
    ...speakers,
    ...(project.relations ?? []).flatMap((relation) => [relation.from, relation.to]),
  ].filter((value) => typeof value === 'string' && value.trim());
  const key = norm(name);
  const exact = names.find((item) => norm(item) === key);
  if (exact) return exact;
  for (const entity of project.entities ?? []) {
    if ((entity.aliases ?? []).some((alias) => norm(alias) === key)) return entity.name;
  }
  return aliases.find((item) => norm(item) === key) ?? '';
}

function removeCharacterDraft(project, draftId) {
  return { ...project, characterDrafts: (project.characterDrafts ?? []).filter((draft) => draft.id !== draftId) };
}

export function commitCharacterDraft(project, draftId, rawName, { mergeInto } = {}) {
  const name = String(rawName ?? '').trim();
  const draft = (project.characterDrafts ?? []).find((item) => item.id === draftId);
  if (!draft) return { status: 'missing', project };
  if (!name) return { status: 'empty-name', project };

  const duplicate = duplicateCharacterName(project, name);
  if (duplicate && (!mergeInto || norm(duplicate) !== norm(mergeInto))) return { status: 'duplicate', duplicate, project };
  const targetName = duplicate || name;
  const incomingProfile = Object.fromEntries(Object.entries(draft.fields ?? {}).filter(([field, value]) => PROFILE_FIELD_NAMES.has(field) && typeof value === 'string' && value.trim()));
  const profile = { ...(project.bible?.[targetName] ?? {}) };
  for (const [field, value] of Object.entries(incomingProfile)) {
    const current = textValue(profile[field]).trim();
    if (!current) profile[field] = value;
    else if (current !== value.trim()) profile[field] = `${current}\n（合併自新增角色）\n${value.trim()}`;
  }
  const bible = { ...(project.bible ?? {}), [targetName]: profile };
  const entities = [...(project.entities ?? [])];
  if (!entities.some((entity) => norm(entity.name) === norm(targetName))) {
    entities.push({ id: globalThis.crypto?.randomUUID?.() ?? `character-${Date.now()}`, name: targetName, aliases: [], description: '' });
  }
  const next = removeCharacterDraft({ ...project, bible, entities }, draftId);
  return { status: duplicate ? 'merged' : 'committed', duplicate, name: targetName, project: next };
}

/** Remove only blank, default-state threads; anything linked or deliberately shelved is kept. */
export function removeUntouchedEmptyStoryRecords(project) {
  const threads = (project.threads ?? []).filter((thread) => !(thread.emptyDraft === true
    && !thread.title.trim() && thread.status === 'open'
    && !thread.setupBlockId && !thread.payoffBlockId && !thread.characterId && !thread.sourceRef));
  if (threads.length === (project.threads ?? []).length) return project;
  const next = { ...project, threads };
  return { ...next, recordOrder: getStoryRecordOrder(next) };
}

