function requestRendererSaveBeforeClose(ipcMain, window, shouldSaveFile, assertTrustedSender) {
  return new Promise((resolve) => {
    const listener = (event, ok) => {
      try { assertTrustedSender(event); } catch { return; }
      ipcMain.removeListener('sf:save-before-close-done', listener);
      clearTimeout(timer);
      resolve(Boolean(ok));
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener('sf:save-before-close-done', listener);
      resolve(false);
    }, 30_000);
    ipcMain.on('sf:save-before-close-done', listener);
    window.webContents.send('sf:save-before-close', shouldSaveFile);
  });
}

module.exports = { requestRendererSaveBeforeClose };
