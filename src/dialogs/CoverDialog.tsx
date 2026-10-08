import { Switch } from '../ui-controls';
import type { Project, TitlePage } from '../types';

/** 檔案 › 封面設定。所有欄位直接寫回劇本（可復原）。 */
export default function CoverDialog({ project, onChange, onClose }: {
  project: Project;
  onChange: (change: Partial<TitlePage>) => void;
  onClose: () => void;
}) {
  const page = project.titlePage;
  return <div className="dialog-backdrop cover-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cover-editor" role="dialog" aria-modal="true" aria-label="封面設定">
      <div className="cover-sheet">
        <input className="ce-title" value={page?.title ?? project.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="劇名" aria-label="劇名" />
        <input className="ce-sub" value={page?.subtitle ?? ''} onChange={(event) => onChange({ subtitle: event.target.value })} placeholder="副標題／集數（選填）" aria-label="副標題或集數" />
        <div className="ce-by"><span>編劇</span><input value={page?.author ?? ''} onChange={(event) => onChange({ author: event.target.value })} placeholder="作者姓名" aria-label="作者" /></div>
        <input className="ce-based" value={page?.basedOn ?? ''} onChange={(event) => onChange({ basedOn: event.target.value })} placeholder="改編自／原著（選填）" aria-label="改編自" />
        <div className="ce-foot">
          <textarea value={page?.contact ?? ''} onChange={(event) => onChange({ contact: event.target.value })} placeholder={'聯絡方式\n電話、Email、經紀人'} aria-label="聯絡方式" rows={3} />
          <div><input value={page?.draft ?? ''} onChange={(event) => onChange({ draft: event.target.value })} placeholder="版本，如：第二稿" aria-label="版本" /><input value={page?.date ?? ''} onChange={(event) => onChange({ date: event.target.value })} placeholder="日期" aria-label="日期" /></div>
        </div>
      </div>
      <aside className="cover-side">
        <p className="eyebrow">封面</p>
        <h2>劇本封面</h2>
        <p className="dialog-copy">封面獨立於劇本內文：開啟劇本時直接從上次寫到的地方繼續，只有列印／匯出 PDF 與 Fountain 時才會放在第一頁。</p>
        <Switch className="studio-switch" checked={page?.print !== false} onChange={(next) => onChange({ print: next })} label="列印與匯出時包含封面" />
        <label className="dialog-field">備註（不列印）<textarea value={page?.notes ?? ''} onChange={(event) => onChange({ notes: event.target.value })} rows={3} /></label>
        <button className="button-primary" onClick={onClose}>完成</button>
      </aside>
    </section>
  </div>;
}
