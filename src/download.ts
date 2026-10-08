/** 下載檔案的共用工具。示範版（瀏覽器沙盒）無法下載，改為顯示會存出的內容。 */

/** The browser demo runs in a sandbox that blocks downloads; show what would have been saved instead. */
export function interceptDemoDownload(name: string, text?: string): boolean {
  if (import.meta.env.MODE !== 'demo') return false;
  window.dispatchEvent(new CustomEvent('sf-demo-download', { detail: { name, text } }));
  return true;
}

function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBlob(name: string, blob: Blob) {
  if (interceptDemoDownload(name)) return;
  saveBlob(name, blob);
}

export function downloadText(name: string, content: string, mime: string) {
  if (interceptDemoDownload(name, content)) return;
  saveBlob(name, new Blob([content], { type: mime }));
}

export function safeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'SceneForge';
}
