import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DECK_BIN, DECK_HOME, rm, tempDir, gateArgs } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const { briefDigest, resolveAssets } = await import('../../src/deck.js');
const { sha256File } = await import('../../src/util/fs.js');

/** A 2x2 PNG, written byte-for-byte so its hash is stable across runs. */
function tinyPng(file, tint = 0) {
  const { PNG } = require_pngjs();
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10 + tint; png.data[i + 1] = 20; png.data[i + 2] = 30; png.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}
let _png = null;
function require_pngjs() {
  if (!_png) throw new Error('pngjs not preloaded');
  return _png;
}
_png = await import('pngjs');

/** Run the deck CLI in a workspace, returning {code, stdout, stderr}. */
function deck(cwd, args, env = {}) {
  try {
    const stdout = execFileSync(DECK_BIN, gateArgs(args), {
      cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

/** The brief the scaffolded storyboard gives its one slot. */
const SCAFFOLD_BRIEF = '資料の主題を表す水彩イラスト。文字は一切入れない。';

/** A workspace with one slot, straight from `deck init`. */
function workspace() {
  const root = tempDir('deck-assets');
  const dir = path.join(root, 'deck');
  const state = tempDir('deck-assets-state');
  const r = deck(root, ['init', dir], { DECK_STATE_ROOT: state });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(
    fs.readFileSync(path.join(dir, 'storyboard.yaml'), 'utf8').includes(SCAFFOLD_BRIEF),
    'the scaffold brief these tests edit must be present verbatim',
  );
  return {
    root,
    dir,
    state,
    deck: (args) => deck(dir, args, { DECK_STATE_ROOT: state }),
    /** @param {string} from @param {string} to */
    edit(from, to) {
      const file = path.join(dir, 'storyboard.yaml');
      const before = fs.readFileSync(file, 'utf8');
      assert.ok(before.includes(from), `storyboard.yaml does not contain: ${from}`);
      fs.writeFileSync(file, before.replace(from, to));
    },
  };
}

test('import copies the file, records its hash, and NEVER touches the original', () => {
  const w = workspace();
  try {
    const src = tinyPng(path.join(w.root, 'from-chatgpt.png'));
    const before = sha256File(src);
    const beforeStat = fs.statSync(src);

    const r = w.deck(['assets', 'import', 'cover-art', src]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(before));
    assert.match(r.stdout, /The original file was not modified/);

    assert.equal(sha256File(src), before, 'the PO\'s file must be byte-identical afterwards');
    assert.equal(fs.statSync(src).mtimeMs, beforeStat.mtimeMs);

    const manifest = JSON.parse(fs.readFileSync(path.join(w.dir, 'assets', 'manifest.json'), 'utf8'));
    assert.equal(manifest.assets.length, 1);
    const entry = manifest.assets[0];
    assert.equal(entry.sha256, before);
    // QUALIFIED. The manifest records the pair, because `col-1-art` names a
    // position every three-column slide has - a bare id in here capped a deck
    // at one standard-3col slide with column art.
    assert.equal(entry.slot_id, 'cover:cover-art');
    assert.equal(entry.slide_id, 'cover');
    assert.equal(entry.original_path, src);
    assert.ok(Date.parse(entry.imported_at) > 0);
    // The stored copy is the same bytes.
    assert.equal(sha256File(path.join(w.dir, entry.stored_file)), before);
  } finally {
    rm(w.root); rm(w.state);
  }
});

test('MANIFEST ENTRIES ARE APPENDED, never edited, so a slot keeps its history', () => {
  const w = workspace();
  try {
    const a = tinyPng(path.join(w.root, 'first.png'), 0);
    const b = tinyPng(path.join(w.root, 'second.png'), 50);
    assert.equal(w.deck(['assets', 'import', 'cover-art', a]).code, 0);
    assert.equal(w.deck(['assets', 'import', 'cover-art', b]).code, 0);

    const manifest = JSON.parse(fs.readFileSync(path.join(w.dir, 'assets', 'manifest.json'), 'utf8'));
    assert.equal(manifest.assets.length, 2, 'the first import must survive');
    assert.equal(manifest.assets[0].sha256, sha256File(a));
    assert.ok(manifest.assets[0].superseded_by, 'the older entry is marked superseded');
    assert.equal(manifest.assets[1].superseded_by, null);
    // Both files remain on disk; nothing the PO handed over is deleted.
    assert.equal(fs.existsSync(path.join(w.dir, manifest.assets[0].stored_file)), true);
  } finally {
    rm(w.root); rm(w.state);
  }
});

test('AN IMPORTED ASSET IS REUSED WHEN ITS CONTAINER MOVES OR RESIZES', () => {
  const w = workspace();
  try {
    const src = tinyPng(path.join(w.root, 'art.png'));
    assert.equal(w.deck(['assets', 'import', 'cover-art', src]).code, 0);

    // Resize the slot. The brief is untouched, so the asset stays current.
    w.edit('width_px: 760', 'width_px: 600');
    w.edit('height_px: 941', 'height_px: 500');

    const list = w.deck(['assets', 'list', '--json']);
    assert.equal(list.code, 0, list.stderr);
    const rows = JSON.parse(list.stdout).assets;
    assert.equal(rows[0].filled, true);
    assert.equal(rows[0].stale, false, 'a resized container must not re-request the illustration');
    assert.equal(rows[0].sha256, sha256File(src));
  } finally {
    rm(w.root); rm(w.state);
  }
});

test('a MATERIALLY CHANGED BRIEF marks the asset stale and re-requests it', () => {
  const w = workspace();
  try {
    const src = tinyPng(path.join(w.root, 'art.png'));
    assert.equal(w.deck(['assets', 'import', 'cover-art', src]).code, 0);

    w.edit(SCAFFOLD_BRIEF, 'まったく別の題材。文字は一切入れない。');

    const rows = JSON.parse(w.deck(['assets', 'list', '--json']).stdout).assets;
    assert.equal(rows[0].stale, true);

    const prompts = w.deck(['prompts']);
    assert.equal(prompts.code, 0, prompts.stderr);
    assert.match(prompts.stdout, /brief has CHANGED|needs re-requesting/);
  } finally {
    rm(w.root); rm(w.state);
  }
});

test('the brief digest ignores geometry entirely', () => {
  const base = { id: 's', brief: 'a village', width_px: 100, height_px: 100 };
  assert.equal(briefDigest(base), briefDigest({ ...base, width_px: 4000, height_px: 1 }));
  assert.notEqual(briefDigest(base), briefDigest({ ...base, brief: 'a town' }));
  assert.notEqual(briefDigest(base), briefDigest({ ...base, reuse_unchanged: true }));
});

test('importing into an unknown slot is a usage error that lists the real slots', () => {
  const w = workspace();
  try {
    const src = tinyPng(path.join(w.root, 'art.png'));
    const r = w.deck(['assets', 'import', 'no-such-slot', src]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /has no slot "no-such-slot"/);
    assert.match(r.stderr, /cover-art/);
  } finally {
    rm(w.root); rm(w.state);
  }
});

test('importing a missing file, or a file type deck cannot place, is refused', () => {
  const w = workspace();
  try {
    const missing = w.deck(['assets', 'import', 'cover-art', path.join(w.root, 'nope.png')]);
    assert.equal(missing.code, 3);
    assert.match(missing.stderr, /no such file/);

    const txt = path.join(w.root, 'notes.txt');
    fs.writeFileSync(txt, 'hello');
    const wrong = w.deck(['assets', 'import', 'cover-art', txt]);
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /does not know how to place a "\.txt" file/);
  } finally {
    rm(w.root); rm(w.state);
  }
});

test('resolveAssets skips an entry whose stored file has vanished', () => {
  const manifest = {
    schema: 'deck.assets/1',
    assets: [{
      slot_id: 'art', slide_id: 'a', stored_file: 'assets/gone.png', original_path: '/x.png',
      sha256: 'a'.repeat(64), imported_at: new Date().toISOString(), brief_digest: 'b'.repeat(64),
      superseded_by: null,
    }],
  };
  const sb = { slides: [{ id: 'a', slots: [{ id: 'art', brief: 'x' }] }] };
  assert.deepEqual(resolveAssets('/nowhere', manifest, sb), {});
});
