import path from 'node:path';

function relativeInside(root, candidate) {
  if (typeof root !== 'string' || !root || typeof candidate !== 'string' || !candidate) return null;
  const win = path.win32;
  const absoluteRoot = win.resolve(root);
  const absoluteCandidate = win.resolve(candidate);
  const relative = win.relative(absoluteRoot, absoluteCandidate);
  if (relative === '..' || relative.startsWith(`..${win.sep}`) || win.isAbsolute(relative)) return null;
  return relative;
}

/** Convert a stored legacy script path only when it is inside the old Scripts folder. */
export function remapPortableScriptPath(filePath, mapping) {
  if (!mapping || typeof mapping.from !== 'string' || typeof mapping.to !== 'string') return filePath;
  const relative = relativeInside(mapping.from, filePath);
  if (relative === null) return filePath;
  return path.win32.join(mapping.to, relative);
}

/** Update all absolute .sfe locations stored by the app after the portable Scripts rename. */
export function rewritePortableDatabasePaths(db, mapping) {
  if (!mapping || typeof mapping.from !== 'string' || typeof mapping.to !== 'string') return { projectFiles: 0, trashedProjects: 0 };
  const specs = [
    { table: 'project_file_locations', id: 'project_id', column: 'file_path', result: 'projectFiles' },
    { table: 'trashed_projects', id: 'id', column: 'sfe_original_path', result: 'trashedProjects' },
  ];
  const counts = { projectFiles: 0, trashedProjects: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const spec of specs) {
      const rows = db.prepare(`SELECT ${spec.id} AS id, ${spec.column} AS filePath FROM ${spec.table} WHERE ${spec.column} IS NOT NULL`).all();
      const update = db.prepare(`UPDATE ${spec.table} SET ${spec.column} = ? WHERE ${spec.id} = ?`);
      for (const row of rows) {
        const next = remapPortableScriptPath(row.filePath, mapping);
        if (next !== row.filePath) {
          update.run(next, row.id);
          counts[spec.result] += 1;
        }
      }
    }
    db.exec('COMMIT');
    return counts;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}
