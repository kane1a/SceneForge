const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function directoryExists(file, fileSystem = fs) {
  try { return fileSystem.statSync(file).isDirectory(); } catch { return false; }
}

function probeWritable(directory, fileSystem = fs) {
  let probe;
  let descriptor;
  try {
    fileSystem.mkdirSync(directory, { recursive: true });
    probe = path.join(directory, `.sceneforge-write-probe-${process.pid}-${randomUUID()}`);
    descriptor = fileSystem.openSync(probe, 'wx');
    fileSystem.writeSync(descriptor, Buffer.from('SceneForge write check'));
    fileSystem.fsyncSync(descriptor);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch { /* best effort cleanup */ }
    }
    if (probe) {
      try { fileSystem.unlinkSync(probe); } catch { /* best effort cleanup */ }
    }
  }
}

function copyMissingFiles(source, destination, fileSystem = fs) {
  fileSystem.mkdirSync(destination, { recursive: true });
  for (const entry of fileSystem.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    let existing;
    try { existing = fileSystem.lstatSync(to); } catch { existing = null; }
    if (entry.isDirectory()) {
      if (existing && !existing.isDirectory()) continue;
      copyMissingFiles(from, to, fileSystem);
    } else if (!existing && entry.isFile()) {
      fileSystem.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
}

function portableFolders(executableDir) {
  const root = path.resolve(executableDir);
  return [
    { key: 'data', legacy: path.join(root, 'SceneForge Data'), current: path.join(root, 'Data') },
    { key: 'scripts', legacy: path.join(root, 'SceneForge 劇本'), current: path.join(root, 'Scripts') },
  ];
}

/**
 * Rename both portable folders as one operation. If either rename fails, undo completed renames
 * before returning the legacy layout. A write probe selects a profile fallback for a read-only Data.
 */
function preparePortableFolders({ executableDir, fallbackUserDataDir, fileSystem = fs, writeProbe = null }) {
  if (typeof executableDir !== 'string' || !executableDir) throw new TypeError('executableDir is required');
  if (typeof fallbackUserDataDir !== 'string' || !fallbackUserDataDir) throw new TypeError('fallbackUserDataDir is required');

  const plans = portableFolders(executableDir).map((entry) => ({
    ...entry,
    hadLegacy: directoryExists(entry.legacy, fileSystem),
    hadCurrent: directoryExists(entry.current, fileSystem),
  }));
  const hasCollision = plans.some((entry) => entry.hadLegacy && entry.hadCurrent);
  const moved = [];
  let mode = 'current';
  let migrationError = null;

  if (hasCollision) {
    mode = 'legacy';
    migrationError = new Error('新舊資料夾同時存在，為避免覆寫，保留舊資料夾繼續使用。');
  } else {
    try {
      for (const entry of plans) {
        if (!entry.hadLegacy) continue;
        fileSystem.renameSync(entry.legacy, entry.current);
        moved.push(entry);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const entry of moved.reverse()) {
        try { fileSystem.renameSync(entry.current, entry.legacy); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) {
        const rollbackError = new Error(`資料夾改名失敗，且無法完整還原舊名稱：${rollbackErrors.map((item) => item.message).join('; ')}`);
        rollbackError.cause = error;
        throw rollbackError;
      }
      mode = 'legacy';
      migrationError = error;
    }
  }

  const activeDirectory = (entry) => {
    if (mode === 'current') return entry.current;
    if (entry.hadLegacy) return entry.legacy;
    if (entry.hadCurrent) return entry.current;
    return entry.legacy;
  };
  const dataDir = activeDirectory(plans[0]);
  const scriptsDir = activeDirectory(plans[1]);

  const canWrite = writeProbe ? writeProbe(dataDir) : probeWritable(dataDir, fileSystem);
  let userDataDir = dataDir;
  let usedProfileFallback = false;
  if (!canWrite) {
    userDataDir = path.resolve(fallbackUserDataDir);
    fileSystem.mkdirSync(userDataDir, { recursive: true });
    if (directoryExists(dataDir, fileSystem)) copyMissingFiles(dataDir, userDataDir, fileSystem);
    const fallbackCanWrite = writeProbe ? writeProbe(userDataDir) : probeWritable(userDataDir, fileSystem);
    if (!fallbackCanWrite) throw new Error(`免安裝版資料夾無法寫入，且使用者資料目錄也無法寫入：${userDataDir}`);
    usedProfileFallback = true;
  }
  try { fileSystem.mkdirSync(scriptsDir, { recursive: true }); } catch { /* choose a writable default in the main process */ }

  const legacyScriptsDir = plans[1].legacy;
  const scriptPathMap = path.resolve(legacyScriptsDir) === path.resolve(scriptsDir)
    ? null
    : { from: legacyScriptsDir, to: scriptsDir };
  return {
    userDataDir,
    portableDataDir: dataDir,
    dataDir: path.join(userDataDir, 'data'),
    scriptsDir,
    legacyDataDir: plans[0].legacy,
    legacyScriptsDir,
    scriptPathMap,
    renamed: mode === 'current' && moved.length > 0,
    usedProfileFallback,
    migrationError: migrationError ? migrationError.message : '',
  };
}

module.exports = { copyMissingFiles, portableFolders, preparePortableFolders, probeWritable };
