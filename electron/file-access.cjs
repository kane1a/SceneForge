const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MAX_SCRIPT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RECORDED_PATHS = 4096;
const isScriptPath = (value) => typeof value === 'string' && /\.(?:sfe|sceneforge)$/i.test(value);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function writePrivateFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  try { await fs.chmod(filePath, 0o600); } catch { /* Windows permissions inherit from the private user-data directory. */ }
}

class FileAccessPolicy {
  constructor({ defaultFolder, registryFile, maxBytes = MAX_SCRIPT_FILE_BYTES }) {
    this.defaultFolder = path.resolve(defaultFolder);
    this.registryFile = path.resolve(registryFile);
    this.maxBytes = maxBytes;
    this.allowed = new Set();
    this.defaultRoot = null;
  }

  async initialize() {
    try {
      this.defaultRoot = await fs.realpath(this.defaultFolder);
    } catch {
      this.defaultRoot = null;
    }
    try {
      const stored = JSON.parse(await fs.readFile(this.registryFile, 'utf8'));
      if (Array.isArray(stored)) {
        for (const item of stored.slice(-MAX_RECORDED_PATHS)) {
          if (isScriptPath(item) && path.isAbsolute(item)) this.allowed.add(path.resolve(item));
        }
      }
    } catch { /* first run or a corrupt optional path registry */ }
    return this;
  }

  async canonicalExisting(input) {
    if (!isScriptPath(input) || !path.isAbsolute(input)) throw new Error('只能開啟 .sfe 劇本檔。');
    const resolved = path.resolve(input);
    let info;
    let realPath;
    try {
      [info, realPath] = await Promise.all([fs.stat(resolved), fs.realpath(resolved)]);
    } catch {
      throw new Error('找不到 .sfe 劇本檔。');
    }
    if (!info.isFile()) throw new Error('只能開啟 .sfe 劇本檔。');
    if (info.size > this.maxBytes) throw new Error('劇本檔超過允許的大小。');
    return { resolved, realPath: path.resolve(realPath), info };
  }

  async canonicalTarget(input) {
    if (!isScriptPath(input) || !path.isAbsolute(input)) throw new Error('只能存取 .sfe 劇本檔。');
    const resolved = path.resolve(input);
    let parent;
    try { parent = await fs.realpath(path.dirname(resolved)); }
    catch { throw new Error('找不到劇本存放資料夾。'); }
    return path.join(parent, path.basename(resolved));
  }

  async withinDefault(candidate) {
    if (!this.defaultRoot) {
      try { this.defaultRoot = await fs.realpath(this.defaultFolder); } catch { return false; }
    }
    return isWithin(this.defaultRoot, candidate);
  }

  async persist() {
    while (this.allowed.size > MAX_RECORDED_PATHS) this.allowed.delete(this.allowed.values().next().value);
    await writePrivateFile(this.registryFile, JSON.stringify([...this.allowed]));
  }

  async authorizeSelected(input) {
    const { resolved, realPath } = await this.canonicalExisting(input);
    this.allowed.add(resolved);
    this.allowed.add(realPath);
    await this.persist();
    return resolved;
  }

  async authorizeTarget(input) {
    const target = await this.canonicalTarget(input);
    this.allowed.add(target);
    await this.persist();
    return target;
  }

  async read(input, isRecordedProjectPath = async () => false) {
    const { resolved, realPath, info } = await this.canonicalExisting(input);
    let allowed = this.allowed.has(realPath) || await this.withinDefault(realPath);
    if (!allowed && await isRecordedProjectPath(resolved, realPath)) {
      this.allowed.add(realPath);
      await this.persist();
      allowed = true;
    }
    if (!allowed) throw new Error('只能開啟已選取、預設劇本資料夾內或 SceneForge 已記錄的劇本檔。');
    if (info.size > this.maxBytes) throw new Error('劇本檔超過允許的大小。');
    return new Uint8Array(await fs.readFile(realPath));
  }

  async write(input, bytes) {
    const size = bytes?.byteLength ?? bytes?.length ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(size) || size > this.maxBytes) throw new Error('劇本檔超過允許的大小。');
    const target = await this.canonicalTarget(input);
    const allowed = this.allowed.has(target) || await this.withinDefault(target);
    if (!allowed) throw new Error('請用「另存新檔」選擇存放位置。');
    const temp = `${target}.saving-${randomBytes(6).toString('hex')}`;
    try {
      await fs.writeFile(temp, Buffer.from(bytes), { flag: 'wx' });
      await fs.rename(temp, target);
      this.allowed.add(target);
      await this.persist();
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

module.exports = { FileAccessPolicy, MAX_SCRIPT_FILE_BYTES, isWithin };
