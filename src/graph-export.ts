/** 圖譜匯出：一律輸出完整圖面（不受目前縮放、平移影響）的 PNG。 */

const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'paint-order', 'font-style', 'stroke-opacity', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'opacity', 'filter', 'visibility', 'display'];
const MAX_SIDE = 8000; // 瀏覽器畫布安全上限
const PADDING = 40;

/** 複製 SVG、把計算後樣式寫死、去掉檢視變換，視框包住全部內容。 */
function buildFullSvg(svg: SVGSVGElement, rootVars: string[]): { clone: SVGSVGElement; width: number; height: number } | null {
  const content = svg.querySelector(':scope > g') as SVGGElement | null;
  if (!content) return null;
  const box = content.getBBox();
  if (!box.width || !box.height) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const source = [...svg.querySelectorAll('*')];
  const target = [...clone.querySelectorAll('*')];
  for (let index = 0; index < Math.min(source.length, target.length); index += 1) {
    const from = source[index], to = target[index];
    if (!(from instanceof SVGElement) || !(to instanceof SVGElement)) continue;
    const computed = getComputedStyle(from);
    to.setAttribute('style', `${from.getAttribute('style') ?? ''};${STYLE_PROPS.map((p) => `${p}:${computed.getPropertyValue(p)}`).join(';')}`);
    to.removeAttribute('class');
  }
  clone.querySelectorAll('foreignObject').forEach((node) => node.remove());
  const contentClone = clone.querySelector(':scope > g');
  contentClone?.removeAttribute('transform');
  const x = box.x - PADDING, y = box.y - PADDING;
  const width = Math.ceil(box.width + PADDING * 2), height = Math.ceil(box.height + PADDING * 2);
  const root = getComputedStyle(document.documentElement);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('style', rootVars.map((name) => `${name}:${root.getPropertyValue(name)}`).join(';'));
  return { clone, width, height };
}

export async function exportGraphPng(svg: SVGSVGElement | null, filename: string, rootVars: string[]) {
  if (!svg) return;
  const built = buildFullSvg(svg, rootVars);
  if (!built) return;
  // 高解析度：一般 2 倍，圖很大時降到不超過畫布上限，保證整張都輸出。
  const scale = Math.max(0.25, Math.min(2, MAX_SIDE / built.width, MAX_SIDE / built.height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(built.clone)], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(built.width * scale);
    canvas.height = Math.round(built.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--desk').trim() || '#f2eee4';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const link = document.createElement('a');
    const href = URL.createObjectURL(blob);
    link.href = href; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  } finally { URL.revokeObjectURL(url); }
}
