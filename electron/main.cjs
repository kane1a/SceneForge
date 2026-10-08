// SceneForge desktop shell: shows the window at once, runs the local server inside Electron,
// and gives the page native Open / Save dialogs for .sceneforge files.
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell, utilityProcess } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { requestRendererSaveBeforeClose } = require('./close-handshake.cjs');
const { normalizeZoomFactor, stepZoomFactor } = require('./zoom.cjs');
const { preparePortableFolders } = require('./portable-migration.cjs');
const { FileAccessPolicy } = require('./file-access.cjs');
const { isAllowedNavigation, safeExternalUrl, getIpcSenderRejectionReason, runTrustedIpcOn } = require('./security.cjs');

const ROOT = path.join(__dirname, '..');
const SPLASH_LOGO = `data:image/svg+xml,${encodeURIComponent(fs.readFileSync(path.join(ROOT, 'dist', 'favicon.svg'), 'utf8'))}`;
const EXTENSION = '.sfe';
const EXTENSIONS = ['.sfe', '.sceneforge']; // .sceneforge: files from 0.4, still opened
// A fixed port keeps the page origin stable, so per-project view settings (kept in the page's
// local storage) survive restarts. If something else holds it, the next free one is remembered.
const PREFERRED_PORT = 47318;
let portableStorage = null;

if (process.env.PORTABLE_EXECUTABLE_DIR) {
  const defaultUserData = app.getPath('userData');
  portableStorage = preparePortableFolders({
    executableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    fallbackUserDataDir: path.join(defaultUserData, 'portable-fallback'),
  });
  app.setPath('userData', portableStorage.userDataDir);
  process.env.SCENEFORGE_PORTABLE_PATH_MAP_JSON = JSON.stringify(portableStorage.scriptPathMap);
  if (portableStorage.migrationError) console.warn(`SceneForge portable-folder migration: ${portableStorage.migrationError}`);
  if (portableStorage.usedProfileFallback) console.warn(`SceneForge portable Data is not writable; using ${portableStorage.userDataDir}`);
} else if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
  app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'SceneForge'));
} else if (process.platform === 'darwin') {
  app.setPath('userData', path.join(app.getPath('appData'), 'SceneForge'));
}

app.setPath('sessionData', app.getPath('userData'));
const isDocumentName = (file) => typeof file === 'string' && EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext));
const isDocumentFile = (file) => {
  if (!isDocumentName(file)) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
};
const fileFromArgs = (argv) => argv.slice(1).find((arg) => isDocumentFile(arg)) ?? null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let serverProcess = null;
  let pendingPath = fileFromArgs(process.argv);
  let documentState = { title: 'SceneForge', dirty: false };
  let closing = false;
  let fileAccess = null;
  let appOrigin = null;
  let apiToken = null;

  if (process.env.SCENEFORGE_TEST_HIDDEN === '1') process.on('uncaughtException', (error) => {
    console.error(`[SceneForge test] uncaught main-process ${error?.name || 'Error'}; terminating without dialog`);
    try { serverProcess?.kill(); } catch { /* best effort */ }
    app.exit(1);
  });

  const assertTrustedIpc = (event) => {
    const reason = getIpcSenderRejectionReason(event, win?.webContents, appOrigin);
    if (!reason) return;
    if (process.env.SCENEFORGE_TEST_HIDDEN === '1') console.warn(`[SceneForge test] rejected handle IPC (${reason})`);
    throw new Error('拒絕來自非 SceneForge 主畫面的 IPC 請求。');
  };
  const authorizeOsOpen = async (file, send) => {
    try { await fileAccess?.authorizeSelected(file); } catch { /* the renderer will show its normal open error */ }
    send?.();
  };

  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (!isDocumentFile(file)) return;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      void authorizeOsOpen(file, () => win?.webContents.send('sf:open-path', file));
    } else pendingPath = file;
  });

  app.on('second-instance', (_event, argv) => {
    const file = fileFromArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (file) void authorizeOsOpen(file, () => win?.webContents.send('sf:open-path', file));
    } else if (file) pendingPath = file;
  });

  // ——— Small preferences kept beside the window state ———
  const prefsFile = () => path.join(app.getPath('userData'), 'preferences.json');
  const readPrefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')); } catch { return {}; } };
  const writePrefs = (change) => { try { fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...change })); } catch { /* optional */ } };
  const persistedZoomFactor = () => normalizeZoomFactor(readPrefs().zoomFactor);
  const applyZoomFactor = (factor) => {
    const next = normalizeZoomFactor(factor);
    if (!win || win.isDestroyed()) return persistedZoomFactor();
    win.webContents.setZoomFactor(next);
    writePrefs({ zoomFactor: next });
    win.webContents.send('sf:zoom-changed', next);
    return next;
  };
  // Where scripts are saved by default. The portable build keeps them beside the .exe; the installed
  // build uses Documents, because the program folder is replaced on every update and uninstall.
  const defaultScriptFolder = () => {
    const folder = portableStorage?.scriptsDir ?? path.join(app.getPath('documents'), 'SceneForge');
    try { fs.mkdirSync(folder, { recursive: true }); } catch { /* fall back below */ }
    return fs.existsSync(folder) ? folder : app.getPath('documents');
  };
  const existingFolder = (folder) => { try { return folder && fs.statSync(folder).isDirectory() ? folder : null; } catch { return null; } };

  // ——— Window size and position, remembered between sessions ———
  const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
  const readWindowState = () => {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      const { x, y, width, height } = state.bounds ?? {};
      const visible = screen.getAllDisplays().some(({ workArea: area }) => x < area.x + area.width - 80 && x + width > area.x + 80 && y >= area.y - 20 && y < area.y + area.height - 80);
      return { bounds: visible && width >= 800 && height >= 500 ? state.bounds : null, maximized: state.maximized !== false, fullScreen: state.fullScreen === true };
    } catch {
      return { bounds: null, maximized: true, fullScreen: false }; // first run: fill the screen
    }
  };
  const saveWindowState = () => {
    if (!win) return;
    try { fs.writeFileSync(stateFile(), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() })); } catch { /* optional */ }
  };

  // ——— Local server ———
  const portFile = () => path.join(app.getPath('userData'), 'port.json');
  const tokenFile = () => path.join(app.getPath('userData'), 'api-token');
  const writePrivate = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* Windows inherits ACLs from the user-data directory. */ }
  };
  const isFree = (port) => new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(false)).once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
  async function choosePort() {
    let saved = PREFERRED_PORT;
    try { saved = JSON.parse(fs.readFileSync(portFile(), 'utf8')).port || PREFERRED_PORT; } catch { /* first run */ }
    for (let port = saved; port < saved + 20; port += 1) {
      if (await isFree(port)) return port;
    }
    throw new Error('找不到可用的本機連接埠。');
  }
  const waitForServer = (port, token) => new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000, headers: { Authorization: `Bearer ${token}` } }, (res) => { res.resume(); if (res.statusCode === 200) resolve(); else reject(new Error('本機服務驗證失敗。')); })
        .on('error', () => (Date.now() - started > 20000 ? reject(new Error('本機服務沒有回應。')) : setTimeout(attempt, 40)));
    };
    attempt();
  });
  async function startServer() {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const port = await choosePort();
    apiToken = randomBytes(32).toString('base64url');
    appOrigin = `http://127.0.0.1:${port}`;
    writePrivate(tokenFile(), `${apiToken}\n`);
    writePrivate(portFile(), JSON.stringify({ port, token: apiToken }));
    process.env.SCENEFORGE_PORT = String(port);
    process.env.SCENEFORGE_API_TOKEN = apiToken;
    process.env.SCENEFORGE_TOKEN_FILE = tokenFile();
    process.env.SCENEFORGE_PORT_FILE = portFile();
    process.env.SCENEFORGE_DATA_DIR = path.join(app.getPath('userData'), 'data');
    process.env.SCENEFORGE_DIST_DIR = path.join(ROOT, 'dist');
    // cwd must be a real folder: inside a packaged app ROOT is app.asar, which cannot be a working directory.
    serverProcess = utilityProcess.fork(path.join(ROOT, 'server', 'index.mjs'), [], {
      cwd: app.getPath('userData'),
      env: process.env,
      serviceName: 'SceneForge Local Server',
      stdio: 'pipe',
    });
    serverProcess.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    serverProcess.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    serverProcess.on('exit', (code) => {
      if (serverProcess && !closing && code !== 0) console.error(`SceneForge server exited with code ${code}`);
    });
    await waitForServer(port, apiToken);
    if (process.env.SCENEFORGE_PERF_LOG === '1') console.log(`[SF-PERF] electron_main_pid=${process.pid} utility_server_pid=${serverProcess.pid}`);
    return port;
  }

  // A page that shows the moment the window opens, while the server starts.
  const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#e7e3da;display:grid;place-items:center;font-family:"Noto Serif TC","Microsoft JhengHei",serif;color:#48433a}
    .logo{width:64px;height:64px;display:block;object-fit:contain}
    .wrap{display:grid;justify-items:center;gap:14px;animation:in .4s ease-out both}
    p{margin:0;font:italic 500 22px Georgia,serif;letter-spacing:.02em}
    @keyframes in{from{opacity:0;transform:translateY(6px)}}
  </style><div class="wrap"><img class="logo" src="${SPLASH_LOGO}" alt=""><p>SceneForge</p></div>`)}`;

  async function start() {
    Menu.setApplicationMenu(null);
    fileAccess = await new FileAccessPolicy({
      defaultFolder: defaultScriptFolder(),
      registryFile: path.join(app.getPath('userData'), 'authorized-sfe-paths.json'),
    }).initialize();
    const serverReady = startServer();
    const state = readWindowState();
    win = new BrowserWindow({
      ...(state.bounds ?? { width: 1440, height: 900 }),
      minWidth: 1024,
      minHeight: 640,
      show: false,
      backgroundColor: '#e7e3da',
      title: 'SceneForge',
      icon: path.join(ROOT, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.setZoomFactor(persistedZoomFactor());
    win.once('ready-to-show', () => {
      if (process.env.SCENEFORGE_TEST_HIDDEN === '1') {
        win.setFullScreen(false);
        win.unmaximize();
        win.setPosition(-4000, -4000);
        win.showInactive();
        return;
      }
      if (state.maximized) win.maximize();
      if (state.fullScreen) win.setFullScreen(true);
      win.show();
    });
    await win.loadURL(SPLASH);
    const port = await serverReady;
    const origin = appOrigin ?? `http://127.0.0.1:${port}`;
    const openExternal = (url) => {
      const safeUrl = safeExternalUrl(url);
      if (safeUrl) void shell.openExternal(safeUrl).catch(() => undefined);
    };
    const allowNavigation = (url) => isAllowedNavigation(url, origin, SPLASH);
    // Only the app itself loads in the window; safe external links go to the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => {
      const target = typeof url === 'string' ? url : event.url;
      if (!allowNavigation(target)) { event.preventDefault(); openExternal(target); }
    });
    win.webContents.on('will-redirect', (event, url) => {
      const target = typeof url === 'string' ? url : event.url;
      if (!allowNavigation(target)) event.preventDefault();
    });
    win.webContents.on('will-frame-navigate', (event) => {
      if (!allowNavigation(event.url)) event.preventDefault();
    });
    // Exports ask where to save, starting in the folder the writer exported to last time.
    win.webContents.session.on('will-download', (_event, item) => {
      const folder = existingFolder(readPrefs().exportFolder) ?? app.getPath('documents');
      item.setSaveDialogOptions({ title: '匯出', defaultPath: path.join(folder, item.getFilename()) });
      item.once('done', (_e, state) => {
        if (state === 'completed' && item.getSavePath()) writePrefs({ exportFolder: path.dirname(item.getSavePath()) });
        win?.webContents.focus();
      });
    });
    // Native dialogs (file pickers, save dialogs) can leave the page without keyboard focus on
    // Windows; hand it back whenever the window becomes active again.
    win.on('focus', () => win?.webContents.focus());
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
      if (input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
      if ((input.control || input.meta) && !input.alt) {
        const zoomIn = ['=', '+'].includes(input.key) || input.code === 'NumpadAdd';
        const zoomOut = ['-', '_'].includes(input.key) || input.code === 'NumpadSubtract';
        const resetZoom = input.key === '0' || input.code === 'Numpad0';
        if (zoomIn || zoomOut || resetZoom) {
          event.preventDefault();
          applyZoomFactor(resetZoom ? 1 : stepZoomFactor(win.webContents.getZoomFactor(), zoomIn ? 1 : -1));
          return;
        }
      }
      if ((input.control || input.meta) && input.key.toLowerCase() === 'r' && app.isPackaged) event.preventDefault();
    });
    win.on('close', async (event) => {
      saveWindowState();
      if (closing || !documentState.dirty) return;
      event.preventDefault();
      // 儲存、不儲存、取消；Esc 與「取消」都留在目前視窗。
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['儲存', '不儲存', '取消'], defaultId: 0, cancelId: 2, noLink: true,
        title: 'SceneForge', message: `要儲存「${documentState.title}」嗎？`, detail: '不儲存的話，這次的變更不會寫入劇本檔。',
      });
      if (response === 2) return;
      const saved = await requestRendererSaveBeforeClose(ipcMain, win, response === 0, assertTrustedIpc);
      if (!saved) return;
      closing = true;
      win.close();
    });
    // Save size and position as they change, so even a crash or power cut keeps the writer's layout.
    let stateTimer = null;
    const queueStateSave = () => { clearTimeout(stateTimer); stateTimer = setTimeout(saveWindowState, 400); };
    for (const name of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(name, queueStateSave);
    win.on('closed', () => { clearTimeout(stateTimer); win = null; });
    await win.loadURL(`${origin}/`);
    // Navigation from the splash page resets Chromium's site zoom; reapply after the app origin loads.
    applyZoomFactor(persistedZoomFactor());
  }

  // ——— Display zoom: persisted independently from per-project view preferences ———
  const normalizePathForComparison = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const isProjectPathRecorded = async (projectId, candidate, realPath) => {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(projectId) || !appOrigin || !apiToken) return false;
    try {
      const response = await fetch(`${appOrigin}/api/projects/${encodeURIComponent(projectId)}/file`, { headers: { Authorization: `Bearer ${apiToken}` } });
      if (!response.ok) return false;
      const record = await response.json();
      if (typeof record.path !== 'string') return false;
      const recordedPath = normalizePathForComparison(record.path);
      return recordedPath === normalizePathForComparison(candidate) || recordedPath === normalizePathForComparison(realPath);
    } catch { return false; }
  };
  // Test-only window control, registered only when SCENEFORGE_TEST_HIDDEN is set (never in normal runs).
  if (process.env.SCENEFORGE_TEST_HIDDEN === '1') ipcMain.handle('sf:test-window', (event, state) => {
    assertTrustedIpc(event);
    if (!win) return;
    win.setFullScreen(state === 'fullscreen');
    if (state === 'maximized') win.maximize();
    if (state === 'normal') win.unmaximize();
    return win.getContentSize();
  });
  ipcMain.handle('sf:get-zoom', (event) => {
    assertTrustedIpc(event);
    return win.webContents.getZoomFactor();
  });
  ipcMain.handle('sf:set-zoom', (event, factor) => {
    assertTrustedIpc(event);
    return applyZoomFactor(factor);
  });
  ipcMain.handle('sf:toggle-fullscreen', (event) => {
    assertTrustedIpc(event);
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });

  // ——— File dialogs and constrained file access for the page ———
  const filters = [{ name: 'SceneForge 劇本', extensions: ['sfe', 'sceneforge'] }];
  ipcMain.handle('sf:open-dialog', async (event) => {
    assertTrustedIpc(event);
    const result = await dialog.showOpenDialog(win, { title: '開啟劇本', properties: ['openFile'], filters, defaultPath: defaultScriptFolder() });
    win?.webContents.focus();
    if (result.canceled || !result.filePaths[0]) return null;
    const file = await fileAccess.authorizeSelected(result.filePaths[0]);
    return { path: file, bytes: await fileAccess.read(file) };
  });
  ipcMain.handle('sf:read', async (event, file, projectId) => {
    assertTrustedIpc(event);
    return fileAccess.read(file, (candidate) => isProjectPathRecorded(projectId, candidate));
  });
  ipcMain.handle('sf:save-dialog', async (event, defaultName) => {
    assertTrustedIpc(event);
    const name = String(defaultName || '未命名劇本').replace(/[\\/:*?"<>|]/g, '_');
    const result = await dialog.showSaveDialog(win, { title: '另存新檔', defaultPath: path.join(defaultScriptFolder(), name.toLowerCase().endsWith(EXTENSION) ? name : `${name}${EXTENSION}`), filters: [{ name: 'SceneForge 劇本', extensions: ['sfe'] }] });
    win?.webContents.focus();
    if (result.canceled || !result.filePath) return null;
    const file = result.filePath.toLowerCase().endsWith(EXTENSION) ? result.filePath : `${result.filePath}${EXTENSION}`;
    return fileAccess.authorizeTarget(file);
  });
  // First save of a new script: straight into the default folder, never overwriting another file.
  ipcMain.handle('sf:default-path', async (event, defaultName) => {
    assertTrustedIpc(event);
    const name = String(defaultName || '未命名劇本').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名劇本';
    const folder = defaultScriptFolder();
    let file = path.join(folder, `${name}${EXTENSION}`);
    for (let n = 2; fs.existsSync(file); n += 1) file = path.join(folder, `${name} (${n})${EXTENSION}`);
    return fileAccess.authorizeTarget(file);
  });
  ipcMain.handle('sf:write', async (event, file, bytes) => {
    assertTrustedIpc(event);
    await fileAccess.write(file, bytes);
  });
  // 讓介面顯示並打開資料存放位置；只允許打開這幾個 SceneForge 自己的資料夾。
  const storageFolders = () => ({ scripts: defaultScriptFolder(), data: path.join(app.getPath('userData'), 'data'), backups: path.join(app.getPath('userData'), 'data', 'backups'), trash: path.join(app.getPath('userData'), 'data', 'trash') });
  ipcMain.handle('sf:folders', (event) => {
    assertTrustedIpc(event);
    return storageFolders();
  });
  ipcMain.handle('sf:open-folder', async (event, key) => {
    assertTrustedIpc(event);
    const folder = storageFolders()[key];
    if (!folder) return false;
    try { fs.mkdirSync(folder, { recursive: true }); } catch { /* shown as error below */ }
    return (await shell.openPath(folder)) === '';
  });
  ipcMain.handle('sf:pending-path', async (event) => {
    assertTrustedIpc(event);
    const file = pendingPath;
    pendingPath = null;
    if (file) await fileAccess.authorizeSelected(file).catch(() => undefined);
    return file;
  });
  ipcMain.on('sf:doc-state', (event, state) => {
    const accepted = runTrustedIpcOn(event, win?.webContents, appOrigin, () => {
      documentState = {
        title: typeof state?.title === 'string' ? state.title.slice(0, 256) : 'SceneForge',
        dirty: state?.dirty === true,
      };
      if (win) win.setTitle(documentState.title && documentState.title !== 'SceneForge' ? `${documentState.dirty ? '● ' : ''}${documentState.title} — SceneForge` : 'SceneForge');
    });
    if (!accepted && process.env.SCENEFORGE_TEST_HIDDEN === '1') {
      console.warn(`[SceneForge test] ignored sf:doc-state IPC (${getIpcSenderRejectionReason(event, win?.webContents, appOrigin)})`);
    }
  });

  app.whenReady().then(start).catch((error) => {
    if (process.env.SCENEFORGE_TEST_HIDDEN === '1') {
      console.error(`[SceneForge test] startup failed (${error?.name || 'Error'}); terminating without dialog`);
      try { serverProcess?.kill(); } catch { /* best effort */ }
      app.exit(1);
      return;
    }
    dialog.showErrorBox('SceneForge 無法啟動', `${error?.message ?? error}\n\n請重新開啟；若持續發生，請聯絡客服。`);
    app.quit();
  });
  app.on('will-quit', () => {
    if (!serverProcess) return;
    const child = serverProcess;
    serverProcess = null;
    try { child.kill(); } catch { /* already exited */ }
  });
  app.on('window-all-closed', () => app.quit());
}
