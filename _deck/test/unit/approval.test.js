import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DECK_HOME, rm, storyboard, tempDir } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const { agendaDigest, canonicalJson, contentDigest, contentProjection, describeContentChanges } = await import('../../src/digest.js');
const { approve, approvalState, releaseGate } = await import('../../src/approvals.js');
const { paths } = await import('../../src/workspace.js');

/** A fresh approvals directory. */
function workspace() {
  const dir = tempDir('deck-approval');
  fs.mkdirSync(path.join(dir, '.deck', 'approvals'), { recursive: true });
  return { dir, p: paths(dir) };
}

const BASE = storyboard({
  slides: [
    { id: 'a', page_type: 'cover', purpose: 'p', title: '一枚目', subtitle: null },
    { id: 'b', page_type: 'statement', purpose: 'p', title: '二枚目', subtitle: 'sub' },
  ],
});

/** @param {(s: any) => void} mutate */
function variant(mutate) {
  const copy = JSON.parse(JSON.stringify(BASE));
  mutate(copy);
  return copy;
}

test('the digest is over a CANONICAL projection, so key order cannot move it', () => {
  const reordered = {
    slides: BASE.slides.map((s) => ({ subtitle: s.subtitle, purpose: s.purpose, title: s.title, page_type: s.page_type, id: s.id })),
    title: BASE.title,
    schema: BASE.schema,
  };
  assert.equal(contentDigest(BASE), contentDigest(reordered));
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

test('changing one character of a title changes the content digest', () => {
  assert.notEqual(contentDigest(BASE), contentDigest(variant((s) => { s.slides[0].title = '一枚目。'; })));
});

test('back-filling a `subtitle: null` invalidates content approval', () => {
  // `subtitle: null` means an INTENTIONALLY ABSENT subtitle. Adding one later
  // is a content change and must be caught.
  const filled = variant((s) => { s.slides[0].subtitle = 'added later'; });
  assert.notEqual(contentDigest(BASE), contentDigest(filled));
  const changes = describeContentChanges(contentProjection(BASE), contentProjection(filled));
  assert.ok(changes.some((c) => /slide a: subtitle changed/.test(c)), changes.join('\n'));
});

test('reordering slides invalidates BOTH digests', () => {
  const swapped = variant((s) => { s.slides.reverse(); });
  assert.notEqual(contentDigest(BASE), contentDigest(swapped));
  assert.notEqual(agendaDigest(BASE), agendaDigest(swapped));
});

test('adding a slide invalidates BOTH digests', () => {
  const added = variant((s) => { s.slides.push({ id: 'c', page_type: 'statement', purpose: 'p', title: 'c' }); });
  assert.notEqual(contentDigest(BASE), contentDigest(added));
  assert.notEqual(agendaDigest(BASE), agendaDigest(added));
});

test('changing only body wording leaves the AGENDA digest intact', () => {
  // The agenda signs off the spine; the content signs off the words. Changing
  // a subtitle must not invalidate an agenda approval, or the two approvals
  // would be the same approval.
  const reworded = variant((s) => { s.slides[1].subtitle = 'different wording'; });
  assert.equal(agendaDigest(BASE), agendaDigest(reworded));
  assert.notEqual(contentDigest(BASE), contentDigest(reworded));
});

test('AGENDA WORDING, COUNT AND ORDER ARE SIGNED CONTENT', () => {
  // Reproduced by review: agenda was omitted from the content projection, so
  // rewording, inserting, deleting or reordering an item - or moving which
  // one is active - left the digest unchanged and `--release` shipped words
  // nobody had approved. Agenda items are verbatim text on a slide exactly as
  // a title is.
  const withAgenda = variant((s) => {
    s.slides[1] = {
      id: 'b',
      page_type: 'agenda',
      purpose: 'p',
      title: '目次',
      subtitle: null,
      agenda: { items: ['現状の整理', 'ご提案の内容', '次のステップ'], active: 1 },
    };
  });
  const base = contentDigest(withAgenda);

  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(withAgenda));
    fn(copy.slides[1].agenda);
    return copy;
  };

  for (const [what, fn] of [
    ['reworded', (a) => { a.items[0] = 'まったく別の項目'; }],
    ['one character', (a) => { a.items[0] = '現状の整理。'; }],
    ['inserted', (a) => { a.items.splice(1, 0, '追加された項目'); }],
    ['deleted', (a) => { a.items.splice(1, 1); }],
    ['reordered', (a) => { a.items.reverse(); }],
    ['active moved', (a) => { a.active = 3; }],
  ]) {
    assert.notEqual(contentDigest(mutate(fn)), base, `an agenda ${what} must invalidate content approval`);
  }

  // ...and the change is NAMED, not merely detected.
  const changes = describeContentChanges(
    contentProjection(withAgenda),
    contentProjection(mutate((a) => { a.items[0] = '別の項目'; })),
  );
  assert.ok(changes.some((c) => /slide b: agenda changed/.test(c)), changes.join('\n'));
});

test('an agenda edit also fails the RELEASE GATE with the field named', () => {
  const { dir, p } = workspace();
  try {
    const withAgenda = variant((s) => {
      s.slides[1] = {
        id: 'b', page_type: 'agenda', purpose: 'p', title: '目次', subtitle: null,
        agenda: { items: ['一', '二'], active: 1 },
      };
    });
    approve(p, 'content', withAgenda);
    assert.deepEqual(releaseGate(p, withAgenda), { ok: true });

    const edited = JSON.parse(JSON.stringify(withAgenda));
    edited.slides[1].agenda.items[1] = '三';
    const gate = releaseGate(p, edited);
    assert.equal(gate.ok, false);
    assert.match(gate.details.join('\n'), /agenda changed/);
  } finally {
    rm(dir);
  }
});

test('a changed slot BRIEF is a content change; a resized slot is not', () => {
  const withSlot = variant((s) => {
    s.slides[0].slots = [{ id: 'art', brief: 'a village', width_px: 100, height_px: 100 }];
  });
  const resized = JSON.parse(JSON.stringify(withSlot));
  resized.slides[0].slots[0].width_px = 900;
  assert.equal(contentDigest(withSlot), contentDigest(resized),
    'moving or resizing a container must not invalidate approved content');

  const rebriefed = JSON.parse(JSON.stringify(withSlot));
  rebriefed.slides[0].slots[0].brief = 'a different village';
  assert.notEqual(contentDigest(withSlot), contentDigest(rebriefed));
});

test('approve records the exact revision, with a timestamp', () => {
  const { dir, p } = workspace();
  try {
    const record = approve(p, 'content', BASE);
    assert.equal(record.digest, contentDigest(BASE));
    assert.ok(Date.parse(record.approved_at) > 0);
    assert.deepEqual(record.slide_ids, ['a', 'b']);
    assert.ok(fs.existsSync(path.join(p.approvals, 'content.json')));
  } finally {
    rm(dir);
  }
});

test('approvalState sees a match, then a mismatch with a described change', () => {
  const { dir, p } = workspace();
  try {
    approve(p, 'content', BASE);
    const fresh = approvalState(p, 'content', BASE);
    assert.equal(fresh.approved, true);
    assert.equal(fresh.matches, true);
    assert.deepEqual(fresh.changes, []);

    const changed = variant((s) => { s.slides[1].title = '別の見出し'; });
    const stale = approvalState(p, 'content', changed);
    assert.equal(stale.matches, false);
    assert.ok(stale.changes.some((c) => /slide b: title changed/.test(c)), stale.changes.join('\n'));
  } finally {
    rm(dir);
  }
});

test('the release gate refuses an UNAPPROVED deck and says what to do', () => {
  const { dir, p } = workspace();
  try {
    const gate = releaseGate(p, BASE);
    assert.equal(gate.ok, false);
    assert.match(gate.message, /never been approved/);
    assert.ok(gate.details.join(' ').includes('deck approve content'));
    // The preview path must stay open; the gate is only consulted by --release.
    assert.ok(gate.details.join(' ').includes('preview'));
  } finally {
    rm(dir);
  }
});

test('the release gate refuses a STALE approval and names the field that moved', () => {
  const { dir, p } = workspace();
  try {
    approve(p, 'content', BASE);
    const changed = variant((s) => { s.slides[0].title = '書き換えた'; });
    const gate = releaseGate(p, changed);
    assert.equal(gate.ok, false);
    assert.match(gate.message, /no longer matches the approved content/);
    const text = gate.details.join('\n');
    assert.match(text, /slide a: title changed/);
    assert.match(text, /一枚目/);
    assert.match(text, /書き換えた/);
  } finally {
    rm(dir);
  }
});

test('the release gate passes on the exact approved revision', () => {
  const { dir, p } = workspace();
  try {
    approve(p, 'content', BASE);
    assert.deepEqual(releaseGate(p, BASE), { ok: true });
  } finally {
    rm(dir);
  }
});

test('a STALE CANDIDATE HASH from an older approval is reported, not silently matched', () => {
  const { dir, p } = workspace();
  try {
    // An approval written by an older deck: right shape, no projection to
    // diff against. It must still refuse, and must say it cannot explain why.
    fs.writeFileSync(path.join(p.approvals, 'content.json'), JSON.stringify({
      schema: 'deck.approval/1',
      kind: 'content',
      digest: 'f'.repeat(64),
      approved_at: '2026-01-01T00:00:00.000Z',
      slide_count: 2,
      slide_ids: ['a', 'b'],
      projection: null,
    }));
    const state = approvalState(p, 'content', BASE);
    assert.equal(state.matches, false);
    assert.match(state.changes.join('\n'), /carries no comparable projection/);
    const gate = releaseGate(p, BASE);
    assert.equal(gate.ok, false);
  } finally {
    rm(dir);
  }
});

test('approving the agenda does not approve the content', () => {
  const { dir, p } = workspace();
  try {
    approve(p, 'agenda', BASE);
    assert.equal(approvalState(p, 'agenda', BASE).matches, true);
    assert.equal(approvalState(p, 'content', BASE).approved, false);
    assert.equal(releaseGate(p, BASE).ok, false);
  } finally {
    rm(dir);
  }
});
