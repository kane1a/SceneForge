export function fitTextareaToContent(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/** Batched: reset every height, read every scrollHeight, then write — two reflows instead of one per textarea. */
export function fitTextareasIn(container: ParentNode): void {
  const areas = Array.from(container.querySelectorAll<HTMLTextAreaElement>('textarea'));
  for (const area of areas) area.style.height = 'auto';
  const heights = areas.map((area) => area.scrollHeight);
  areas.forEach((area, index) => { area.style.height = `${heights[index]}px`; });
}

export function observeTextareasOnWidthChange(container: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  let previousWidth = container.getBoundingClientRect().width;
  let frame = 0;
  const observer = new ResizeObserver((entries) => {
    const width = entries.at(-1)?.contentRect.width;
    if (width === undefined || width < 0.5 || Math.abs(width - previousWidth) < 0.5) return;
    previousWidth = width;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      fitTextareasIn(container);
    });
  });
  observer.observe(container);
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
