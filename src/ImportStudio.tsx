import { useEffect, useMemo, useRef, useState } from 'react';
import { BLOCK_LABELS, BLOCK_ORDER } from './config';
import { EMPTY_MEMORY, learnFromCorrection, smartImport, speakerKey, type ImportMemory, type SmartBlock, type SmartImportResult } from './smart-import';
import type { Block, BlockType } from './types';
import { Switch } from './ui-controls';

export interface ImportSource {
  fileName: string;
  kind: string;
  encoding?: string;
  text: string;
  /** Already-structured blocks (Final Draft); skips text analysis. */
  blocks?: Block[];
}

export interface ImportConfirm {
  title: string;
  blocks: Block[];
  characters: string[];
  createEntities: boolean;
  result: SmartImportResult;
  /** Add to the script that is open (at the cursor), or start a new script. */
  target: 'current' | 'new';
  /** For a new script: its format and type (fixed once created). */
  preset: 'taiwan-work' | 'us-screenplay';
}

interface Props {
  source: ImportSource;
  memory: ImportMemory;
  busy: boolean;
  onMemoryChange: (memory: ImportMemory) => void;
  onConfirm: (value: ImportConfirm) => void;
  onClose: () => void;
  /** Title of the open script, if any — importing into it becomes the default. */
  currentTitle?: string;
}

function structuredResult(blocks: Block[]): SmartImportResult {
  const smart: SmartBlock[] = blocks.map((block, index) => ({ ...block, confidence: 'high', reason: 'Final Draft 原生元素', line: index + 1, key: `${index + 1}:0`, source: block.text }));
  const counts = new Map<string, number>();
  smart.forEach((block, index) => {
    if (block.type === 'character' && smart[index + 1]?.type !== 'character') counts.set(speakerKey(block.text), (counts.get(speakerKey(block.text)) ?? 0) + 1);
  });
  return {
    blocks: smart, metadata: {}, format: 'Final Draft',
    characters: [...counts].map(([name, lines]) => ({ name, lines })).sort((a, b) => b.lines - a.lines),
    stats: { scenes: smart.filter((b) => b.type === 'scene').length, characters: counts.size, dialogues: smart.filter((b) => b.type === 'dialogue').length, lowConfidence: 0, sourceLines: smart.length },
  };
}

export default function ImportStudio({ source, memory, busy, onMemoryChange, onConfirm, onClose, currentTitle }: Props) {
  const [text, setText] = useState(source.text);
  const [overrides, setOverrides] = useState<Record<string, BlockType>>({});
  const [structured, setStructured] = useState<Block[] | undefined>(source.blocks);
  const [picker, setPicker] = useState<string | null>(null);
  const [onlyReview, setOnlyReview] = useState(false);
  const [createEntities, setCreateEntities] = useState(true);
  const [teach, setTeach] = useState('');
  const [flash, setFlash] = useState('');
  const [showSource, setShowSource] = useState(false);
  // Paragraphs the writer struck out of the preview (headers, page numbers, notes to self…).
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [target, setTarget] = useState<'current' | 'new'>(currentTitle ? 'current' : 'new');
  const [preset, setPreset] = useState<'taiwan-work' | 'us-screenplay'>(/Final Draft|Fountain/i.test(source.kind) ? 'us-screenplay' : 'taiwan-work');
  const flashTimer = useRef(0);

  const result = useMemo(() => structured ? structuredResult(structured) : smartImport(text, memory, overrides), [structured, text, memory, overrides]);
  const defaultTitle = result.metadata.title ?? result.metadata['劇名'] ?? result.metadata['剧名'] ?? result.metadata.Title ?? source.fileName.replace(/\.[^.]+$/, '');
  const [title, setTitle] = useState(defaultTitle);
  const titleTouched = useRef(false);
  useEffect(() => { if (!titleTouched.current) setTitle(defaultTitle || '匯入劇本'); }, [defaultTitle]);

  const notify = (message: string) => {
    setFlash(message);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(''), 2600);
  };

  const correct = (block: SmartBlock, type: BlockType) => {
    setPicker(null);
    if (type === block.type) return;
    if (structured) {
      setStructured((items) => items?.map((item) => item.id === block.id ? { ...item, type } : item));
      return;
    }
    const next = learnFromCorrection(memory, block, type);
    setOverrides((items) => ({ ...items, [block.key]: type }));
    onMemoryChange(next);
    const after = smartImport(text, next, { ...overrides, [block.key]: type });
    const changed = after.blocks.filter((item, index) => result.blocks[index] && item.type !== result.blocks[index].type).length;
    notify(changed > 1 ? `已學會，並同步修正了 ${changed} 處相似段落` : '已學會這個分類');
  };

  const teachCharacter = (event: React.FormEvent) => {
    event.preventDefault();
    const name = speakerKey(teach);
    if (!name) return;
    onMemoryChange({ ...memory, characters: [...new Set([...memory.characters, name])], notCharacters: memory.notCharacters.filter((item) => item !== name), corrections: memory.corrections + 1 });
    setTeach('');
    notify(`已記住角色「${name}」`);
  };

  const forgetCharacter = (name: string) => {
    onMemoryChange({ ...memory, characters: memory.characters.filter((item) => item !== name), notCharacters: [...new Set([...memory.notCharacters, name])], corrections: memory.corrections + 1 });
    notify(`「${name}」不再視為角色`);
  };

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (picker) setPicker(null); else if (!busy) onClose(); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [picker, busy, onClose]);

  // Remember each paragraph's type so a correction (and everything it re-teaches) visibly flashes.
  const previousTypes = useRef(new Map<string, BlockType>());
  const changedKeys = new Set(result.blocks.filter((block) => { const before = previousTypes.current.get(block.key); return before !== undefined && before !== block.type; }).map((block) => block.key));
  useEffect(() => { previousTypes.current = new Map(result.blocks.map((block) => [block.key, block.type])); }, [result]);

  const kept = result.blocks.filter((block) => !removed.has(block.key));
  const visible = (onlyReview ? kept.filter((block) => block.confidence !== 'high') : kept);
  const empty = !structured && !text.trim();
  const remove = (block: SmartBlock) => { setPicker(null); setRemoved((items) => new Set(items).add(block.key)); };
  const confirm = () => onConfirm({
    title: title.trim() || '匯入劇本',
    target,
    preset,
    blocks: kept.map(({ id, type, text: value }) => ({ id, type, text: value })),
    characters: result.characters.map((item) => item.name),
    createEntities,
    result,
  });

  return <div className="studio-backdrop" role="presentation">
    <section className="studio" role="dialog" aria-modal="true" aria-labelledby="studio-title">
      <header className="studio-head">
        <div className="studio-head-main">
          <p className="eyebrow">智慧匯入 · 會學習的轉換</p>
          <h2 id="studio-title">{empty ? '貼上或丟入任何文字' : source.fileName || '貼上的文字'}</h2>
          {!empty && <div className="studio-chips">
            <span className="chip chip-gold">辨識為 {result.format}</span>
            <span className="chip">{source.kind}{source.encoding && source.encoding !== 'UTF-8' ? ` · ${source.encoding}` : ''}</span>
            {memory.corrections > 0 && <span className="chip">已累積 {memory.corrections} 次學習</span>}
          </div>}
        </div>
        <button className="dialog-close" aria-label="關閉" disabled={busy} onClick={onClose}>×</button>
      </header>

      {empty ? <div className="studio-paste">
        <textarea autoFocus placeholder={'把劇本、大綱或筆記貼在這裡。\n\n例如：\n1. 內景　咖啡館　日\n小雨推門進來。\n小雨：（喘氣）我遲到了嗎？\n\nSceneForge 會辨識場景、角色、對白與動作。'} value={text} onChange={(event) => setText(event.target.value)} />
      </div> : <div className="studio-body">
        <div className="studio-preview">
          <div className="studio-stats">
            <div><strong>{result.stats.scenes}</strong><span>場景</span></div>
            <div><strong>{result.stats.characters}</strong><span>角色</span></div>
            <div><strong>{result.stats.dialogues}</strong><span>句對白</span></div>
            <div className={result.stats.lowConfidence ? 'attention' : ''}><strong>{result.blocks.filter((block) => block.confidence !== 'high').length}</strong><span>待確認</span></div>
            <Switch checked={onlyReview} onChange={setOnlyReview} label="只看待確認" />
            {removed.size > 0 && <button className="text-button studio-restore" onClick={() => setRemoved(new Set())}>已刪除 {removed.size} 段 · 全部還原</button>}
          </div>
          <div className="studio-page">
            {visible.length === 0 && <p className="studio-none">{onlyReview ? '全部段落都已高信心辨識。' : '沒有可辨識的內容。'}</p>}
            {visible.map((block) => <div key={`${block.key}-${block.type}`} className={`studio-block sb-${block.type} conf-${block.confidence}${changedKeys.has(block.key) ? ' changed' : ''}`} title={`第 ${block.line} 行 · ${block.reason}`}>
              <button className="sb-type" aria-haspopup="menu" aria-expanded={picker === block.id} onClick={() => setPicker(picker === block.id ? null : block.id)}>{BLOCK_LABELS[block.type]}</button>
              <p>{block.text}</p>
              <button className="sb-remove" aria-label="刪除這一段" title="不要匯入這一段" onClick={() => remove(block)}>×</button>
              {block.confidence !== 'high' && <span className="sb-reason">{block.reason}</span>}
              {picker === block.id && <div className="sb-picker" role="menu">
                {BLOCK_ORDER.map((type) => <button key={type} role="menuitemradio" aria-checked={type === block.type} onClick={() => correct(block, type)}>{BLOCK_LABELS[type]}</button>)}
                <p>修正後會記住規則，相似段落一起更新。</p>
              </div>}
            </div>)}
          </div>
        </div>
        <aside className="studio-side">
          {currentTitle && <div className="studio-target" role="radiogroup" aria-label="匯入到">
            <button role="radio" aria-checked={target === 'current'} className={target === 'current' ? 'active' : ''} onClick={() => setTarget('current')}><strong>加到目前劇本</strong><small>插入在「{currentTitle}」的游標處</small></button>
            <button role="radio" aria-checked={target === 'new'} className={target === 'new' ? 'active' : ''} onClick={() => setTarget('new')}><strong>建立新劇本</strong><small>另開一份</small></button>
          </div>}
          {target === 'new' && <>
            <label className="studio-field">劇本名稱<input value={title} maxLength={100} onChange={(event) => { titleTouched.current = true; setTitle(event.target.value); }} /></label>
            <div className="studio-field"><span>格式</span>
              <div className="seg-chips" role="radiogroup" aria-label="格式">{([['taiwan-work', '台式劇本'], ['us-screenplay', '美式劇本']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={preset === value} className={preset === value ? 'active' : ''} onClick={() => setPreset(value)}>{label}</button>)}</div>
            </div>
          </>}
          <section>
            <h3>辨識出的角色</h3>
            {result.characters.length === 0 ? <p className="studio-muted">尚未發現角色。可在下方直接教我。</p> : <ul className="cast-list">
              {result.characters.slice(0, 40).map((item) => <li key={item.name}><span className="cast-avatar">{Array.from(item.name)[0]}</span><span className="cast-name">{item.name}</span><span className="cast-count">{item.lines}</span>{!structured && <button aria-label={`${item.name} 不是角色`} title="不是角色" onClick={() => forgetCharacter(item.name)}>×</button>}</li>)}
            </ul>}
            {!structured && <form className="teach" onSubmit={teachCharacter}><input value={teach} onChange={(event) => setTeach(event.target.value)} placeholder="教我一個角色名…" aria-label="新增角色名稱" /><button type="submit" className="button-ghost">記住</button></form>}
          </section>
          {!structured && <section>
            <h3>學習記憶 <span className="studio-muted">跨檔案保留</span></h3>
            {memory.rules.length === 0 && memory.notCharacters.length === 0 ? <p className="studio-muted studio-help"><span>點左側標籤修正分類。</span><span>修正會記住並套用到後續檔案。</span></p> : <ul className="rule-list">
              {memory.rules.map((rule) => <li key={rule.prefix}><code>{rule.prefix}</code><span>→ {BLOCK_LABELS[rule.type]}</span><button aria-label="刪除規則" onClick={() => onMemoryChange({ ...memory, rules: memory.rules.filter((item) => item.prefix !== rule.prefix) })}>×</button></li>)}
              {memory.notCharacters.slice(-12).map((name) => <li key={`not-${name}`}><code>{name}</code><span>不是角色</span><button aria-label="刪除規則" onClick={() => onMemoryChange({ ...memory, notCharacters: memory.notCharacters.filter((item) => item !== name) })}>×</button></li>)}
            </ul>}
            {memory !== EMPTY_MEMORY && memory.corrections > 0 && <button className="text-button" onClick={() => onMemoryChange({ ...EMPTY_MEMORY })}>清除全部學習記憶</button>}
          </section>}
          <Switch className="studio-switch" checked={createEntities} onChange={setCreateEntities} label="同時建立角色資料（供人物關係圖使用）" />
          {!structured && <details className="studio-source" open={showSource} onToggle={(event) => setShowSource((event.target as HTMLDetailsElement).open)}>
            <summary>原始文字（可直接修改）</summary>
            <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
          </details>}
        </aside>
      </div>}

      <footer className="studio-foot">
        <span className="studio-flash" role="status">{flash}</span>
        <button className="text-button" disabled={busy} onClick={onClose}>取消</button>
        <button className="button-primary" disabled={busy || empty || kept.length === 0} onClick={confirm}>{busy ? '正在匯入…' : target === 'current' ? `加入目前劇本 · ${kept.length} 段` : `建立劇本 · ${kept.length} 段`}</button>
      </footer>
    </section>
  </div>;
}
