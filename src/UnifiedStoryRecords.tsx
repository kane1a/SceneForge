import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, type SelectOption } from './ui-controls';
import { ScenePreview, buildSceneSelectOptions } from './scene-select';
import { askConfirm } from './confirm';
import { detectForeshadowCandidates, detectSettingCandidates, type StoryCandidate } from './story-candidates';
import { convertClaimToThread, getStoryRecordOrder, removeUntouchedEmptyStoryRecords } from './project-mutations.mjs';
import type { Claim, Project, Thread } from './types';

type Props = { project: Project; focusRecordId?: string; onChange: (change: (project: Project) => Project) => void; onOpen?: (blockId: string) => void };
type RecordState = 'unrecovered' | 'recovered' | 'paused';
type CandidateOrigin = 'setting' | 'thread';
type CandidateEntry = { origin: CandidateOrigin; candidate: StoryCandidate };
type StoryRecord = {
  id: string;
  text: string;
  state: RecordState;
  setupBlockId?: string;
  payoffBlockId?: string;
  characterId?: string;
  sourceRef?: Claim['sourceRef'] | Thread['sourceRef'];
  legacyClaim: boolean;
  emptyDraft?: boolean;
};
const RECORD_STATES: Record<RecordState, string> = { unrecovered: '未回收', recovered: '已回收', paused: '擱置' };
const RECORD_TONES: Record<RecordState, string> = { unrecovered: 'var(--warn)', recovered: 'var(--ok)', paused: 'var(--muted)' };
const RECORD_OPTIONS: SelectOption<RecordState>[] = (Object.entries(RECORD_STATES) as [RecordState, string][]).map(([value, label]) => ({ value, label, tone: RECORD_TONES[value] }));
const THREAD_STATES: Record<RecordState, Thread['status']> = { unrecovered: 'open', recovered: 'resolved', paused: 'abandoned' };
const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function sceneForBlock(blocks: Project['blocks'], blockId?: string): string {
  if (!blockId) return '';
  let sceneId = '';
  for (const block of blocks) {
    if (block.type === 'act') sceneId = '';
    if (block.type === 'scene') sceneId = block.id;
    if (block.id === blockId) return block.type === 'scene' ? block.id : sceneId;
  }
  return '';
}

function ScenePicker({ project, value, onChange, label }: { project: Project; value?: string; onChange: (id: string) => void; label: string }) {
  const options = useMemo(() => buildSceneSelectOptions(project.blocks, '尚未連結'), [project.blocks]);
  const selected = sceneForBlock(project.blocks, value);
  return <Select value={selected} options={options} onChange={onChange} ariaLabel={label} menuMinWidth={320} collapsibleGroups preview={(option) => option.value ? <ScenePreview project={project} sceneId={option.value} /> : null} />;
}

export default function UnifiedStoryRecords({ project, focusRecordId, onChange, onOpen }: Props) {
  const [openRecordIds, setOpenRecordIds] = useState<Set<string>>(() => new Set());
  const [candidatePanelOpen, setCandidatePanelOpen] = useState(false);
  const [candidateSearch, setCandidateSearch] = useState('');
  const textareaRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const initialFocusRecordId = useRef(focusRecordId);
  const latestOnChange = useRef(onChange);
  const cleanupTimer = useRef<number | null>(null);
  latestOnChange.current = onChange;
  const save = onChange;
  useEffect(() => {
    if (cleanupTimer.current !== null) window.clearTimeout(cleanupTimer.current);
    return () => {
      cleanupTimer.current = window.setTimeout(() => {
        latestOnChange.current((current) => removeUntouchedEmptyStoryRecords(current));
        cleanupTimer.current = null;
      }, 0);
    };
  }, [onChange]);
  const candidates = useMemo<CandidateEntry[]>(() => {
    if (!candidatePanelOpen) return [];
    const ignored = project.ignoredStoryCandidates ?? [];
    return [
      ...detectSettingCandidates(project).map((candidate) => ({ origin: 'setting' as const, candidate })),
      ...detectForeshadowCandidates(project).map((candidate) => ({ origin: 'thread' as const, candidate })),
    ].filter(({ origin, candidate }) => !ignored.includes(candidate.key) && !ignored.includes(`${origin}:${candidate.key}`)
      && (!candidateSearch.trim() || candidate.text.includes(candidateSearch.trim())));
  }, [candidatePanelOpen, project.blocks, project.entities, project.ignoredStoryCandidates, candidateSearch]);
  const characterOptions = useMemo<SelectOption[]>(() => [
    { value: '', label: '不指定' },
    ...project.entities.map((entity) => ({ value: entity.id, label: entity.name })),
  ], [project.entities]);

  const records = useMemo(() => {
    const unified: StoryRecord[] = [
      ...project.claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        state: claim.status === 'archived' ? 'paused' as const : 'unrecovered' as const,
        setupBlockId: claim.sourceBlockId,
        payoffBlockId: claim.threadLinks?.payoffBlockId,
        characterId: claim.characterId,
        sourceRef: claim.sourceRef,
        legacyClaim: true,
      })),
      ...project.threads.map((thread) => ({
        id: thread.id,
        text: thread.title,
        state: thread.status === 'resolved' ? 'recovered' as const : thread.status === 'abandoned' ? 'paused' as const : 'unrecovered' as const,
        setupBlockId: thread.setupBlockId,
        payoffBlockId: thread.payoffBlockId,
        characterId: thread.characterId,
        sourceRef: thread.sourceRef,
        legacyClaim: false,
        emptyDraft: thread.emptyDraft,
      })),
    ];
    const order = new Map(getStoryRecordOrder(project).map((id, index) => [id, index]));
    return unified.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [project.claims, project.threads, project.recordOrder]);

  useEffect(() => {
    if (initialFocusRecordId.current === focusRecordId) return;
    initialFocusRecordId.current = focusRecordId;
    if (!focusRecordId) return;
    const target = document.getElementById(`story-record-${focusRecordId}`);
    if (target instanceof HTMLDetailsElement) { target.open = true; setOpenRecordIds((items) => new Set(items).add(focusRecordId)); }
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusRecordId]);

  const setRecordOpen = (recordId: string, open: boolean) => {
    setOpenRecordIds((items) => { const next = new Set(items); if (open) next.add(recordId); else next.delete(recordId); return next; });
    if (!open && records.some((record) => record.id === recordId && record.emptyDraft)) {
      save((current) => removeUntouchedEmptyStoryRecords(current));
    }
  };
  const addRecord = () => {
    const thread: Thread = { id: newId(), title: '', status: 'open', emptyDraft: true };
    save((current) => ({ ...current, threads: [thread, ...current.threads], recordOrder: [thread.id, ...getStoryRecordOrder(current)] }));
    setOpenRecordIds((items) => new Set(items).add(thread.id));
    requestAnimationFrame(() => textareaRefs.current.get(thread.id)?.focus());
  };
  const updateText = (record: StoryRecord, text: string) => save((current) => record.legacyClaim
    ? { ...current, claims: current.claims.map((claim) => claim.id === record.id ? { ...claim, text } : claim) }
    : { ...current, threads: current.threads.map((thread) => thread.id === record.id ? { ...thread, title: text, emptyDraft: false } : thread) });
  const updateState = (record: StoryRecord, state: RecordState) => save((current) => {
    if (record.legacyClaim) return convertClaimToThread(current, record.id, { status: THREAD_STATES[state] });
    return { ...current, threads: current.threads.map((thread) => thread.id === record.id ? { ...thread, status: THREAD_STATES[state], emptyDraft: false } : thread) };
  });
  const updateScene = (record: StoryRecord, field: 'setupBlockId' | 'payoffBlockId', value: string) => save((current) => {
    const sceneId = value || undefined;
    if (record.legacyClaim && field === 'payoffBlockId') return convertClaimToThread(current, record.id, { payoffBlockId: sceneId });
    if (record.legacyClaim) return { ...current, claims: current.claims.map((claim) => {
      if (claim.id !== record.id) return claim;
      return { ...claim, sourceBlockId: sceneId, ...(claim.threadLinks ? { threadLinks: { ...claim.threadLinks, setupBlockId: sceneId } } : {}) };
    }) };
    return { ...current, threads: current.threads.map((thread) => thread.id === record.id ? { ...thread, [field]: sceneId, emptyDraft: false } : thread) };
  });
  const updateCharacter = (record: StoryRecord, characterId: string) => save((current) => record.legacyClaim
    ? { ...current, claims: current.claims.map((claim) => claim.id === record.id ? { ...claim, characterId: characterId || undefined } : claim) }
    : { ...current, threads: current.threads.map((thread) => thread.id === record.id ? { ...thread, characterId: characterId || undefined, emptyDraft: false } : thread) });
  const deleteRecord = async (record: StoryRecord) => {
    const confirmed = await askConfirm({ title: '刪除這筆紀錄？', message: `「${record.text || '未命名紀錄'}」會從伏筆與設定中移除。可以用 Ctrl+Z 復原。`, confirmLabel: '刪除紀錄', cancelLabel: '取消', danger: true });
    if (confirmed) save((current) => ({
      ...current,
      claims: current.claims.filter((item) => item.id !== record.id),
      threads: current.threads.filter((item) => item.id !== record.id),
      recordOrder: getStoryRecordOrder(current).filter((id) => id !== record.id),
    }));
  };
  const collectCandidate = (origin: CandidateOrigin, candidate: StoryCandidate) => {
    const hits = candidate.occurrences;
    const setupBlockId = hits[0]?.sceneId ?? sceneForBlock(project.blocks, candidate.sourceBlockId);
    const thread: Thread = {
      id: newId(), title: candidate.text, status: 'open',
      ...(setupBlockId ? { setupBlockId } : {}),
      ...(origin === 'thread' && hits.at(-1)?.sceneId ? { payoffBlockId: hits.at(-1)!.sceneId } : {}),
    };
    save((current) => ({ ...current, threads: [...current.threads, thread], recordOrder: [...getStoryRecordOrder(current), thread.id] }));
    setCandidatePanelOpen(false);
  };
  const ignoreCandidate = (origin: CandidateOrigin, key: string) => save((current) => ({ ...current, ignoredStoryCandidates: [...new Set([...(current.ignoredStoryCandidates ?? []), `${origin}:${key}`])] }));

  return <section className="story-section story-record-section unified-records" aria-label="伏筆與設定">
    <div className="story-section-header"><div><h2 className="story-page-title">伏筆與設定</h2><p className="story-page-subtitle">記錄會在後面回收的細節，或需要前後一致的設定。</p></div><div className="record-header-actions"><button type="button" className="button-primary button-small" onClick={addRecord}>新增</button><button type="button" className={`button-ghost${candidatePanelOpen ? ' active' : ''}`} aria-pressed={candidatePanelOpen} onClick={() => setCandidatePanelOpen((open) => !open)}>從劇本找候選</button></div></div>
    {candidatePanelOpen && <section className="story-candidates" aria-label="劇本候選">
      <header><div><strong>劇本候選</strong><small>依文字規則找出的內容，可能有遺漏或誤判。</small></div><input aria-label="搜尋候選" placeholder="搜尋候選…" value={candidateSearch} onChange={(event) => setCandidateSearch(event.target.value)} /></header>
      <div className="candidate-list">{candidates.map(({ origin, candidate }) => <article key={`${origin}:${candidate.key}`}>
        <div><strong>{candidate.text}</strong>
          <div className="candidate-occurrences">{candidate.occurrences.map((hit, index) => <button type="button" key={`${hit.blockId}-${index}`} onClick={() => onOpen?.(hit.sceneId)}>{`第 ${hit.sceneNumber} 場 · ${hit.excerpt.slice(0, 90)}${hit.excerpt.length > 90 ? '…' : ''}`}</button>)}</div>
        </div>
        <button type="button" className="button-primary button-small" onClick={() => collectCandidate(origin, candidate)}>收錄</button>
        <button type="button" className="button-ghost button-small" onClick={() => ignoreCandidate(origin, candidate.key)}>忽略</button>
      </article>)}{!candidates.length && <p className="section-empty">目前沒有候選。</p>}</div>
    </section>}
    {!records.length && !candidatePanelOpen && <p className="section-empty">還沒有紀錄。可手動新增，或從劇本找候選。</p>}
    <div className="record-list">
      {records.map((record) => {
        const isOpen = openRecordIds.has(record.id);
        return <details className={`record-item unified-record-item state-${record.state}`} id={`story-record-${record.id}`} key={record.id} open={isOpen} onToggle={(event) => setRecordOpen(record.id, event.currentTarget.open)}>
          <summary>
            {isOpen ? <span className="record-summary-label">內容</span> : <span className="record-summary-text">{record.text || '未命名紀錄'}</span>}
            <Select className={`record-status-pill status-${record.state}`} value={record.state} options={RECORD_OPTIONS} onChange={(state) => updateState(record, state)} ariaLabel="紀錄狀態" toned stopPropagation menuMinWidth={120} />
          </summary>
          {isOpen && <div className="record-fields record-unified-fields">
            <label className="record-content-field"><textarea aria-label="內容" ref={(element) => { if (element) textareaRefs.current.set(record.id, element); else textareaRefs.current.delete(record.id); }} value={record.text} maxLength={5000} onChange={(event) => updateText(record, event.target.value)} rows={2} /></label>
            <label>鋪陳場次<ScenePicker project={project} value={record.setupBlockId} label="鋪陳場次" onChange={(value) => updateScene(record, 'setupBlockId', value)} /></label>
            <label>回收場次<ScenePicker project={project} value={record.payoffBlockId} label="回收場次" onChange={(value) => updateScene(record, 'payoffBlockId', value)} /></label>
            <label>關聯角色<Select ariaLabel="關聯角色" value={record.characterId ?? ''} options={characterOptions} onChange={(value) => updateCharacter(record, value)} /></label>
            {record.sourceRef && <p className="record-source">參考資料：{record.sourceRef.title} · {record.sourceRef.locator ?? '未標頁'}</p>}
            <button className="delete-record" type="button" onClick={() => void deleteRecord(record)}>刪除紀錄</button>
          </div>}
        </details>;
      })}
    </div>
  </section>;
}
