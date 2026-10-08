import { memo, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react';
import { offsetAtPoint } from './caret';
import { fitTextareaToContent } from './editor-layout';
import { avatarStyle } from './avatar';
import { acceptSceneCompletion, getSceneCompletion } from './scene-completion';
import { BLOCK_LABELS } from './config';
import type { Block, BlockType, CharacterProfile, ScriptComment } from './types';
import type { PageStart } from './api';

/** Everything a script paragraph needs from the app. Read through a ref so the paragraph can stay memoised. */
export interface ScriptBlockHandlers {
  setParagraphMenu: (menu: { x: number; y: number; blockId: string; selectedText: string; hasSelection: boolean; mode: 'root'; draft: string }) => void;
  setCommentFor: (blockId: string | null) => void;
  setCommentDraft: (text: string) => void;
  setActiveEditorId: (blockId: string) => void;
  setCaretAtEnd: (atEnd: boolean) => void;
  setDismissedSceneSuggestion: (blockId: string) => void;
  handleEditorBlur: (event: FocusEvent<HTMLTextAreaElement>, block: Block) => void;
  handleEditorKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>, block: Block) => void;
  changeBlockText: (blockId: string, text: string) => void;
  characterCandidates: (block: Block) => string[];
  characterCompletion: (block: Block) => string;
  acceptPick: (block: Block, text: string) => void;
  updateComment: (commentId: string, change: Partial<ScriptComment> | null) => void;
  addComment: (blockId: string) => void;
}

export interface ScriptBlockProps {
  block: Block;
  index: number;
  handlers: MutableRefObject<ScriptBlockHandlers>;
  sceneStyle: 'taiwan' | 'hollywood';
  emptyHints: Record<BlockType, string>;
  locked: boolean;
  /** Only meaningful for the active paragraph; other paragraphs receive neutral values so they do not re-render. */
  isActive: boolean;
  caretAtEnd: boolean;
  suggestionDismissed: boolean;
  suggestionIndex: number;
  sceneLocations: string[];
  isContinuationCue: boolean;
  pageStart: PageStart | undefined;
  comments: ScriptComment[];
  setupCount: number;
  payoffCount: number;
  revised: boolean;
  commentOpen: boolean;
  commentDraft: string;
  findRects: { left: number; top: number; width: number; height: number }[] | null;
  bible: Record<string, CharacterProfile> | undefined;
}

function ScriptBlockView({ block, index, handlers, sceneStyle, emptyHints, locked, isActive, caretAtEnd, suggestionDismissed, suggestionIndex, sceneLocations, isContinuationCue, pageStart, comments, setupCount, payoffCount, revised, commentOpen, commentDraft, findRects, bible }: ScriptBlockProps) {
  const h = handlers.current;
  const suggesting = isActive && caretAtEnd && !suggestionDismissed;
  const completion = block.type === 'scene' && suggesting ? getSceneCompletion(block.text, sceneLocations, suggestionIndex, sceneStyle) : null;
  const completionCandidate = completion?.stage ? completion.candidates[completion.candidateIndex] ?? completion.candidates[0] ?? '' : '';
  const completionText = completionCandidate ? acceptSceneCompletion(block.text, completionCandidate, sceneStyle).text : '';
  const completionExtends = completionText.startsWith(block.text);
  const completionGhost = completionExtends ? completionText.slice(block.text.length) : completionText;
  const cueGhost = block.type === 'character' && suggesting ? h.characterCompletion(block) : '';
  const cueSuffix = sceneStyle === 'taiwan' ? '（續）' : " (CONT'D)";
  const openComments = comments.filter((comment) => !comment.resolved).length;
  return <>
    {pageStart && <div className="page-break" aria-hidden="true"><span>第 {pageStart.page} 頁{pageStart.continued ? '（本段由上頁延續）' : ''}</span></div>}
    <article className={`script-block block-${block.type}${isActive ? ' is-active' : ''}${revised ? ' revised' : ''}`} id={`block-${block.id}`} data-block-id={block.id} data-block-type={block.type} data-label={BLOCK_LABELS[block.type]}
      onContextMenu={(event) => { event.preventDefault(); const editor = document.getElementById(`editor-${block.id}`) as HTMLTextAreaElement | null; const rawSelection = editor && editor.selectionEnd > editor.selectionStart ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : ''; const selectedText = rawSelection.trim(); handlers.current.setParagraphMenu({ x: event.clientX, y: event.clientY, blockId: block.id, selectedText, hasSelection: !!selectedText, mode: 'root', draft: selectedText || block.text }); handlers.current.setCommentFor(null); }}
      onMouseDown={(event) => {
        // The whole line is clickable, not just the (often narrow, indented) text box.
        const target = event.target as HTMLElement;
        if (target.closest('textarea, button, .pick-list, .element-menu, .script-context-menu')) return;
        const editor = document.getElementById(`editor-${block.id}`) as HTMLTextAreaElement | null;
        if (!editor) return;
        event.preventDefault();
        const offset = offsetAtPoint(editor, event.clientX, event.clientY);
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(offset, offset);
      }}>
      <div className={`script-editor-wrap ${block.type === 'scene' ? 'scene-editor-wrap' : ''}`}>
        <textarea
          id={`editor-${block.id}`}
          className={`script-editor ${block.type === 'scene' ? 'scene-editor' : ''} ${completion?.stage && completion.ghost && !completionExtends ? 'scene-editor-replacing' : ''}`}
          data-block-id={block.id}
          data-block-type={block.type}
          spellCheck={false}
          readOnly={locked}
          rows={1}
          value={block.text}
          placeholder={block.type === 'scene' ? (completion?.ghost ? '' : sceneStyle === 'taiwan' ? '內景／外景　場景　時間' : emptyHints.scene) : emptyHints[block.type]}
          aria-label={`${BLOCK_LABELS[block.type]}第 ${index + 1} 段`}
          onFocus={(event) => { handlers.current.setActiveEditorId(block.id); handlers.current.setCaretAtEnd(event.currentTarget.selectionStart === event.currentTarget.value.length); handlers.current.setDismissedSceneSuggestion(''); }}
          onBlur={(event) => { handlers.current.handleEditorBlur(event, block); handlers.current.setCaretAtEnd(false); }}
          onSelect={(event) => handlers.current.setCaretAtEnd(event.currentTarget.selectionStart === event.currentTarget.value.length && event.currentTarget.selectionEnd === event.currentTarget.value.length)}
          onChange={(event) => { handlers.current.setCaretAtEnd(event.currentTarget.selectionStart === event.currentTarget.value.length); handlers.current.changeBlockText(block.id, event.target.value); fitTextareaToContent(event.currentTarget); }}
          onKeyDown={(event) => handlers.current.handleEditorKeyDown(event, block)}
        />
        {cueGhost && <span className="cue-inline-completion" aria-hidden="true">{cueGhost}</span>}
        {isContinuationCue && <span className="cue-contd-display" aria-hidden="true">{cueSuffix}</span>}
        {block.type === 'character' && suggesting && (() => {
          const list = h.characterCandidates(block);
          if (!list.length) return null;
          const active = suggestionIndex % list.length;
          return <ul className="pick-list pick-cue" role="listbox" aria-label="角色名" onMouseDown={(event) => event.preventDefault()}>
            {list.map((name, nameIndex) => <li key={name} role="option" aria-selected={nameIndex === active} className={nameIndex === active ? 'active' : ''} onClick={() => handlers.current.acceptPick(block, name)}><span className="pick-avatar" style={avatarStyle(name, bible?.[name])}>{Array.from(name)[0]}</span>{name}</li>)}
          </ul>;
        })()}
        {completion?.stage && completion.candidates.length > 0 && <ul className="pick-list" role="listbox" aria-label={completion.stage === 'interior-exterior' ? '內外景' : completion.stage === 'location' ? '地點' : '時間'} onMouseDown={(event) => event.preventDefault()}>
          <li className="pick-head">{completion.stage === 'interior-exterior' ? '內／外景' : completion.stage === 'location' ? '地點' : '日／夜'}</li>
          {completion.candidates.map((candidate, candidateIndex) => <li key={candidate} role="option" aria-selected={candidateIndex === completion.candidateIndex} className={candidateIndex === completion.candidateIndex ? 'active' : ''} onClick={() => handlers.current.acceptPick(block, acceptSceneCompletion(block.text, candidate, sceneStyle).text)}>{candidate}</li>)}
        </ul>}
        
        {completion?.stage && completion.ghost && completionGhost && <span className="scene-ghost" aria-hidden="true"><span className="scene-ghost-prefix">{completionExtends ? block.text : ''}</span><span className="scene-ghost-suffix">{completionGhost}</span></span>}
        {findRects && findRects.map((rect, rectIndex) => <span key={rectIndex} className="find-mark" aria-hidden="true" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}
      </div>
      {setupCount + payoffCount > 0 && <span className="script-story-marker" aria-label={`伏筆標記：鋪陳 ${setupCount}、回收 ${payoffCount}`} title={`鋪陳 ${setupCount} 個・回收 ${payoffCount} 個`}>{setupCount > 0 && <i>鋪</i>}{payoffCount > 0 && <i>收</i>}</span>}
      {revised && <span className="revision-mark" aria-label="修訂過的段落">*</span>}
      {(comments.length > 0 || isActive) && <button type="button" className={`comment-pin${openComments ? ' has' : ''}`} aria-label={`註解（${openComments}）`} title="註解" onMouseDown={(event) => event.preventDefault()} onClick={() => { handlers.current.setCommentFor(commentOpen ? null : block.id); handlers.current.setCommentDraft(''); }}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12v8.5H9l-3.5 3v-3H4z" /></svg>{openComments > 0 && <span>{openComments}</span>}
      </button>}
      {commentOpen && <div className="comment-pop" onMouseDown={(event) => event.stopPropagation()}>
        {comments.map((comment) => <div key={comment.id} className={`comment-item${comment.resolved ? ' resolved' : ''}`}>
          <p>{comment.text}</p>
          <footer><time>{new Date(comment.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
            <button className="text-button" onClick={() => handlers.current.updateComment(comment.id, { resolved: !comment.resolved })}>{comment.resolved ? '重新開啟' : '已解決'}</button>
            <button className="text-button danger-text" onClick={() => handlers.current.updateComment(comment.id, null)}>刪除</button></footer>
        </div>)}
        <textarea autoFocus value={commentDraft} rows={2} placeholder="寫下註解…（不會列印）" onChange={(event) => handlers.current.setCommentDraft(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) handlers.current.addComment(block.id); if (event.key === 'Escape') handlers.current.setCommentFor(null); }} />
        <div className="comment-actions"><button className="text-button" onClick={() => handlers.current.setCommentFor(null)}>關閉</button><button className="button-primary button-small" disabled={!commentDraft.trim()} onClick={() => handlers.current.addComment(block.id)}>新增註解</button></div>
      </div>}

    </article>
  </>;
}

/** One script paragraph. Memoised so typing in one paragraph does not re-render the other thousands. */
export const ScriptBlock = memo(ScriptBlockView);
