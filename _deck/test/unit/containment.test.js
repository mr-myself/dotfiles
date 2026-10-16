import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import {
  DECK_BIN, DECK_HOME, fillSlots, rm, tempDir, gateArgs,
} from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;

/**
 * CONTAINMENT AND INTEGRITY, at the command level.
 *
 * deck deletes directories, copies files into them, and publishes hashes it
 * claims describe the bytes it rendered. Each of those was escapable or
 * falsifiable. Every test here asserts on a SENTINEL outside the workspace:
 * it must be unchanged and its contents must not appear in anything deck
 * produced.
 */

function deck(cwd, args, state) {
  try {
    return { code: 0, stdout: execFileSync(DECK_BIN, gateArgs(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECK_STATE_ROOT: state } }), stderr: '' };
  } catch (err) {
    return { code: err.status ?? -1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function workspace() {
  const root = tempDir('deck-contain');
  const state = tempDir('deck-contain-state');
  const dir = path.join(root, 'deck');
  const r = deck(root, ['init', dir], state);
  assert.equal(r.code, 0, r.stderr);
  return { root, dir, state, run: (args) => deck(dir, args, state), cleanup: () => { rm(root); rm(state); } };
}

function tinyPng(file) {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 90; png.data[i + 1] = 140; png.data[i + 2] = 170; png.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

test('A SYMLINKED OUTPUT PARENT DOES NOT GET ITS CHILDREN DELETED', () => {
  // The subtle case: a LEAF symlink is merely unlinked, which is harmless.
  // The damage comes through the PARENT - if `out` is a symlink elsewhere,
  // `out/html` resolves inside that other directory and rm -r deletes a real
  // tree there.
  const w = workspace();
  const victim = tempDir('deck-victim');
  try {
    fs.mkdirSync(path.join(victim, 'html'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'html', 'precious.txt'), 'DO NOT DELETE');
    fs.mkdirSync(path.join(victim, 'png'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'png', 'also-precious.txt'), 'DO NOT DELETE');

    rm(path.join(w.dir, 'out'));
    fs.symlinkSync(victim, path.join(w.dir, 'out'));

    const r = w.run(['render']);
    assert.notEqual(r.code, 0, 'rendering through a symlinked out/ must be refused');

    assert.equal(fs.readFileSync(path.join(victim, 'html', 'precious.txt'), 'utf8'), 'DO NOT DELETE');
    assert.equal(fs.readFileSync(path.join(victim, 'png', 'also-precious.txt'), 'utf8'), 'DO NOT DELETE');
  } finally {
    w.cleanup();
    rm(victim);
  }
});

test('AN ASSET DESTINATION SYMLINK DOES NOT REDIRECT THE COPY', () => {
  const w = workspace();
  const victim = tempDir('deck-victim-assets');
  try {
    const sentinel = path.join(victim, 'target.png');
    fs.writeFileSync(sentinel, 'ORIGINAL SENTINEL CONTENT');

    const src = tinyPng(path.join(w.root, 'from-chatgpt.png'));
    // Pre-create the destination the importer will choose, as a symlink out.
    const digest = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    const dest = path.join(w.dir, 'assets', `cover-cover-art-${digest.slice(0, 12)}.png`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(sentinel, dest);

    const r = w.run(['assets', 'import', 'cover-art', src]);
    // Either refused, or the link was replaced - never written THROUGH.
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'ORIGINAL SENTINEL CONTENT',
      `the file outside the workspace was overwritten (import exited ${r.code})`);
  } finally {
    w.cleanup();
    rm(victim);
  }
});

test('A SYMLINKED assets DIRECTORY IS REFUSED', () => {
  const w = workspace();
  const victim = tempDir('deck-victim-dir');
  try {
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'KEEP');
    rm(path.join(w.dir, 'assets'));
    fs.symlinkSync(victim, path.join(w.dir, 'assets'));
    const src = tinyPng(path.join(w.root, 'art.png'));
    w.run(['assets', 'import', 'cover-art', src]);
    assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'KEEP');
    assert.deepEqual(
      fs.readdirSync(victim).filter((f) => f.endsWith('.png')),
      [],
      'no asset may be written into a directory outside the workspace',
    );
  } finally {
    w.cleanup();
    rm(victim);
  }
});

test('A MANIFEST POINTING OUTSIDE assets/ IS REFUSED, not rendered', () => {
  const w = workspace();
  const victim = tempDir('deck-victim-manifest');
  try {
    const secret = tinyPng(path.join(victim, 'private-photo.png'));
    const digest = createHash('sha256').update(fs.readFileSync(secret)).digest('hex');

    fs.writeFileSync(path.join(w.dir, 'assets', 'manifest.json'), JSON.stringify({
      schema: 'deck.assets/1',
      assets: [{
        slot_id: 'cover-art',
        slide_id: 'cover',
        stored_file: path.relative(w.dir, secret),   // ../../ traversal
        original_path: secret,
        sha256: digest,
        imported_at: new Date().toISOString(),
        brief_digest: 'b'.repeat(64),
        superseded_by: null,
      }],
    }, null, 2));

    const r = w.run(['render']);
    assert.notEqual(r.code, 0, 'a traversing manifest must not render');
    assert.match(r.stderr, /outside the deck workspace|asset problem/);

    // Nothing about the private file may appear in anything deck wrote.
    const geo = path.join(w.dir, 'out', 'geometry.json');
    if (fs.existsSync(geo)) {
      assert.ok(!fs.readFileSync(geo, 'utf8').includes('private-photo'));
    }
  } finally {
    w.cleanup();
    rm(victim);
  }
});

test('A STYLE BRIEF OUTSIDE THE THEME IS REFUSED, so prompts cannot disclose it', () => {
  // `deck prompts` embeds the style brief's CONTENTS into prompts.md, which
  // is material the user pastes into a chat with a third party. A traversing
  // path therefore discloses arbitrary local files with no browser involved.
  const w = workspace();
  const victim = tempDir('deck-victim-brief');
  try {
    const secret = path.join(victim, 'private-notes.txt');
    fs.writeFileSync(secret, 'SECRET-BRIEF-SENTINEL');

    fs.appendFileSync(path.join(w.dir, 'deck.yaml'),
      `\ntheme_overrides:\n  slots:\n    style_brief_file: "${path.relative(path.join(DECK_HOME, 'themes', 'watercolor'), secret)}"\n`);

    const r = w.run(['prompts']);
    assert.notEqual(r.code, 0, 'a traversing style brief must be refused');

    const out = path.join(w.dir, 'out', 'prompts.md');
    if (fs.existsSync(out)) {
      assert.ok(!fs.readFileSync(out, 'utf8').includes('SECRET-BRIEF-SENTINEL'));
    }
    assert.ok(!r.stdout.includes('SECRET-BRIEF-SENTINEL'));
    assert.equal(fs.readFileSync(secret, 'utf8'), 'SECRET-BRIEF-SENTINEL');
  } finally {
    w.cleanup();
    rm(victim);
  }
});

test('MODIFIED ASSET BYTES ARE CAUGHT, so no report states a false hash', () => {
  const w = workspace();
  try {
    const src = tinyPng(path.join(w.root, 'art.png'));
    assert.equal(w.run(['assets', 'import', 'cover-art', src]).code, 0);
    assert.equal(w.run(['render']).code, 0);

    const manifest = JSON.parse(fs.readFileSync(path.join(w.dir, 'assets', 'manifest.json'), 'utf8'));
    const stored = path.join(w.dir, manifest.assets[0].stored_file);
    const recorded = manifest.assets[0].sha256;

    // Change the bytes without touching the manifest.
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 255; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255;
    }
    fs.writeFileSync(stored, PNG.sync.write(png));

    const r = w.run(['render']);
    assert.notEqual(r.code, 0, 'rendering must not publish a hash that does not describe the file');
    assert.match(r.stderr, /has been modified since import/);
    assert.match(r.stderr, new RegExp(recorded.slice(0, 16)));
  } finally {
    w.cleanup();
  }
});

test('A MISSING IMPORTED ASSET IS REPORTED, not silently blank', () => {
  const w = workspace();
  try {
    const src = tinyPng(path.join(w.root, 'art.png'));
    assert.equal(w.run(['assets', 'import', 'cover-art', src]).code, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(w.dir, 'assets', 'manifest.json'), 'utf8'));
    fs.rmSync(path.join(w.dir, manifest.assets[0].stored_file));

    const r = w.run(['render']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /is missing/);
  } finally {
    w.cleanup();
  }
});

test('A CORRUPT MANIFEST IS REPORTED, not treated as an empty one', () => {
  // It used to be read with a helper that returns null on malformed JSON, and
  // the caller substituted an empty manifest: every slot rendered blank and
  // the build reported success.
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.dir, 'assets', 'manifest.json'), '{ this is not json');
    const r = w.run(['render']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not valid JSON/);
    assert.match(r.stderr, /silently treat a corrupt manifest as an empty one/);
  } finally {
    w.cleanup();
  }
});

test('A MANIFEST THAT DOES NOT MATCH ITS SCHEMA IS REFUSED', () => {
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.dir, 'assets', 'manifest.json'), JSON.stringify({
      schema: 'deck.assets/1',
      assets: [{ slot_id: 'cover-art' }],   // missing every required field
    }));
    const r = w.run(['render']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /asset schema/);
  } finally {
    w.cleanup();
  }
});

test('A FAILED COMMAND LEAVES NO PASSING REPORT BEHIND', () => {
  // squad's rule: a crashed run must never be readable as a clean one.
  const w = workspace();
  try {
    // The scaffold reserves a cover-art slot with no picture, which the
    // slot-fill rule blocks on. This test is about a crashed run never being
    // readable as a clean one, so it needs a deck that lints clean first.
    fillSlots(w.dir);
    assert.equal(w.run(['render']).code, 0);
    assert.equal(w.run(['lint']).code, 0);
    const report = path.join(w.dir, 'out', 'lint', 'report.json');
    assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).verdict, 'pass');
    assert.equal(fs.readFileSync(path.join(w.dir, 'out', 'lint', 'report-status.txt'), 'utf8').trim(), '0');

    fs.writeFileSync(path.join(w.dir, 'out', 'geometry.json'), 'not json at all');
    const r = w.run(['lint']);
    assert.notEqual(r.code, 0);

    const after = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(after.process, 'failed', 'the report must say the process failed');
    assert.equal(after.verdict, 'fail', 'a crashed run has no verdict and must never publish "pass"');
    assert.equal(fs.readFileSync(path.join(w.dir, 'out', 'lint', 'report-status.txt'), 'utf8').trim(), '4');
    assert.match(after.summary, /FAILED to complete/);
  } finally {
    w.cleanup();
  }
});

test('A FAILED RENDER PUBLISHES NOTHING AND LEAVES THE PREVIOUS SET INTACT', () => {
  const w = workspace();
  try {
    assert.equal(w.run(['render']).code, 0);
    const pdf = path.join(w.dir, 'out', 'deck.pdf');
    const before = fs.readFileSync(pdf);
    const geoBefore = fs.readFileSync(path.join(w.dir, 'out', 'geometry.json'), 'utf8');

    // A theme override that is refused DURING the render, after staging began.
    fs.appendFileSync(path.join(w.dir, 'deck.yaml'),
      '\ntheme_overrides:\n  page_types:\n    cover:\n      composition: x\n      slots:\n        cover-art:\n          left: "not a number"\n          top: 0\n');
    const r = w.run(['render']);
    assert.notEqual(r.code, 0);

    assert.deepEqual(fs.readFileSync(pdf), before, 'the previous PDF must be untouched');
    assert.equal(fs.readFileSync(path.join(w.dir, 'out', 'geometry.json'), 'utf8'), geoBefore);
    const leftovers = fs.readdirSync(path.join(w.dir, 'out')).filter((f) => f.startsWith('.staging-'));
    assert.deepEqual(leftovers, [], 'a failed render must not leave a staging directory');
  } finally {
    w.cleanup();
  }
});

test('TWO CONCURRENT RENDERS DO NOT INTERLEAVE', async () => {
  const w = workspace();
  try {
    const { paths } = await import('../../src/workspace.js');
    const { acquireRenderLock } = await import('../../src/publish.js');
    const p = paths(fs.realpathSync(w.dir));

    // Hold the lock as if another render were in progress.
    const release = acquireRenderLock(p, 'test');
    try {
      const r = w.run(['render']);
      assert.notEqual(r.code, 0, 'a second render must not run while one holds the lock');
      assert.match(r.stderr, /already writing to this workspace/);
    } finally {
      release();
    }

    // ...and the lock is released, so the next render works.
    assert.equal(w.run(['render']).code, 0);
  } finally {
    w.cleanup();
  }
});

test('A STALE LOCK FROM A DEAD PROCESS IS BROKEN, not honoured forever', async () => {
  const w = workspace();
  try {
    const { paths } = await import('../../src/workspace.js');
    const p = paths(fs.realpathSync(w.dir));
    fs.mkdirSync(p.state, { recursive: true });
    const lock = (at, pid = 999999) => fs.writeFileSync(path.join(p.state, 'render.lock'),
      JSON.stringify({ pid, token: 'stale-token', what: 'render', at: at.toISOString() }));

    // A VERY RECENT lock from a dead pid is briefly respected. Pids are
    // reused, and a lock written a second ago by a pid that now reads as
    // gone is more likely a race than a crash.
    lock(new Date());
    const fresh = w.run(['render']);
    assert.notEqual(fresh.code, 0, 'a lock written moments ago is not broken immediately');
    assert.match(fresh.stderr, /very recent/);

    // Past the grace, a dead owner's lock IS broken.
    lock(new Date(Date.now() - 60 * 60 * 1000));
    assert.equal(w.run(['render']).code, 0, 'a crashed render must not wedge the workspace');
  } finally {
    w.cleanup();
  }
});

test('A LOCK HELD BY A LIVE PROCESS IS NEVER BROKEN, however old', async () => {
  // The previous rule broke any lock older than 30 minutes regardless of
  // liveness, so a long render could have its output stolen by a second
  // process. Reproduced by the reviewer.
  const w = workspace();
  try {
    const { paths } = await import('../../src/workspace.js');
    const p = paths(fs.realpathSync(w.dir));
    fs.mkdirSync(p.state, { recursive: true });
    fs.writeFileSync(path.join(p.state, 'render.lock'), JSON.stringify({
      pid: process.pid,                      // this test runner: definitely alive
      token: 'live-token',
      what: 'a very long render',
      at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    }));
    const r = w.run(['render']);
    assert.notEqual(r.code, 0, 'a live owner keeps its lock at any age');
    assert.match(r.stderr, /already writing to this workspace/);
    assert.match(r.stderr, /will not break a lock whose owner is still running/);
    // ...and the lock is still there.
    assert.ok(fs.existsSync(path.join(p.state, 'render.lock')));
  } finally {
    w.cleanup();
  }
});

test('A LOCK IS NOT STOLEN DURING ITS CREATION WINDOW', async () => {
  // Between O_EXCL creation and writing the payload the file is empty.
  // Another process read it, called it invalid, unlinked it and took its
  // own lock - two successful acquisitions, and the first one's release then
  // deleted the second's lock.
  const w = workspace();
  try {
    const { paths } = await import('../../src/workspace.js');
    const p = paths(fs.realpathSync(w.dir));
    fs.mkdirSync(p.state, { recursive: true });
    fs.writeFileSync(path.join(p.state, 'render.lock'), '');   // mid-initialisation
    const r = w.run(['render']);
    assert.notEqual(r.code, 0, 'an empty lock is initialising, not invalid');
    assert.match(r.stderr, /starting up/);
    assert.ok(fs.existsSync(path.join(p.state, 'render.lock')), 'it must not be unlinked');
  } finally {
    w.cleanup();
  }
});

test('RELEASING DOES NOT DELETE A LOCK THAT IS NO LONGER OURS', async () => {
  const w = workspace();
  try {
    const { paths } = await import('../../src/workspace.js');
    const { acquireRenderLock } = await import('../../src/publish.js');
    const p = paths(fs.realpathSync(w.dir));
    const release = acquireRenderLock(p, 'mine');
    const lockFile = path.join(p.state, 'render.lock');
    // The lock changes hands behind our back.
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: 4242, token: 'someone-else', what: 'theirs', at: new Date().toISOString(),
    }));
    release();
    assert.ok(fs.existsSync(lockFile), 'our release must not delete another holder\'s lock');
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'someone-else');
  } finally {
    w.cleanup();
  }
});


// ---------------------------------------------------------------------------
// T16: SENTINELS. Every test here asserts that a file outside the workspace
// is unchanged and that its contents appear in nothing deck produced.
// ---------------------------------------------------------------------------

test('SWEEPING STAGES DOES NOT REACH THROUGH A SYMLINKED out/', () => {
  // sweepStages ran BEFORE the render checked out/, so a symlinked out/ let
  // it recursively delete external .staging-* and .replaced-* directories
  // older than an hour - cleanup reaching outside the workspace before
  // anything had checked the workspace at all.
  const w = workspace();
  const victim = tempDir('sweep-victim');
  try {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    for (const name of ['.staging-1-1', '.replaced-1-1']) {
      const d = path.join(victim, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'precious.txt'), 'DO NOT DELETE');
      fs.utimesSync(d, old, old);
    }
    rm(path.join(w.dir, 'out'));
    fs.symlinkSync(victim, path.join(w.dir, 'out'));

    const r = w.run(['render']);
    assert.notEqual(r.code, 0);
    for (const name of ['.staging-1-1', '.replaced-1-1']) {
      assert.ok(fs.existsSync(path.join(victim, name, 'precious.txt')),
        `${name} outside the workspace was deleted by the sweep`);
    }
  } finally {
    w.cleanup(); rm(victim);
  }
});

test('A FAILURE REPORT IS NOT WRITTEN THROUGH A SYMLINKED out/', () => {
  // The render was refused BECAUSE out/ escapes the workspace, and the
  // failure report was then written through that very symlink.
  const w = workspace();
  const victim = tempDir('report-victim');
  try {
    fs.writeFileSync(path.join(victim, 'marker.txt'), 'UNTOUCHED');
    rm(path.join(w.dir, 'out'));
    fs.symlinkSync(victim, path.join(w.dir, 'out'));

    const r = w.run(['render']);
    assert.notEqual(r.code, 0);
    assert.equal(fs.readFileSync(path.join(victim, 'marker.txt'), 'utf8'), 'UNTOUCHED');
    assert.deepEqual(
      fs.readdirSync(victim).filter((f) => f.endsWith('.json') || f.endsWith('-status.txt')),
      [],
      'no report may be written outside the workspace',
    );
  } finally {
    w.cleanup(); rm(victim);
  }
});

test('A SYMLINKED assets/ IS REFUSED DURING RENDERING, not followed', () => {
  // assets/ was trusted as the containment root without checking that it is
  // itself inside the workspace, so an external symlink let every manifest
  // entry resolve outside - with verify:true and a matching hash, because
  // the hash describes whatever is actually there.
  const w = workspace();
  const victim = tempDir('assets-victim');
  try {
    const secret = path.join(victim, 'private.png');
    tinyPng(secret);
    const digest = createHash('sha256').update(fs.readFileSync(secret)).digest('hex');

    rm(path.join(w.dir, 'assets'));
    fs.symlinkSync(victim, path.join(w.dir, 'assets'));
    fs.writeFileSync(path.join(victim, 'manifest.json'), JSON.stringify({
      schema: 'deck.assets/1',
      assets: [{
        slot_id: 'cover-art', slide_id: 'cover', stored_file: 'assets/private.png',
        original_path: secret, sha256: digest, imported_at: new Date().toISOString(),
        brief_digest: 'b'.repeat(64), superseded_by: null,
      }],
    }));

    const r = w.run(['render']);
    assert.notEqual(r.code, 0, 'a symlinked assets root must be refused');
    assert.match(r.stderr, /outside the deck workspace/);

    const geo = path.join(w.dir, 'out', 'geometry.json');
    if (fs.existsSync(geo)) {
      assert.ok(!fs.readFileSync(geo, 'utf8').includes('private.png'),
        'no external image may reach the geometry');
    }
  } finally {
    w.cleanup(); rm(victim);
  }
});

test('A HARD-LINKED ASSET DESTINATION IS NOT WRITTEN THROUGH', () => {
  // assertInside sees an ordinary in-workspace path; it cannot see that the
  // inode is shared with a file outside. copyFileSync writes through the
  // inode and modifies that outside file.
  const w = workspace();
  const victim = tempDir('hardlink-victim');
  try {
    const external = path.join(victim, 'external.png');
    fs.writeFileSync(external, 'EXTERNAL SENTINEL');

    const src = tinyPng(path.join(w.root, 'incoming.png'));
    const digest = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    const dest = path.join(w.dir, 'assets', `cover-cover-art-${digest.slice(0, 12)}.png`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.linkSync(external, dest);   // same inode, in-workspace path

    assert.equal(w.run(['assets', 'import', 'cover-art', src]).code, 0);
    assert.equal(fs.readFileSync(external, 'utf8'), 'EXTERNAL SENTINEL',
      'the hard-linked file outside the workspace was overwritten');
    // ...and the import really did land.
    assert.equal(createHash('sha256').update(fs.readFileSync(dest)).digest('hex'), digest);
  } finally {
    w.cleanup(); rm(victim);
  }
});

test('A PRE-PLANTED TEMP SYMLINK DOES NOT REDIRECT A REPORT WRITE', () => {
  const w = workspace();
  const victim = tempDir('temp-victim');
  try {
    const target = path.join(victim, 'target.txt');
    fs.writeFileSync(target, 'TEMP SENTINEL');
    fs.mkdirSync(path.join(w.dir, 'out'), { recursive: true });
    // The OLD predictable temp name writeAtomic used.
    fs.symlinkSync(target, path.join(w.dir, 'out', `validate.json.tmp-${process.pid}-0`));

    assert.equal(w.run(['validate']).code, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'TEMP SENTINEL',
      'a planted temp symlink redirected the write');
    assert.ok(fs.existsSync(path.join(w.dir, 'out', 'validate.json')));
  } finally {
    w.cleanup(); rm(victim);
  }
});
