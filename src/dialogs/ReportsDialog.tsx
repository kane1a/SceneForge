import { useMemo } from 'react';
import { analyzeStory } from '../story-analysis';
import { downloadText, safeFileName } from '../download';
import type { Project } from '../types';

type ReportTab = 'scenes' | 'characters' | 'locations';

const parseHeading = (text: string) => {
  const match = /^\s*(INT\.?\/EXT\.?|INT\.?|EXT\.?|EST\.?|I\/E\.?|內外景|內景|外景|內|外)\s*(.*?)(?:\s+-\s+(.+))?$/iu.exec(text);
  return { ie: match?.[1] ?? '', place: (match?.[2] ?? text).trim(), time: match?.[3]?.trim() ?? '' };
};
const eighthsText = (value: number) => value ? `${Math.floor(value / 8) ? `${Math.floor(value / 8)} ` : ''}${value % 8 ? `${value % 8}/8` : ''}`.trim() : '—';

/** 工具 › 製作報表：場次表、角色、地點。目前分頁由 App 保存（關掉再開停在上次的分頁）。 */
export default function ReportsDialog({ project, sceneEighths, demo, tab, onTabChange, notify, onError, onClose }: {
  project: Project;
  sceneEighths: Record<string, number>;
  demo: boolean;
  tab: ReportTab;
  onTabChange: (tab: ReportTab) => void;
  notify: (text: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const reportRows = useMemo(() => {
    const analysis = analyzeStory(project);
    const scenes = analysis.scenes.filter((scene) => project.blocks.some((block) => block.id === scene.id && block.type === 'scene')).map((scene, index) => ({ number: index + 1, id: scene.id, heading: scene.title, ...parseHeading(scene.title), eighths: sceneEighths[scene.id] ?? 0, cast: scene.present }));
    const locations = new Map<string, { scenes: number[]; eighths: number }>();
    for (const scene of scenes) { const key = scene.place || '（未標示）'; const entry = locations.get(key) ?? { scenes: [], eighths: 0 }; entry.scenes.push(scene.number); entry.eighths += scene.eighths; locations.set(key, entry); }
    return { scenes, characters: analysis.characters, locations: [...locations].map(([place, entry]) => ({ place, ...entry })).sort((a, b) => b.scenes.length - a.scenes.length) };
  }, [project, sceneEighths]);
  const reportTable = (): string[][] => {
    if (tab === 'scenes') return [['場次', '內外', '地點', '時間', '長度（頁）', '角色'], ...reportRows.scenes.map((row) => [String(row.number), row.ie, row.place, row.time, eighthsText(row.eighths), row.cast.join('、')])];
    if (tab === 'characters') return [['角色', '台詞', '字數', '出場場次', '首次出現'], ...reportRows.characters.map((row) => [row.name, String(row.lines), String(row.words), String(row.scenes.length), Number.isFinite(row.firstScene) ? `第 ${row.firstScene + 1} 場` : '—'])];
    return [['地點', '場數', '場次', '總長度（頁）'], ...reportRows.locations.map((row) => [row.place, String(row.scenes.length), row.scenes.join(', '), eighthsText(row.eighths)])];
  };
  const exportReportCsv = () => {
    const csv = reportTable().map((row) => row.map((cell) => /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(',')).join('\n');
    downloadText(`${safeFileName(project.title ?? 'SceneForge')}-${tab === 'scenes' ? '場次表' : tab === 'characters' ? '角色報表' : '地點報表'}.csv`, `\ufeff${csv}\n`, 'text/csv;charset=utf-8');
  };
  const copyReport = async () => {
    try { await navigator.clipboard.writeText(reportTable().map((row) => row.join('\t')).join('\n')); notify('已複製，可直接貼到試算表'); } catch { onError('無法存取剪貼簿。'); }
  };
  const rows = reportTable();
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="app-dialog reports-dialog" role="dialog" aria-modal="true" aria-labelledby="reports-title">
      <header><div><p className="eyebrow">製作</p><h2 id="reports-title">製作報表</h2></div><button className="dialog-close" aria-label="關閉" onClick={onClose}>×</button></header>
      <div className="report-tabs" role="tablist" data-seg>
        {(['scenes', 'characters', 'locations'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => onTabChange(item)}>{item === 'scenes' ? '場次表' : item === 'characters' ? '角色' : '地點'}</button>)}
      </div>
      <div className="report-table-wrap"><table className="report-table" data-report-tab={tab}>{rows[0] && <colgroup>{rows[0].map((_, columnIndex) => <col key={columnIndex} />)}</colgroup>}<thead><tr>{rows[0]?.map((cell) => <th key={cell}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>
      <footer><span className="report-note">{demo ? '示範版的長度依畫面換行估算；電腦版以實際排版計算。' : '長度以目前紙張與字型實際排版，1/8 頁為單位。'}</span><button className="button-ghost" onClick={() => void copyReport()}>複製表格</button><button className="button-primary" onClick={exportReportCsv}>匯出 CSV</button></footer>
    </section>
  </div>;
}
