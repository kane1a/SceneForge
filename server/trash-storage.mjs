import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { constants } from 'node:fs';
import path from 'node:path';

function uniquePath(target) {
  if (!existsSync(target)) return target;
  const { dir, name, ext } = path.parse(target);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.join(dir, `${name} (${index})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error('找不到可用的還原檔名。');
}

/** 跨磁碟也安全搬移，不覆蓋目的檔；先複製再刪除來源。 */
export function moveFile(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  try { unlinkSync(source); }
  catch (error) {
    try { unlinkSync(destination); } catch { /* 留下來源，交由上層回報 */ }
    throw error;
  }
  return destination;
}

export function createTrashStorage(dataDir) {
  const trashDir = path.join(dataDir, 'trash');
  mkdirSync(trashDir, { recursive: true });
  const safeTrashPath = (name) => {
    if (typeof name !== 'string' || !name || path.basename(name) !== name || name.includes('\0')) throw new Error('垃圾桶檔名無效。');
    return path.join(trashDir, name);
  };
  return {
    dir: trashDir,
    moveIn(sourcePath, prefix) {
      if (typeof sourcePath !== 'string' || !existsSync(sourcePath)) return null;
      const preferred = path.join(trashDir, `${prefix}-${path.basename(sourcePath)}`);
      const destination = uniquePath(preferred);
      moveFile(sourcePath, destination);
      return path.basename(destination);
    },
    restore(name, originalPath) {
      const source = safeTrashPath(name);
      if (!existsSync(source)) return null;
      const destination = uniquePath(originalPath);
      moveFile(source, destination);
      return destination;
    },
    remove(name) {
      if (!name) return;
      const file = safeTrashPath(name);
      if (existsSync(file)) unlinkSync(file);
    },
  };
}
