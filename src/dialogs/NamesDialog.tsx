import { useEffect, useState } from 'react';
import { generateNames, NAME_STYLES, type NameGender, type NameStyle } from '../names';

export type NameOptions = { surname: string; gender: NameGender; style: NameStyle };

/** 編輯 › 人名產生器。選項由 App 保存（關掉再開仍保留上次的姓氏、性別、風格）。 */
export default function NamesDialog({ options, onOptionsChange, exclude, onPick, fillsCue, onClose }: {
  options: NameOptions;
  onOptionsChange: (options: NameOptions) => void;
  exclude: () => Set<string>;
  onPick: (name: string) => void;
  fillsCue: boolean;
  onClose: () => void;
}) {
  const [nameList, setNameList] = useState<string[]>([]);
  const rollNames = (next = options) => setNameList(generateNames({ ...next, count: 18, exclude: exclude() }));
  useEffect(() => { rollNames(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (next: NameOptions) => { onOptionsChange(next); rollNames(next); };
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="app-dialog names-dialog" role="dialog" aria-modal="true" aria-labelledby="names-title">
      <header><div><p className="eyebrow">角色命名</p><h2 id="names-title">人名產生器</h2></div><button className="dialog-close" aria-label="關閉" onClick={onClose}>×</button></header>
      <div className="names-controls">
        <label>姓氏<input value={options.surname} maxLength={2} placeholder="隨機" onChange={(event) => onOptionsChange({ ...options, surname: event.target.value })} /></label>
        <div className="seg-chips" role="radiogroup" aria-label="性別">{([['any', '不限'], ['male', '男'], ['female', '女']] as const).map(([value, label]) => <button key={value} role="radio" aria-checked={options.gender === value} className={options.gender === value ? 'active' : ''} onClick={() => choose({ ...options, gender: value })}>{label}</button>)}</div>
        <div className="seg-chips" role="radiogroup" aria-label="風格">{NAME_STYLES.map(({ id: value, label }) => <button key={value} role="radio" aria-checked={options.style === value} className={options.style === value ? 'active' : ''} onClick={() => choose({ ...options, style: value })}>{label}</button>)}</div>
        <button className="button-primary button-small" onClick={() => rollNames()}>換一批</button>
      </div>
      <div className="names-grid">{nameList.map((name) => <button key={name} onClick={() => onPick(name)}>{name}</button>)}</div>
      <p className="dialog-copy">{fillsCue ? '點一下名字，直接填入目前的角色行。' : '點一下名字即可複製；若游標在角色行，會直接填入。'}已在劇本中的角色名不會重複出現。</p>
    </section>
  </div>;
}
