import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DECK_HOME, theme as loadTheme } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const T = await loadTheme();
const {
  resolveAssets, resolveSlotRef, slotBriefs, slotFileToken, slotFillState, slotKey, validateSemantics,
} = await import('../../src/deck.js');
const { filenameFor } = await import('../../src/commands/prompts.js');

/**
 * A SLOT'S IDENTITY IS (SLIDE, SLOT ID).
 *
 * From the field, on a real deck with four standard-3col slides. `col-1-art`
 * names the first column's picture - a POSITION on a page type - and the
 * uniqueness rule treated it as a name for one picture in the whole deck. The
 * consequence was that a deck could carry column art on exactly one
 * three-column slide; twelve illustrations could not be imported and four
 * pages shipped as empty frames beside a cover and agenda that had art.
 *
 * The PO's note on why that matters more than it sounds is the reason these
 * tests exist at all: the theme's claim that an empty frame "reads as a
 * reserved space rather than a rendering fault" only holds when NOTHING in
 * the deck is filled. Mixed with real pictures, an empty frame reads as a
 * broken image.
 */

const CARDS = {
  kind: 'cards',
  cards: [
    { heading: 'ひとつめ', body: '短い本文。', icon: 'teal' },
    { heading: 'ふたつめ', body: '短い本文。', icon: 'orange' },
    { heading: 'みっつめ', body: '短い本文。', icon: 'teal' },
  ],
};

/** A standard-3col slide declaring all three column slots. */
function threeCol(id) {
  return {
    id,
    page_type: 'standard-3col',
    purpose: '検証',
    section_label: '検証',
    title: `${id} の三点`,
    subtitle: null,
    body: [CARDS],
    slots: [1, 2, 3].map((n) => ({
      id: `col-${n}-art`, brief: `${id} の ${n} 枚目。文字は入れない。`, width_px: 474, height_px: 210,
    })),
  };
}

const TWO = { schema: 'deck.storyboard/1', title: 't', slides: [threeCol('alpha'), threeCol('beta')] };

// ---------------------------------------------------------------------------
// The bug.
// ---------------------------------------------------------------------------

test('TWO standard-3col SLIDES MAY BOTH CARRY COLUMN ART', () => {
  // Before: three `duplicate slot id` problems, and no spelling worked.
  // Per-slide ids were refused as unknown to the theme, and aliases added
  // through theme_overrides passed validate and then rendered NOTHING,
  // because the template resolved every slide to the first alias.
  assert.deepEqual(validateSemantics(TWO, T), []);
});

test('...and four of them, which is what the real deck had', () => {
  const four = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: ['a', 'b', 'c', 'd'].map(threeCol),
  };
  assert.deepEqual(validateSemantics(four, T), []);
  assert.equal(Object.keys(slotBriefs(four)).length, 12,
    'twelve distinct slots - one per column per slide');
});

test('A SLIDE STILL MAY NOT DECLARE ONE ID TWICE', () => {
  // Across slides an id repeats because it names a position. Within one slide
  // two boxes claiming the same position is a storyboard that cannot be drawn.
  const dup = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{
      ...threeCol('alpha'),
      slots: [
        { id: 'col-1-art', brief: 'a', width_px: 474, height_px: 210 },
        { id: 'col-1-art', brief: 'b', width_px: 474, height_px: 210 },
      ],
    }],
  };
  const problems = validateSemantics(dup, T);
  assert.equal(problems.length, 1, problems.join('; '));
  assert.match(problems[0], /declares slot "col-1-art" twice/);
  assert.match(problems[0], /unique within a slide/);
});

test('OTHER PAGE TYPES HAD THE SAME CEILING, by construction', () => {
  // Any page type whose theme slots are fixed ids had it. A real deck has
  // three or four chapter dividers, and every diagram page type gained a
  // reserved art band in the round before this one.
  const slides = [
    ...[1, 2, 3].map((n) => ({
      id: `ch-0${n}`,
      page_type: 'section-divider',
      purpose: '章',
      section_label: '検証',
      title: `第${n}章`,
      subtitle: null,
      slots: [{ id: 'divider-art', brief: '扉絵。', width_px: 700, height_px: 941 }],
    })),
    ...['x', 'y'].map((k) => ({
      id: `cmp-${k}`,
      page_type: 'comparison',
      purpose: '比較',
      section_label: '検証',
      title: '比較',
      subtitle: null,
      comparison: {
        axes: ['費用'],
        columns: [{ label: 'A', cells: ['高い'] }, { label: 'B', cells: ['安い'] }],
        note: null,
      },
      slots: [{ id: 'comparison-art', brief: '帯。', width_px: 1562, height_px: 220 }],
    })),
  ];
  assert.deepEqual(validateSemantics({ schema: 'deck.storyboard/1', title: 't', slides }, T), []);
});

// ---------------------------------------------------------------------------
// The four id-consuming paths agree.
// ---------------------------------------------------------------------------

test('THE KEY AND THE FILENAME TOKEN ARE FORMED IN ONE PLACE EACH', () => {
  assert.equal(slotKey('decided', 'col-1-art'), 'decided:col-1-art');
  assert.equal(slotFileToken('decided', 'col-1-art'), 'decided-col-1-art');
  // The separator cannot occur in either half - both ids are matched against
  // ^[a-z0-9][a-z0-9-]{0,62}$ - so the key is unambiguous. The filename uses a
  // hyphen because a colon in a filename needs quoting in every shell and
  // Finder renders it as a slash.
  assert.ok(!slotKey('a', 'b').includes('-'));
  assert.ok(!slotFileToken('a', 'b').includes(':'));
});

test('PROMPTS NAMES THE FILE AFTER THE SLIDE AND THE SLOT', () => {
  // The PO asked for exactly this: 04-decided-col-1-art.png. Without the
  // slide id, a deck with four three-column slides asks for twelve files
  // under four distinct names and `inbox` is reduced to guessing.
  assert.equal(filenameFor({ id: 'decided' }, { id: 'col-1-art' }, 4), '04-decided-col-1-art.png');
  const names = TWO.slides.flatMap((s, i) => s.slots.map((sl, j) => filenameFor(s, sl, i * 3 + j + 1)));
  assert.equal(new Set(names).size, 6, 'six slots, six distinct filenames');
});

test('A BARE ID RESOLVES WHEN ONE SLIDE HAS IT, and is REFUSED when two do', () => {
  // `deck gate assets import cover-art <file>` must keep working - that is
  // most decks, and the PO has one on disk. Where it is ambiguous, choosing
  // for the author puts an illustration on the wrong page, which renders
  // cleanly and which no rule here can see.
  const mixed = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [
      {
        id: 'cover',
        page_type: 'cover',
        purpose: 'p',
        title: 'T',
        slots: [{ id: 'cover-art', brief: 'b', width_px: 760, height_px: 941 }],
      },
      ...TWO.slides,
    ],
  };
  const unique = resolveSlotRef(mixed, 'cover-art');
  assert.equal(unique.key, 'cover:cover-art');

  const ambiguous = resolveSlotRef(mixed, 'col-1-art');
  assert.deepEqual(ambiguous.ambiguous, ['alpha:col-1-art', 'beta:col-1-art']);

  // And the qualified form always resolves, ambiguity or not.
  assert.equal(resolveSlotRef(mixed, 'beta:col-1-art').key, 'beta:col-1-art');
  assert.equal(resolveSlotRef(mixed, 'nope'), null);
});

// ---------------------------------------------------------------------------
// The deck already on the PO's disk keeps working.
// ---------------------------------------------------------------------------

test('A MANIFEST WRITTEN WITH BARE SLOT IDS STILL RESOLVES', () => {
  // Entries predating this change carry a bare id, and a bare id was required
  // to be unique then - so every one of them resolves. Needing a re-import to
  // open an existing deck would be a worse bug than the one being fixed.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-manifest-'));
  try {
    const storyboard = {
      schema: 'deck.storyboard/1',
      title: 't',
      slides: [{
        id: 'cover',
        page_type: 'cover',
        purpose: 'p',
        title: 'T',
        slots: [{ id: 'cover-art', brief: 'b', width_px: 760, height_px: 941 }],
      }],
    };
    fs.mkdirSync(path.join(root, 'assets'));
    const file = path.join(root, 'assets', 'cover-art-abc.png');
    fs.writeFileSync(file, 'x');
    const manifest = {
      schema: 'deck.assets/1',
      assets: [{
        slot_id: 'cover-art',
        slide_id: 'cover',
        stored_file: 'assets/cover-art-abc.png',
        sha256: 'f'.repeat(64),
        brief_digest: '0'.repeat(64),
      }],
    };
    const resolved = resolveAssets(root, manifest, storyboard);
    assert.ok(resolved['cover:cover-art'],
      'a bare slot_id must resolve to the qualified key the renderer looks up');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AN AMBIGUOUS MANIFEST ENTRY IS REPORTED, NOT GUESSED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ambiguous-manifest-'));
  try {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets', 'x.png'), 'x');
    const resolved = resolveAssets(root, {
      schema: 'deck.assets/1',
      assets: [{
        slot_id: 'col-1-art',
        slide_id: 'alpha',
        stored_file: 'assets/x.png',
        sha256: 'f'.repeat(64),
        brief_digest: '0'.repeat(64),
      }],
    }, TWO);
    const problems = resolved.__problems || [];
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /2 slides have a slot with that id/);
    assert.match(problems[0], /alpha:col-1-art, beta:col-1-art/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// slot-fill counts both slides.
// ---------------------------------------------------------------------------

test('SLOT FILL COUNTS EVERY SLIDE\'S SLOTS SEPARATELY', () => {
  // Keyed by the bare id, one filled col-1-art would have marked both slides'
  // first columns filled - the deck would report six of six with three
  // pictures in it.
  const half = { 'alpha:col-1-art': {}, 'alpha:col-2-art': {}, 'alpha:col-3-art': {} };
  const state = slotFillState(TWO, half);
  assert.equal(state.total, 6);
  assert.deepEqual(
    state.empty.map((e) => `${e.slide}:${e.slot}`),
    ['beta:col-1-art', 'beta:col-2-art', 'beta:col-3-art'],
  );
});

// ---------------------------------------------------------------------------
// An unreadable file is not an illustration.
// ---------------------------------------------------------------------------

test('A 0-BYTE OR NON-PNG FILE IS REFUSED BY import, and leaves nothing behind', async () => {
  // From the same report: two empty PNGs from a failed ChatGPT download were
  // imported in silence and recorded with the SHA-256 of the empty string,
  // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855. The slot
  // then counted as FILLED - so slot-fill passed, `render --release` was
  // allowed, and the page shipped with nothing in the frame.
  //
  // The gate was already reading the PNG header to report the pixel size next
  // to what the slot asked for; it simply never acted on what it read.
  //
  // `inbox` goes through this same command, so refusing here covers both
  // paths - which is why there is no second check in intake.js.
  const { execFileSync } = await import('node:child_process');
  const { DECK_BIN } = await import('../helpers.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-import-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-import-state-'));
  const dir = path.join(root, 'deck');
  try {
    const run = (args) => {
      try {
        return { code: 0, out: execFileSync(DECK_BIN, ['gate', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, DECK_STATE_ROOT: state } }) };
      } catch (err) {
        return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
      }
    };
    execFileSync(DECK_BIN, ['gate', 'init', dir], { cwd: root, stdio: 'pipe', env: { ...process.env, DECK_STATE_ROOT: state } });

    const empty = path.join(root, 'empty.png');
    fs.writeFileSync(empty, '');
    const r1 = run(['assets', 'import', 'cover-art', empty]);
    assert.notEqual(r1.code, 0, 'a 0-byte file must not import');
    assert.match(r1.out, /empty \(0 bytes\)/);

    const fake = path.join(root, 'fake.png');
    fs.writeFileSync(fake, 'this is text, not a PNG');
    const r2 = run(['assets', 'import', 'cover-art', fake]);
    assert.notEqual(r2.code, 0, 'a .png that is not a PNG must not import');
    assert.match(r2.out, /not a PNG/);

    // NOTHING IS LEFT IN assets/. A refusal that still copies the file leaves
    // a slot that looks filled on disk and empty in the manifest.
    const stored = fs.readdirSync(path.join(dir, 'assets')).filter((f) => f !== 'manifest.json');
    assert.deepEqual(stored, [], `assets/ should hold no image, found ${stored.join(', ')}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'assets', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.assets, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});
