import { useEffect, type RefObject } from 'react';

export type GraphView = { x: number; y: number; k: number };

/** 圖譜畫布（心智圖、人物關係圖）共用：滾輪以游標為中心縮放。Ctrl＋滾輪保留給整體介面縮放。 */
export function useWheelZoom(svgRef: RefObject<SVGSVGElement | null>, setView: (update: (current: GraphView) => GraphView) => void, min: number, max: number) {
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = event.clientX - rect.left, py = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015));
      setView((current) => {
        const k = Math.min(max, Math.max(min, current.k * factor));
        if (k === current.k) return current;
        return { k, x: px - ((px - current.x) / current.k) * k, y: py - ((py - current.y) / current.k) * k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  });
}
