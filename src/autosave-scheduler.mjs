export function scheduleDocumentAutoSave(save, { target = window, delayMs = 20_000 } = {}) {
  let timer;
  let active = true;
  const cleanup = () => {
    if (timer !== undefined) {
      target.clearTimeout(timer);
      timer = undefined;
    }
    target.removeEventListener('blur', run);
  };
  const run = () => {
    if (!active) return;
    active = false;
    cleanup();
    save();
  };
  timer = target.setTimeout(run, delayMs);
  target.addEventListener('blur', run);
  return () => {
    active = false;
    cleanup();
  };
}

export function scheduleProjectAutoSave(save, { target = window, delayMs = 1000, idleTimeoutMs = 1000 } = {}) {
  let timer;
  let idleHandle;
  let active = true;
  const cleanup = () => {
    if (timer !== undefined) {
      target.clearTimeout(timer);
      timer = undefined;
    }
    if (idleHandle !== undefined) {
      target.cancelIdleCallback?.(idleHandle);
      idleHandle = undefined;
    }
    target.removeEventListener('blur', flush);
    target.removeEventListener('pagehide', flush);
    target.removeEventListener('beforeunload', flush);
  };
  const flush = () => {
    if (!active) return;
    active = false;
    cleanup();
    return save();
  };
  const afterQuiet = () => {
    if (!active) return;
    if (typeof target.requestIdleCallback === 'function') {
      idleHandle = target.requestIdleCallback(() => {
        idleHandle = undefined;
        flush();
      }, { timeout: idleTimeoutMs });
    } else flush();
  };
  timer = target.setTimeout(afterQuiet, delayMs);
  target.addEventListener('blur', flush);
  target.addEventListener('pagehide', flush);
  target.addEventListener('beforeunload', flush);
  return {
    flush,
    cancel() {
      if (!active) return;
      active = false;
      cleanup();
    },
  };
}
