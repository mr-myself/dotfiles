import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DECK_HOME, rm, tempDir } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const { missingGlyphs, readCoverage } = await import('../../src/font/cmap.js');

/**
 * MALFORMED FONTS ARE UNTRUSTED INPUT.
 *
 * A theme ships its own font AND its own recorded hash, so hash verification
 * proves the file is the one the theme intended and says nothing about
 * whether it is well formed. These build fonts by hand and assert that deck
 * refuses or bounds them, under an explicit time and memory budget.
 */

const BUDGET_MS = 2000;
const BUDGET_MB = 200;

/**
 * Build a minimal sfnt with one format-12 cmap containing the given groups.
 * @param {{start: number, end: number, gid?: number}[]} groups
 */
function fontWithFormat12(groups, { declaredGroups = null } = {}) {
  const size = 68 + Math.max(0, groups.length - 1) * 12;
  const b = Buffer.alloc(size);
  b.writeUInt32BE(0x00010000, 0);
  b.writeUInt16BE(1, 4);
  b.write('cmap', 12, 'latin1');
  b.writeUInt32BE(28, 20);
  b.writeUInt32BE(size - 28, 24);
  b.writeUInt16BE(0, 28);
  b.writeUInt16BE(1, 30);
  b.writeUInt16BE(3, 32);
  b.writeUInt16BE(10, 34);
  b.writeUInt32BE(12, 36);
  b.writeUInt16BE(12, 40);
  b.writeUInt16BE(0, 42);
  b.writeUInt32BE(size - 40, 44);
  b.writeUInt32BE(0, 48);
  // `declaredGroups` lets a test claim more groups than the file can hold.
  b.writeUInt32BE(declaredGroups ?? groups.length, 52);
  groups.forEach((g, i) => {
    const o = 56 + i * 12;
    b.writeUInt32BE(g.start, o);
    b.writeUInt32BE(g.end, o + 4);
    b.writeUInt32BE(g.gid ?? 1, o + 8);
  });
  return b;
}

/** Write a font to a temp file and run `fn` against it under a budget. */
function underBudget(buf, fn) {
  const dir = tempDir('deck-font');
  const file = path.join(dir, 'probe.ttf');
  fs.writeFileSync(file, buf);
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const started = Date.now();
  try {
    const result = fn(file);
    const elapsed = Date.now() - started;
    const grewMb = (process.memoryUsage().heapUsed - before) / 1e6;
    return { result, error: null, elapsed, grewMb, file };
  } catch (err) {
    return { result: null, error: err, elapsed: Date.now() - started, grewMb: 0, file };
  } finally {
    rm(dir);
  }
}

test('A 68-BYTE FONT DECLARING 1..0xFFFFFFFF DOES NOT EXHAUST MEMORY', () => {
  // Reproduced by review, and confirmed here before the fix: this used to
  // expand codepoint by codepoint into a Set until Node threw "Set maximum
  // size exceeded", after seconds and hundreds of megabytes.
  const buf = fontWithFormat12([{ start: 1, end: 0xffffffff }]);
  assert.equal(buf.length, 68, 'the probe really is 68 bytes');

  const { result, error, elapsed, grewMb } = underBudget(buf, readCoverage);
  assert.equal(error, null, error ? `threw: ${error.message}` : '');
  assert.ok(elapsed < BUDGET_MS, `took ${elapsed} ms, budget ${BUDGET_MS} ms`);
  assert.ok(grewMb < BUDGET_MB, `grew the heap by ${grewMb.toFixed(1)} MB, budget ${BUDGET_MB} MB`);

  // Coverage is kept as RANGES, so the declared width costs nothing.
  assert.equal(result.ranges.length, 1);
  // ...and is CLAMPED to Unicode: nothing above U+10FFFF can be a character.
  assert.equal(result.ranges[0].end, 0x10ffff);
  assert.ok(result.has(0x3042), 'lookup still works');
  assert.equal(result.has(0x110000), false, 'nothing past the Unicode maximum is covered');
});

test('a group starting past the Unicode maximum is dropped', () => {
  const { result, error } = underBudget(
    fontWithFormat12([{ start: 0x200000, end: 0x300000 }]),
    readCoverage,
  );
  assert.equal(error, null);
  assert.equal(result.size, 0);
});

test('OVERLAPPING AND ADJACENT GROUPS ARE MERGED, so repetition costs nothing', () => {
  const groups = [
    { start: 0x3040, end: 0x30ff },
    { start: 0x3050, end: 0x3100 },  // overlaps the first
    { start: 0x3101, end: 0x3110 },  // adjacent to the merged range
    { start: 0x4e00, end: 0x4e10 },  // separate
  ];
  const { result, error } = underBudget(fontWithFormat12(groups), readCoverage);
  assert.equal(error, null);
  assert.equal(result.ranges.length, 2, JSON.stringify(result.ranges));
  assert.deepEqual(result.ranges[0], { start: 0x3040, end: 0x3110 });
  assert.ok(result.has(0x3045) && result.has(0x3105) && result.has(0x4e05));
  assert.equal(result.has(0x3200), false);
});

test('a font claiming more groups than it can hold is REFUSED', () => {
  const { error } = underBudget(
    fontWithFormat12([{ start: 1, end: 2 }], { declaredGroups: 100000 }),
    readCoverage,
  );
  assert.ok(error, 'a font that lies about its own size must not be parsed');
  assert.match(error.message, /declares 100000 groups but the file holds room for/);
});

test('a reversed group (end before start) is dropped rather than looping', () => {
  const { result, error, elapsed } = underBudget(
    fontWithFormat12([{ start: 0x5000, end: 0x1000 }, { start: 0x3042, end: 0x3043 }]),
    readCoverage,
  );
  assert.equal(error, null);
  assert.ok(elapsed < BUDGET_MS);
  assert.equal(result.size, 2);
});

test('a truncated font is refused with a clear message, not a RangeError', () => {
  for (const [label, buf] of [
    ['empty', Buffer.alloc(0)],
    ['header only', Buffer.alloc(12)],
    ['cmap pointing past the end', (() => {
      const b = Buffer.alloc(40);
      b.writeUInt32BE(0x00010000, 0);
      b.writeUInt16BE(1, 4);
      b.write('cmap', 12, 'latin1');
      b.writeUInt32BE(9999, 20);
      b.writeUInt32BE(100, 24);
      return b;
    })()],
  ]) {
    const { error } = underBudget(buf, readCoverage);
    assert.ok(error, `${label}: expected a refusal`);
    assert.ok(!/Attempt to access memory outside|out of range/i.test(error.message)
      || /points outside the file/.test(error.message),
    `${label}: should be a deck message, got: ${error.message}`);
  }
});

test('a TrueType collection is refused by name rather than misparsed', () => {
  const b = Buffer.alloc(64);
  b.write('ttcf', 0, 'latin1');
  const { error } = underBudget(b, readCoverage);
  assert.ok(error);
  assert.match(error.message, /collections \(\.ttc\) are not supported/);
});

test('the REAL pinned font still parses correctly and quickly', () => {
  const file = path.join(DECK_HOME, 'themes', 'watercolor', 'fonts', 'NotoSansJP-Variable.ttf');
  const started = Date.now();
  const cov = readCoverage(file);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < BUDGET_MS, `took ${elapsed} ms`);
  assert.ok(cov.size > 16000, `only ${cov.size} codepoints`);
  assert.ok(cov.ranges.length > 100);
  // The deck's real characters, and a glyph it genuinely lacks.
  assert.deepEqual(missingGlyphs(cov, '温泉　滞在体験のご提案 05/23 回 ①②③ ー—〜'), []);
  assert.equal(missingGlyphs(cov, '\u{1f3d4}').length, 1);
});


// ---------------------------------------------------------------------------
// T18: FORMAT 4, the BMP branch. The round-1 fix bounded format 12 only.
// A 262 KB synthetic font induced over two billion iterations, ~1.3 s,
// because each segment was walked codepoint by codepoint before any merging.
// ---------------------------------------------------------------------------

/**
 * Build a format-4 cmap.
 * @param {{start: number, end: number}[]} segments
 * @param {{declaredLength?: number, segCountX2?: number}} [broken]
 */
function fontWithFormat4(segments, broken = {}) {
  const segCount = segments.length;
  const segX2 = segCount * 2;
  const sub = 14 + segX2 * 4 + 2;
  const b = Buffer.alloc(40 + sub + 16);
  b.writeUInt32BE(0x00010000, 0);
  b.writeUInt16BE(1, 4);
  b.write('cmap', 12, 'latin1');
  b.writeUInt32BE(28, 20);
  b.writeUInt32BE(sub + 12, 24);
  b.writeUInt16BE(0, 28);
  b.writeUInt16BE(1, 30);
  b.writeUInt16BE(3, 32);
  b.writeUInt16BE(1, 34);
  b.writeUInt32BE(12, 36);
  const o = 40;
  b.writeUInt16BE(4, o);
  b.writeUInt16BE(broken.declaredLength ?? sub, o + 2);
  b.writeUInt16BE(0, o + 4);
  b.writeUInt16BE(broken.segCountX2 ?? segX2, o + 6);
  const END = o + 14;
  const START = END + segX2 + 2;
  const DELTA = START + segX2;
  const RANGE = DELTA + segX2;
  segments.forEach((seg, i) => {
    b.writeUInt16BE(seg.end, END + i * 2);
    b.writeUInt16BE(seg.start, START + i * 2);
    b.writeInt16BE(1, DELTA + i * 2);
    b.writeUInt16BE(0, RANGE + i * 2);
  });
  return b;
}

test('MAXIMAL OVERLAPPING FORMAT-4 SEGMENTS ARE REFUSED, not walked', () => {
  // 2000 segments each spanning the whole BMP: 131 million codepoints if
  // walked, and the reviewer's larger font reached two billion.
  const segments = Array.from({ length: 2000 }, () => ({ start: 0x0000, end: 0xfffe }));
  const { error, elapsed, grewMb } = underBudget(fontWithFormat4(segments), readCoverage);
  assert.ok(error, 'overlapping segments must be refused');
  assert.match(error.message, /overlapping or out of order/);
  assert.ok(elapsed < BUDGET_MS, `took ${elapsed} ms`);
  assert.ok(grewMb < BUDGET_MB, `grew the heap by ${grewMb.toFixed(1)} MB`);
});

test('OUT-OF-ORDER format-4 segments are refused', () => {
  const { error } = underBudget(fontWithFormat4([
    { start: 0x3000, end: 0x30ff },
    { start: 0x1000, end: 0x10ff },   // earlier than the one before it
  ]), readCoverage);
  assert.ok(error);
  assert.match(error.message, /overlapping or out of order/);
});

test('a format-4 segment that runs backwards is refused', () => {
  const { error } = underBudget(fontWithFormat4([{ start: 0x5000, end: 0x1000 }]), readCoverage);
  assert.ok(error);
  assert.match(error.message, /runs backwards/);
});

test('a format-4 subtable that lies about its LENGTH is refused', () => {
  const { error } = underBudget(
    fontWithFormat4([{ start: 0x30, end: 0x40 }], { declaredLength: 65535 }),
    readCoverage,
  );
  assert.ok(error);
  assert.match(error.message, /declares a length of 65535 bytes/);
});

test('a format-4 subtable with an odd segCountX2 is refused', () => {
  const { error } = underBudget(
    fontWithFormat4([{ start: 0x30, end: 0x40 }], { segCountX2: 3 }),
    readCoverage,
  );
  assert.ok(error);
  assert.match(error.message, /odd segCountX2/);
});

test('THE AGGREGATE FORMAT-4 WORK IS BOUNDED even when every segment is legal', () => {
  // Disjoint, sorted, in order - so no individual rule rejects them - but
  // there are a great many. The total codepoints a BMP table can cover is
  // 65536, and exceeding that is itself the signal.
  // 8000 disjoint two-codepoint segments, well inside uint16 range.
  const segments = [];
  for (let i = 0; i < 8000; i += 1) {
    const start = i * 4;
    if (start + 1 > 0xfffe) break;
    segments.push({ start, end: start + 1 });
  }
  assert.ok(segments.length > 7000, `built ${segments.length} segments`);
  const { result, error, elapsed, grewMb } = underBudget(fontWithFormat4(segments), readCoverage);
  assert.ok(elapsed < BUDGET_MS, `took ${elapsed} ms for ${segments.length} segments`);
  assert.ok(grewMb < BUDGET_MB, `grew the heap by ${grewMb.toFixed(1)} MB`);
  if (!error) {
    assert.ok(result.size <= 0x10000, `covered ${result.size} codepoints, more than the BMP holds`);
  }
});

test('a WELL-FORMED format-4 font still parses correctly', () => {
  const segments = [
    { start: 0x0020, end: 0x007e },   // ASCII
    { start: 0x3040, end: 0x309f },   // hiragana
    { start: 0x30a0, end: 0x30ff },   // katakana
  ];
  const { result, error } = underBudget(fontWithFormat4(segments), readCoverage);
  assert.equal(error, null, error ? error.message : '');
  // The last two segments are adjacent and merge into one range.
  assert.equal(result.ranges.length, 2, JSON.stringify(result.ranges));
  assert.equal(result.size, (0x7e - 0x20 + 1) + (0x30ff - 0x3040 + 1));
  assert.ok(result.has(0x3042), 'hiragana A');
  assert.ok(result.has(0x30a2), 'katakana A');
  assert.equal(result.has(0x4e00), false, 'a kanji it does not declare');
  assert.deepEqual(missingGlyphs(result, 'あイA'), []);
});
