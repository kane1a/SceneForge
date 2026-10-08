// The small, fixed set of desktop abilities the app page may use: open and save .sceneforge files.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
let portablePathMap = null;
try {
  const parsed = JSON.parse(process.env.SCENEFORGE_PORTABLE_PATH_MAP_JSON || 'null');
  if (parsed && typeof parsed.from === 'string' && typeof parsed.to === 'string') portablePathMap = parsed;
} catch { /* no portable path migration */ }
const resolvePortablePath = (filePath) => {
  if (typeof filePath !== 'string' || !portablePathMap) return filePath;
  const normalizeSlashes = (value) => value.replace(/\//g, '\\');
  const source = normalizeSlashes(portablePathMap.from);
  const target = normalizeSlashes(portablePathMap.to);
  const candidate = normalizeSlashes(filePath);
  const sourceLower = source.toLowerCase();
  const candidateLower = candidate.toLowerCase();
  if (candidateLower === sourceLower) return target;
  const prefix = sourceLower.endsWith('\\') ? sourceLower : `${sourceLower}\\`;
  if (candidateLower.startsWith(prefix)) return `${target}${candidate.slice(source.length)}`;
  return filePath;
};

contextBridge.exposeInMainWorld('sfDesktop', {
  openDialog: () => ipcRenderer.invoke('sf:open-dialog'),
  readFile: (filePath, projectId) => ipcRenderer.invoke('sf:read', filePath, projectId),
  resolvePath: resolvePortablePath,
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveDialog: (defaultName) => ipcRenderer.invoke('sf:save-dialog', defaultName),
  defaultPath: (defaultName) => ipcRenderer.invoke('sf:default-path', defaultName),
  writeFile: (path, bytes) => ipcRenderer.invoke('sf:write', path, bytes),
  takePendingPath: () => ipcRenderer.invoke('sf:pending-path'),
  folders: () => ipcRenderer.invoke('sf:folders'),
  openFolder: (key) => ipcRenderer.invoke('sf:open-folder', key),
  onOpenPath: (callback) => { ipcRenderer.on('sf:open-path', (_event, path) => callback(path)); },
  setDocumentState: (state) => ipcRenderer.send('sf:doc-state', state),
  getZoom: () => ipcRenderer.invoke('sf:get-zoom'),
  setZoom: (factor) => ipcRenderer.invoke('sf:set-zoom', factor),
  toggleFullscreen: () => ipcRenderer.invoke('sf:toggle-fullscreen'),
  testWindow: (state) => ipcRenderer.invoke('sf:test-window', state),
  onZoomChange: (callback) => {
    const listener = (_event, factor) => callback(factor);
    ipcRenderer.on('sf:zoom-changed', listener);
    return () => ipcRenderer.removeListener('sf:zoom-changed', listener);
  },
  onSaveBeforeClose: (callback) => {
    ipcRenderer.on('sf:save-before-close', async (_event, shouldSaveFile) => {
      let saved = false;
      try { saved = await callback(shouldSaveFile === true); } catch { saved = false; }
      ipcRenderer.send('sf:save-before-close-done', saved);
    });
  },
});
