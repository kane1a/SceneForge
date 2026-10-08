import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { analyzeStory } from './story-analysis';
import { Select, type SelectOption } from './ui-controls';
import { ScenePreview, buildSceneSelectOptions } from './scene-select';
import { askConfirm } from './confirm';
import { AUDIENCE, type Project, type StoryFact } from './types';

interface Props {
  project: Project;
  onChange: (change: { facts?: StoryFact[]; factColumns?: string[] }) => void;
  focusFactId?: string;
  onFocusFact?: (factId: string) => void;
}

const newId = () => globalThis.crypto?.randomUUID?.() ?? `sf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

/** A text box that keeps its width and grows downward as the writer types. */
function GrowingText({ value, onChange, autoFocus, placeholder }: { value: string; onChange: (value: string) => void; autoFocus?: boolean; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} value={value} autoFocus={autoFocus} placeholder={placeholder} aria-label="資訊內容" onChange={(event) => onChange(event.target.value)} />;
}

function MatrixGuide() {
  return <ul className="matrix-guide" aria-label="知情表說明">
    <li><strong>每列</strong><span>一筆秘密或資訊</span></li>
    <li><strong>每欄</strong><span>觀眾或角色</span></li>
    <li><strong>格子</strong><span>首次知情場次</span></li>
    <li><strong>懸念</strong><span>觀眾先知道</span></li>
    <li><strong>謎團</strong><span>角色先知道</span></li>
  </ul>;
}

/**
 * 知情矩陣: for each secret or piece of information, the scene where each chosen person — or the
 * audience — learns it. Gaps between the two are where suspense (audience knows first) and
 * mystery (a character knows first) live.
 */
export default function KnowledgeMatrix({ project, onChange, focusFactId, onFocusFact }: Props) {
  const analysis = useMemo(() => analyzeStory(project), [project]);
  const facts = project.facts ?? [];
  const [at, setAt] = useState<number | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => {
    if (!focusFactId) return;
    document.getElementById(`matrix-fact-${focusFactId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusFactId, facts.length]);
  const sceneIndex = useMemo(() => new Map(analysis.scenes.map((scene) => [scene.id, scene.index])), [analysis.scenes]);
  const names = useMemo(() => analysis.characters.map((info) => info.name), [analysis.characters]);
  const atOptions = useMemo<SelectOption[]>(() => buildSceneSelectOptions(project.blocks, '全劇結束'), [project.blocks]);
  const sceneOptions = useMemo<SelectOption[]>(() => buildSceneSelectOptions(project.blocks, '—'), [project.blocks]);
  const personOptions = useMemo<SelectOption[]>(() => [
    { value: AUDIENCE, label: '觀眾' },
    ...names.map((name) => ({ value: name, label: name })),
  ], [names]);
  // Columns are the writer's choice (saved with the script); one column to start with.
  const columns = project.factColumns ?? [AUDIENCE];
  const label = (who: string) => who === AUDIENCE ? '觀眾' : who;

  const setColumns = (next: string[]) => onChange({ factColumns: next });
  const changeColumn = (index: number, who: string) => {
    const before = columns[index];
    if (!who || who === before) return;
    const next = columns.map((item, i) => i === index ? who : item);
    // Carry the recorded scenes over to the person now in this column.
    onChange({ factColumns: next, facts: facts.map((fact) => { if (!(before in fact.known)) return fact; const known = { ...fact.known, [who]: fact.known[before] }; delete known[before]; return { ...fact, known }; }) });
  };
  const addColumn = () => {
    const unused = [AUDIENCE, ...names].find((who) => !columns.includes(who));
    if (unused) setColumns([...columns, unused]);
  };
  const removeColumn = async (index: number) => {
    const who = columns[index];
    const confirmed = await askConfirm({ title: `移除「${label(who)}」這一欄？`, message: `所有資訊中「${label(who)}」已記錄的知情場次也會一併移除。可以用 Ctrl+Z 復原。`, confirmLabel: '移除欄位', cancelLabel: '取消', danger: true });
    if (!confirmed) return;
    onChange({ factColumns: columns.filter((_, i) => i !== index), facts: facts.map((fact) => { if (!(who in fact.known)) return fact; const known = { ...fact.known }; delete known[who]; return { ...fact, known }; }) });
  };
  const deleteFact = async (fact: StoryFact) => {
    const confirmed = await askConfirm({ title: '刪除這筆資訊？', message: `「${fact.text || '未命名資訊'}」及其所有知情場次會一併刪除。可以用 Ctrl+Z 復原。`, confirmLabel: '刪除資訊', cancelLabel: '取消', danger: true });
    if (confirmed) onChange({ facts: facts.filter((item) => item.id !== fact.id) });
  };
  const setKnown = (fact: StoryFact, who: string, sceneId: string) => {
    const known = { ...fact.known };
    if (sceneId) known[who] = sceneId; else delete known[who];
    onChange({ facts: facts.map((item) => item.id === fact.id ? { ...item, known } : item) });
  };
  const addFact = () => {
    const fact = { id: newId(), text: '', known: {} };
    setFresh(fact.id);
    onChange({ facts: [...facts, fact] });
  };

  if (!analysis.scenes.length) return <div className="graph-empty"><h2>知情表</h2><p className="story-page-subtitle">追蹤秘密在第幾場揭露。</p><MatrixGuide /></div>;

  return <div className="matrix-view">
    <header className="matrix-head">
      <div>
        <h2>知情表</h2>
        <p className="story-page-subtitle">記錄每項資訊的知情場次。</p>
        <MatrixGuide />
      </div>
      <label className="matrix-at">看到
        <Select className="matrix-at-select" value={at === null ? '' : analysis.scenes[at]?.id ?? ''} options={atOptions} onChange={(value) => setAt(value ? sceneIndex.get(value) ?? null : null)} ariaLabel="看到哪一場時" menuMinWidth={260} collapsibleGroups preview={(option) => option.value ? <ScenePreview project={project} sceneId={option.value} /> : null} />時
      </label>
    </header>
    <div className="matrix-wrap">
      <table className="matrix">
        <thead><tr>
          <th className="matrix-fact">資訊</th>
          {columns.map((who, index) => <th key={`${who}-${index}`} className="matrix-person-col">
            <span className="matrix-col">
              <Select value={who} ariaLabel="這一欄追蹤的人" options={personOptions.filter((option) => option.value === who || !columns.includes(option.value))} onChange={(value) => changeColumn(index, value)} menuMinWidth={180} />
              <button type="button" className="matrix-person-column-delete" aria-label={`移除 ${label(who)} 這一欄`} title="移除這一欄" onClick={() => void removeColumn(index)}>×</button>
            </span>
          </th>)}
          <th className="matrix-plus">{columns.length < names.length + 1 && <button type="button" aria-label="新增一欄" title="新增一欄" onClick={addColumn}>＋</button>}</th>
          <th className="matrix-fill" aria-hidden="true" />
        </tr></thead>
        <tbody>
          {!facts.length && <tr><td className="matrix-empty" colSpan={columns.length + 3}>新增一筆資訊，再選擇每個角色首次得知的場次。</td></tr>}
          {facts.map((fact) => {
            return <tr key={fact.id} id={`matrix-fact-${fact.id}`} className={focusFactId === fact.id ? 'fact-focused' : ''} onFocus={() => onFocusFact?.(fact.id)}>
              <td className="matrix-fact"><div className="matrix-fact-content">
                <GrowingText value={fact.text} autoFocus={fresh === fact.id} placeholder="輸入秘密或資訊…" onChange={(text) => onChange({ facts: facts.map((item) => item.id === fact.id ? { ...item, text } : item) })} />
                <button type="button" className="matrix-del" aria-label={`刪除資訊 ${fact.text || '未命名資訊'}`} title="刪除這筆資訊" onClick={() => void deleteFact(fact)}>×</button>
              </div></td>
              {columns.map((who, index) => {
                const sceneId = fact.known[who] ?? '';
                return <td key={`${who}-${index}`} className="matrix-cell matrix-person-col">
                  <Select value={sceneId} ariaLabel={`${label(who)}在第幾場知道`} options={sceneOptions} onChange={(value) => setKnown(fact, who, value)} menuMinWidth={260} collapsibleGroups preview={(option) => option.value ? <ScenePreview project={project} sceneId={option.value} /> : null} />
                </td>;
              })}
              <td className="matrix-plus-cell" aria-hidden="true" />
              <td className="matrix-fill" aria-hidden="true" />
            </tr>
          })}
        </tbody>
      </table>
      <div className="matrix-add-row"><button className="button-ghost button-small" onClick={addFact}>＋ 新增資訊</button></div>
    </div>
  </div>;
}
