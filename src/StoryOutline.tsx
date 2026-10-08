import { useLayoutEffect, useRef } from 'react';
import type { Project } from './types';

export default function StoryOutline({ project, onChange }: {
  project: Project;
  onChange: (outline: NonNullable<Project['storyOutline']>) => void;
}) {
  const outline = project.storyOutline ?? {};
  const synopsisRef = useRef<HTMLTextAreaElement>(null);
  const update = (field: 'logline' | 'synopsis' | 'core', value: string) => onChange({ ...outline, [field]: value });

  useLayoutEffect(() => {
    const textarea = synopsisRef.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(textarea.parentElement ?? textarea);
    return () => observer.disconnect();
  }, [outline.synopsis]);

  return <section className="board-page story-outline-page">
    <header className="board-page-header">
      <div>
        <h2 className="story-page-title">故事大綱</h2>
        <p className="story-page-subtitle">用三個欄位整理故事方向，分幕與場次可在分場大綱編寫。</p>
      </div>
    </header>
    <div className="story-outline-fields">
      <label>
        <span>一句話故事</span>
        <small>誰，想要什麼，被什麼阻擋？</small>
        <input aria-label="一句話故事" value={outline.logline ?? ''} onChange={(event) => update('logline', event.target.value)} />
      </label>
      <label>
        <span>故事大綱</span>
        <small>簡單寫下故事如何開始、發展與結束。</small>
        <textarea ref={synopsisRef} aria-label="故事大綱" rows={1} value={outline.synopsis ?? ''} onChange={(event) => update('synopsis', event.target.value)} />
      </label>
      <label>
        <span>故事核心</span>
        <small>這個故事最後想說的事。</small>
        <input aria-label="故事核心" value={outline.core ?? ''} onChange={(event) => update('core', event.target.value)} />
      </label>
    </div>
  </section>;
}
