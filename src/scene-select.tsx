import type { ReactNode } from 'react';
import type { SelectOption } from './ui-controls';
import type { Block, Project } from './types';

type SceneLabel = (number: number) => string;

/** Build consistently grouped scene options for every scene picker. */
export function buildSceneSelectOptions(
  blocks: Block[],
  noneLabel: string,
  sceneLabel: SceneLabel = (number) => `第 ${number} 場`,
): SelectOption<string>[] {
  const options: SelectOption<string>[] = [{ value: '', label: noneLabel }];
  let act = '開場';
  let groupKey = 'opening';
  let sceneNumber = 0;
  for (const block of blocks) {
    if (block.type === 'act') {
      act = block.text.trim() || '未命名幕';
      groupKey = `act:${block.id}`;
      continue;
    }
    if (block.type !== 'scene') continue;
    sceneNumber += 1;
    options.push({
      value: block.id,
      label: sceneLabel(sceneNumber),
      hint: block.text.trim() || '未命名場景',
      group: act,
      groupKey,
    });
  }
  return options;
}

type PreviewBlock = { type: Block['type']; text: string };

function getScenePreview(project: Project, sceneId: string) {
  const start = project.blocks.findIndex((block) => block.id === sceneId && block.type === 'scene');
  if (start < 0) return null;
  const number = project.blocks.slice(0, start + 1).filter((block) => block.type === 'scene').length;
  const heading = project.blocks[start].text.trim() || '未命名場景';
  const blocks: PreviewBlock[] = [];
  for (let index = start + 1; index < project.blocks.length && blocks.length < 80; index += 1) {
    const block = project.blocks[index];
    if (block.type === 'scene' || block.type === 'act') break;
    if (block.type === 'note' || !block.text.trim()) continue;
    blocks.push({ type: block.type, text: block.text.trim() });
  }
  return { number, heading, blocks, summary: project.sceneMeta?.[sceneId]?.summary?.trim() ?? '' };
}

/** 預覽與劇本頁使用同一套模板：台式（角色：台詞）或美式（角色置中、台詞縮排）。 */
const isTaiwanFormat = () => typeof document !== 'undefined' && !!document.querySelector('.app-shell.format-taiwan-work');

/** Delayed scene preview for Select popovers, laid out like the script template in use. */
export function ScenePreview({ project, sceneId }: { project: Project; sceneId: string }): ReactNode {
  const scene = getScenePreview(project, sceneId);
  if (!scene) return null;
  const taiwan = isTaiwanFormat();
  const rows: ReactNode[] = [];
  for (let index = 0; index < scene.blocks.length; index += 1) {
    const block = scene.blocks[index];
    if (taiwan && block.type === 'character') {
      // 台式：角色名與後面的（動作提示）、台詞同一行。
      let paren = '';
      let line = '';
      let next = index + 1;
      if (scene.blocks[next]?.type === 'parenthetical') { paren = scene.blocks[next].text; next += 1; }
      if (scene.blocks[next]?.type === 'dialogue') { line = scene.blocks[next].text; next += 1; }
      rows.push(<p key={index} className="pv-tw-line"><span className="pv-tw-cue">{block.text}：</span>{paren && <span className="pv-paren">{paren}</span>}{line}</p>);
      index = next - 1;
      continue;
    }
    rows.push(<p key={index} className={`pv-${block.type}`}>{block.text}</p>);
  }
  return <article className={`sf-scene-preview ${taiwan ? 'pv-taiwan' : 'pv-us'}`} aria-label={`${scene.heading} 場景預覽`}>
    <h3 className="pv-scene">{taiwan ? `${scene.number}. ${scene.heading}` : <><span>{scene.heading}</span><span className="pv-num">{scene.number}</span></>}</h3>
    {scene.summary && <p className="sf-scene-preview-summary">{scene.summary}</p>}
    <div className="sf-scene-preview-script" aria-label="劇本內容">
      {rows.length ? rows : <p className="sf-scene-preview-empty">目前沒有劇本段落</p>}
    </div>
  </article>;
}
