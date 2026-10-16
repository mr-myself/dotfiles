import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DeckError, EXIT } from './fail.js';

/**
 * Write a file atomically: into a sibling temp file, then rename. A deck build
 * that dies partway must not leave a half-written report that the next reader
 * parses as truth.
 * @param {string} file
 * @param {string | Buffer} data
 */
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // EXCLUSIVE CREATION, UNPREDICTABLE NAME.
  //
  // The temp name used to be `<file>.tmp-<pid>-<now>`, which is guessable,
  // and plain writeFileSync FOLLOWS a pre-existing symlink and truncates its
  // target. In a directory another process can write to, a planted link
  // turned deck's own temp write into a write somewhere else. 'wx' refuses
  // to open anything that already exists, so a planted link is an error
  // rather than a redirect, and the random suffix means there is nothing to
  // plant against.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(9).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  // rename REPLACES the destination's directory entry. It does not write
  // through a symlink or a hard link at the destination, which is what makes
  // this safe where a direct write is not.
  fs.renameSync(tmp, file);
}

/** @param {string} file @param {unknown} value */
export function writeJson(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} file @returns {any} */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {string} file @returns {any | null} */
export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

/** @param {string} file @returns {string} lowercase hex SHA-256 */
export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** @param {string | Buffer} data @returns {string} lowercase hex SHA-256 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** @param {string} dir */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * CONTAINMENT.
 *
 * deck deletes directories (out/html, out/png, out/lint) and copies files into
 * them. None of that may escape the workspace, and a symlink is how it
 * escapes.
 *
 * The subtle case, and the one that was live: a LEAF symlink is merely
 * unlinked by `fs.rm`, which is harmless. The damage comes through a symlinked
 * PARENT - if `out` itself is a symlink to somewhere else, then `out/html`
 * resolves inside that other directory and `rm -r` deletes a real tree there.
 * So the check has to be on the RESOLVED REAL PATH of the deepest existing
 * ancestor, not on whether the final component happens to be a link.
 *
 * @param {string} target
 * @param {string} root the workspace the target must stay inside
 * @param {string} what for the error message
 * @returns {string} the resolved real path of `target`
 */
export function assertInside(target, root, what) {
  const realRoot = fs.realpathSync(root);
  // Resolve the deepest ancestor that exists, then re-append the rest. A path
  // that does not exist yet still has to land inside the workspace.
  let probe = path.resolve(target);
  /** @type {string[]} */
  const tail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  const realBase = fs.existsSync(probe) ? fs.realpathSync(probe) : probe;
  const resolved = tail.length ? path.join(realBase, ...tail) : realBase;

  const rel = path.relative(realRoot, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;

  throw new DeckError(`${what} resolves outside the deck workspace`, EXIT.ENVIRONMENT, [
    `workspace: ${realRoot}`,
    `requested: ${path.resolve(target)}`,
    `resolves to: ${resolved}`,
    'deck refuses to read, write or delete through a symlink that leaves the workspace.',
  ]);
}

/**
 * Remove a directory's contents but keep the directory. Used for out/ between
 * renders so a stale page can never survive into a new build.
 *
 * `root` is REQUIRED when the caller is working inside a workspace: without
 * the containment check, a workspace whose `out` is a symlink to another
 * directory had its html/png/lint children recursively deleted there.
 *
 * @param {string} dir
 * @param {string} [root] workspace the directory must be inside
 */
export function emptyDir(dir, root) {
  const target = root ? assertInside(dir, root, `the output directory ${path.basename(dir)}`) : path.resolve(dir);
  if (fs.existsSync(target)) {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) {
      // Replace the link, never follow it.
      fs.unlinkSync(target);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * Copy a file to a destination that must be a regular file inside `root`.
 *
 * A destination that already exists as a SYMLINK would make copyFileSync write
 * through it, outside the workspace. It is removed first.
 *
 * @param {string} src
 * @param {string} dest
 * @param {string} root
 */
export function copyInto(src, dest, root) {
  const target = assertInside(dest, root, `the asset destination ${path.basename(dest)}`);
  ensureDir(path.dirname(target));
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing && existing.isDirectory()) {
    throw new DeckError(`the asset destination is a directory: ${target}`, EXIT.ENVIRONMENT);
  }
  // COPY THEN RENAME, never copyFileSync onto the destination.
  //
  // assertInside proves the PATH is inside the workspace. It cannot see a
  // HARD LINK: an in-workspace path can share an inode with a file outside,
  // and copyFileSync writes through the inode, modifying that outside file.
  // A symlinked destination has the same effect by a different route.
  //
  // Writing to a fresh exclusively-created temp file and renaming over the
  // destination replaces the directory ENTRY instead, so neither a hard link
  // nor a symlink at the destination can redirect the write. The original
  // inode is simply unlinked from this name.
  const tmp = `${target}.importing-${process.pid}-${randomBytes(9).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, fs.readFileSync(src));
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return target;
}
