import fs from 'node:fs';
import path from 'node:path';
import { DeckError, EXIT } from './util/fail.js';
import { assertInside, ensureDir, sha256File, writeJson } from './util/fs.js';

/**
 * PUBLISHING A RENDER.
 *
 * A render used to write straight into the published paths: it deleted
 * out/html, rebuilt it, overwrote out/deck.pdf, deleted out/png, then ran
 * pdftoppm. Every one of those steps is a window in which the workspace holds
 * a mixture of two renders. If rasterization failed, out/ kept a NEW pdf
 * beside OLD geometry and OLD pngs, all looking equally current; two
 * simultaneous renders could interleave into a set that never existed.
 *
 * So a render now builds into out/.staging-<pid>-<time>/ and is published
 * only after it has been verified end to end. Publication swaps whole
 * directories and is the only part that touches the published names.
 *
 * Two things this does NOT claim:
 *
 *   - It is not atomic. POSIX gives atomic rename of ONE path, and a render
 *     publishes several (deck.pdf, geometry.json, html/, png/). The window is
 *     reduced from the whole render to a handful of renames, and the
 *     fingerprint written into geometry.json lets every later command detect
 *     a mismatched set rather than trusting it. A reader that wants certainty
 *     checks the fingerprint; it does not rely on the swap.
 *   - The lock is advisory and local. It is an O_EXCL lockfile with a stale
 *     timeout, which serialises renders on one machine. It does not defend
 *     against a hostile process, and it is not meant to.
 */

/** Everything a render produces, by published name. */
export const PUBLISHED = ['html', 'png', 'deck.pdf', 'geometry.json', 'artifacts.json'];

/**
 * @param {import('./workspace.js').Paths} p
 * @returns {{dir: string, path: (name: string) => string}}
 */
export function createStage(p) {
  assertInside(p.out, p.root, 'the output directory');
  ensureDir(p.out);
  const dir = path.join(p.out, `.staging-${process.pid}-${Date.now()}`);
  assertInside(dir, p.root, 'the render staging directory');
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  return { dir, path: (name) => path.join(dir, name) };
}

/**
 * Replace the published artifacts with the staged ones.
 *
 * ROLLBACK IS UNCONDITIONAL AND NON-DESTRUCTIVE. The previous version
 * restored a backup only when the published name happened to be absent, so a
 * failure part-way left the already-installed NEW html and png beside the OLD
 * geometry; and because the restore reused the same failing operation and its
 * error was swallowed, while the backup directory was deleted in `finally`,
 * the previous deck.pdf was destroyed outright. Reproduced by injecting a
 * failure on the third of four names.
 *
 * Now: every name that was moved aside is put back, the new one removed first
 * if it is in the way; and if ANY restoration fails the backup directory is
 * KEPT and its location is in the error, because a lost deliverable is worse
 * than a stale one.
 *
 * @param {import('./workspace.js').Paths} p
 * @param {{dir: string}} stage
 * @param {string[]} names
 */
export function publish(p, stage, names = PUBLISHED) {
  const trash = path.join(p.out, `.replaced-${process.pid}-${Date.now()}`);
  ensureDir(trash);
  /** @type {string[]} */
  const moved = [];
  let keepTrash = false;
  try {
    for (const name of names) {
      const staged = path.join(stage.dir, name);
      if (!fs.existsSync(staged)) continue;
      const target = assertInside(path.join(p.out, name), p.root, `the published artifact ${name}`);
      if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
        fs.renameSync(target, path.join(trash, name));
        moved.push(name);
      }
      fs.renameSync(staged, target);
    }
  } catch (err) {
    const failures = rollback(p, trash, moved);
    if (failures.length > 0) {
      keepTrash = true;
      throw new DeckError(
        `publishing the render failed, AND the previous output could not be fully restored: ${err.message}`,
        EXIT.PROCESS_FAILED,
        [
          ...failures.map((f) => `could not restore ${f.name}: ${f.error}`),
          '',
          `The previous artifacts are preserved in: ${trash}`,
          'Move them back by hand, or re-run `deck render`.',
        ],
      );
    }
    throw new DeckError(
      `publishing the render failed; the previous output was restored: ${err.message}`,
      EXIT.PROCESS_FAILED,
      ['Nothing from the failed render was published.'],
    );
  } finally {
    if (!keepTrash) fs.rmSync(trash, { recursive: true, force: true });
    fs.rmSync(stage.dir, { recursive: true, force: true });
  }
}

/**
 * Put every moved-aside artifact back.
 * @returns {{name: string, error: string}[]} the ones that could not be restored
 */
function rollback(p, trash, moved) {
  /** @type {{name: string, error: string}[]} */
  const failures = [];
  for (const name of moved) {
    const back = path.join(trash, name);
    const target = path.join(p.out, name);
    try {
      if (!fs.existsSync(back)) {
        failures.push({ name, error: 'the backup is missing' });
        continue;
      }
      // The half-published NEW artifact is in the way. Remove it: it belongs
      // to a render that did not complete and must not survive.
      if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      fs.renameSync(back, target);
    } catch (err) {
      failures.push({ name, error: String(err && err.message ? err.message : err) });
    }
  }
  return failures;
}

/**
 * THE ARTIFACT MANIFEST: the SHA-256 of every byte this render published.
 *
 * The render fingerprint identifies the INPUTS. It cannot, on its own, detect
 * a mixed set: reverting the inputs to the previous revision makes the
 * fingerprint match again while the files on disk are still half one render
 * and half another. Reproduced by the reviewer, and it is the reason this
 * file exists.
 *
 * So the published set also carries the hashes of its own bytes, and `deck
 * export` and `deck lint` verify them. A PDF from one render beside geometry
 * from another fails whichever way it came about.
 *
 * artifacts.json cannot contain its own hash, so it is the one file not
 * listed; it is published last, which also makes its absence the signal that
 * a publication did not finish.
 *
 * @param {string} dir the staging directory
 * @param {string} fingerprint
 * @param {string[]} names
 */
export function writeArtifactManifest(dir, fingerprint, names = PUBLISHED) {
  /** @type {Record<string, string>} */
  const artifacts = {};
  for (const name of names) {
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) {
      for (const rel of walk(full)) {
        artifacts[`${name}/${rel}`] = sha256File(path.join(full, rel));
      }
    } else {
      artifacts[name] = sha256File(full);
    }
  }
  const manifest = {
    schema: 'deck.artifacts/1',
    render_fingerprint: fingerprint,
    generated_at: new Date().toISOString(),
    artifacts,
  };
  writeJson(path.join(dir, ARTIFACT_MANIFEST), manifest);
  return manifest;
}

export const ARTIFACT_MANIFEST = 'artifacts.json';

/**
 * Verify the published bytes against the manifest.
 *
 * @param {import('./workspace.js').Paths} p
 * @param {string} [expectedFingerprint]
 * @returns {string[]} problems, empty when the set is internally consistent
 */
export function verifyArtifacts(p, expectedFingerprint) {
  const file = path.join(p.out, ARTIFACT_MANIFEST);
  if (!fs.existsSync(file)) {
    return [`out/${ARTIFACT_MANIFEST} is missing, so the delivered bytes cannot be checked against the render that produced them. Re-run \`deck render\`.`];
  }
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return [`out/${ARTIFACT_MANIFEST} is not valid JSON: ${err.message}`];
  }
  /** @type {string[]} */
  const problems = [];
  if (expectedFingerprint && manifest.render_fingerprint !== expectedFingerprint) {
    problems.push(`out/${ARTIFACT_MANIFEST} describes render ${manifest.render_fingerprint}, not the current ${expectedFingerprint}`);
  }
  const listed = manifest.artifacts || {};
  for (const [rel, expected] of Object.entries(listed)) {
    const full = path.join(p.out, rel);
    if (!fs.existsSync(full)) {
      problems.push(`${rel} is missing, but this render published it`);
      continue;
    }
    const actual = sha256File(full);
    if (actual !== expected) {
      problems.push(`${rel} has changed since it was published: expected ${expected.slice(0, 16)}..., found ${actual.slice(0, 16)}.... The delivered files are not the ones this render produced.`);
    }
  }
  // An EXTRA file inside a published directory means a leftover from another
  // render, which is exactly the mixed set this exists to catch.
  for (const name of PUBLISHED) {
    const full = path.join(p.out, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
    for (const rel of walk(full)) {
      if (!(`${name}/${rel}` in listed)) {
        problems.push(`out/${name}/${rel} was not published by this render; it is left over from another one`);
      }
    }
  }
  return problems;
}

/** Every file under a directory, as paths relative to it. */
function walk(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Remove a stage without publishing. Called when a render fails. */
export function discardStage(stage) {
  if (stage && stage.dir) fs.rmSync(stage.dir, { recursive: true, force: true });
}

/**
 * Clean up stages and trash left by a crashed earlier run.
 * @param {import('./workspace.js').Paths} p
 */
export function sweepStages(p) {
  // CONTAINMENT FIRST. This runs BEFORE the render touches out/, and it
  // deletes directories recursively. With a symlinked out/ it was deleting
  // external `.staging-*` and `.replaced-*` directories an hour old - a
  // cleanup routine reaching outside the workspace before anything had
  // checked the workspace at all.
  try {
    assertInside(p.out, p.root, 'the output directory');
  } catch {
    // Leave it entirely alone. The render itself will refuse with a proper
    // message; sweeping is housekeeping and must never be the thing that
    // reaches somewhere it should not.
    return;
  }
  if (!fs.existsSync(p.out)) return;
  for (const entry of fs.readdirSync(p.out)) {
    if (!entry.startsWith('.staging-') && !entry.startsWith('.replaced-')) continue;
    const full = path.join(p.out, entry);
    try {
      const age = Date.now() - fs.statSync(full).mtimeMs;
      if (age > 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true });
    } catch { /* another process may be using it */ }
  }
}

/**
 * How long a lock whose owner is GONE is honoured before it is broken.
 *
 * Only ever applied to a dead owner. A LIVE owner keeps its lock for as long
 * as it is alive: a render that legitimately takes an hour must not have its
 * output stolen by a second process, and the previous code broke any lock
 * older than 30 minutes regardless of liveness.
 */
const DEAD_LOCK_GRACE_MS = 30 * 1000;

/**
 * How long a lock file may stay empty before it is treated as abandoned.
 *
 * There is a window between O_EXCL creation and writing the payload. Another
 * process that read the file in that window saw nothing, called it invalid,
 * unlinked it and took its own lock - two successful acquisitions, and the
 * first one's release then deleted the second one's lock. Reproduced by
 * interleaving. An empty lock is now assumed to be initialising.
 */
const LOCK_INIT_GRACE_MS = 5 * 1000;

/**
 * An advisory per-workspace lock, so two renders cannot interleave.
 *
 * O_EXCL creation is the primitive. The subtleties are all about NOT stealing
 * a lock that is still valid:
 *
 *   - an empty lock is initialising, not invalid, until LOCK_INIT_GRACE_MS;
 *   - a lock whose owner is ALIVE is never broken, at any age;
 *   - a lock whose owner is gone is broken after DEAD_LOCK_GRACE_MS;
 *   - release verifies OWNERSHIP before unlinking, so a process cannot
 *     delete a lock that is no longer its own.
 *
 * A token is written alongside the pid: pids are reused, and the token makes
 * "is this still my lock" answerable without relying on that.
 *
 * @param {import('./workspace.js').Paths} p
 * @param {string} what
 * @returns {() => void} release
 */
export function acquireRenderLock(p, what) {
  ensureDir(p.state);
  const lockFile = path.join(p.state, 'render.lock');
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify({ pid: process.pid, token, what, at: new Date().toISOString() });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Written through the SAME descriptor the exclusive create returned, so
      // the file is never reopened by path between creation and its contents
      // being there.
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseIfOwned(lockFile, token);
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      const existing = readLock(lockFile);
      const ageOnDisk = lockAgeMs(lockFile);

      // EMPTY OR UNPARSEABLE: another process is between create and write.
      if (!existing) {
        if (ageOnDisk < LOCK_INIT_GRACE_MS) {
          throw new DeckError('another deck command is starting up in this workspace', EXIT.ENVIRONMENT, [
            `lock file: ${lockFile}`,
            'It was created a moment ago and has not finished initialising. Try again.',
          ]);
        }
        // Older than the init grace and still unreadable: genuinely abandoned.
        unlinkQuietly(lockFile);
        continue;
      }

      if (existing.token && existing.token === token) {
        // Our own lock, from a previous attempt in this loop.
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releaseIfOwned(lockFile, token);
        };
      }

      // A LIVE OWNER IS NEVER BROKEN, whatever its age.
      if (pidAlive(existing.pid)) {
        throw new DeckError('another deck command is already writing to this workspace', EXIT.ENVIRONMENT, [
          `held by pid ${existing.pid} since ${existing.at} (${existing.what})`,
          `lock file: ${lockFile}`,
          'Wait for it to finish. deck will not break a lock whose owner is still running, however long it takes.',
        ]);
      }

      const age = Number.isFinite(Date.parse(existing.at))
        ? Date.now() - Date.parse(existing.at)
        : ageOnDisk;
      if (age < DEAD_LOCK_GRACE_MS) {
        throw new DeckError('another deck command holds this workspace', EXIT.ENVIRONMENT, [
          `held by pid ${existing.pid} since ${existing.at} (${existing.what})`,
          'Its process is gone but the lock is very recent; deck waits briefly in case the pid is being reused.',
          `lock file: ${lockFile}`,
        ]);
      }

      // The owner is gone and the lock is stale. Break it only if it is
      // STILL THE SAME LOCK, so one that changed hands between the read
      // above and now is not destroyed.
      breakLockIfStillTheirs(lockFile, existing);
    }
  }
  throw new DeckError('could not acquire the workspace render lock', EXIT.ENVIRONMENT, [
    path.join(p.state, 'render.lock'),
    'It changed hands repeatedly while deck was trying to take it.',
  ]);
}

/** Remove the lock only if it is still the one this token created. */
function releaseIfOwned(lockFile, token) {
  const current = readLock(lockFile);
  if (!current) return;
  if (current.token !== token) return;
  unlinkQuietly(lockFile);
}

/** Remove a dead owner's lock only if it has not changed hands since. */
function breakLockIfStillTheirs(lockFile, seen) {
  const current = readLock(lockFile);
  if (!sameLock(current, seen)) return;
  unlinkQuietly(lockFile);
}

function unlinkQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Raced with the owner releasing it; either way it is gone.
  }
}

/** How long the lock FILE has existed, independent of what it claims. */
function lockAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * @returns {any | null} null when absent, empty or unparseable
 *
 * `token` is OPTIONAL. A lock written by a deck from before tokens existed
 * is a real lock with a real owner, and treating it as unreadable made it
 * look like a lock mid-initialisation - so a stale one could never be
 * broken. Such a lock is identified by pid and timestamp instead.
 */
function readLock(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Are these the same lock? Token when there is one, pid+timestamp when not. */
function sameLock(a, b) {
  if (!a || !b) return false;
  if (a.token || b.token) return a.token === b.token;
  return a.pid === b.pid && a.at === b.at;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
