import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import YAML from 'yaml';
import { DECK_BIN, DECK_HOME, rm, tempDir } from '../helpers.js';
import { buildFixture, fixtureSlots } from '../fixtures/full-deck/build.mjs';
import { occupancyOf, trailingGapOf } from '../../src/lint/rules/occupancy.js';

process.env.DECK_HOME = DECK_HOME;

/**
 * THE FIXTURE DECK IS THE GOLDEN FILE.
 *
 * test/fixtures/ was empty. Nothing in this repository rendered a deck that
 * used the slots the themes declare, and that is exactly how `standard-3col`
 * shipped three slot coordinates - col-N-art at top: 277 - that sat inside
 * the card body box and could not be used at all. The PO found it by building
 * a real deck and measuring 38 collisions, and then gave up on the theme's
 * own flagship layout.
 *
 * The PO's note on this is the reason the file exists: item 2 above "would
 * have failed in your own tests if this existed". So this test renders one
 * page of EVERY implemented page type with EVERY slot filled, and requires
 * the whole thing to lint clean.
 *
 * It is slow - a full render of eleven pages through Chrome - and it is worth
 * it, because it is the only test that answers "does the thing this theme
 * says it can do actually work".
 */

let W = null;

before(() => {
  const root = tempDir('fixture-deck');
  const state = tempDir('fixture-state');
  const dir = path.join(root, 'deck');
  buildFixture(dir, { deckBin: DECK_BIN });
  const run = (args) => {
    try {
      const stdout = execFileSync(DECK_BIN, ['gate', ...args], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, DECK_STATE_ROOT: state },
      });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };
  W = {
    root, state, dir, run, cleanup: () => { rm(root); rm(state); },
  };
  assert.equal(W.run(['validate']).code, 0, 'the fixture deck must validate');
  assert.equal(W.run(['render']).code, 0, 'the fixture deck must render');
});

after(() => { if (W) W.cleanup(); });

test('THE FIXTURE DECK LINTS CLEAN - no blocking findings of any rule', () => {
  const r = W.run(['lint']);
  const report = JSON.parse(fs.readFileSync(path.join(W.dir, 'out', 'lint', 'report.json'), 'utf8'));
  const blocking = report.findings.filter((f) => f.severity === 'fail' || f.severity === 'unsupported');
  assert.deepEqual(
    blocking.map((f) => `${f.rule} ${f.slide} ${f.element || ''}`.trim()),
    [],
    'the documented example of every page type must not itself violate a rule',
  );
  assert.equal(report.verdict, 'pass');
  assert.equal(r.code, 0);
});

test('THE FLAGSHIP LAYOUT WORKS: a picture above each of three columns', () => {
  // THE BUG THIS EXISTS FOR. The theme declared col-N-art at an absolute
  // top: 277, inside the card body box, and the cards are flow content that
  // does not wrap around an absolutely positioned box. Every one of the three
  // collided with its own card.
  const geometry = JSON.parse(fs.readFileSync(path.join(W.dir, 'out', 'geometry.json'), 'utf8'));
  const slide = geometry.slides.find((s) => s.slide_id === 'three-points');
  assert.ok(slide, 'the fixture must carry a three-column slide');

  for (const n of [1, 2, 3]) {
    const art = slide.elements.find((e) => e.id === `card-art-${n}`);
    assert.ok(art, `column ${n} must have an art frame`);
    assert.equal(art.slot, `col-${n}-art`, 'the frame must BE the slot, not a separate box beside it');
    assert.equal(art.slot_state, 'filled');

    // The picture is ABOVE the card's heading, which is the layout the theme
    // describes. A frame that overlapped the text would satisfy "exists".
    const heading = slide.elements.find((e) => e.id === `card-heading-${n}`);
    assert.ok(art.rect.y + art.rect.h <= heading.rect.y + 1,
      `column ${n}: the illustration must sit above the heading, not over it`);
  }

  // And there is exactly ONE box per slot: an earlier fix drew the art twice,
  // once in flow and once absolutely positioned on top of the text.
  for (const n of [1, 2, 3]) {
    const boxes = slide.elements.filter((e) => e.slot === `col-${n}-art`);
    assert.equal(boxes.length, 1, `col-${n}-art must be drawn exactly once`);
  }
});

test('TWO THREE-COLUMN SLIDES EACH GET THEIR OWN SIX... THREE ILLUSTRATIONS', () => {
  // THE BUG THIS EXISTS FOR, and the shape that existed nowhere: the fixture
  // had one slide per page type and the stress harness did too, so nothing
  // ever rendered two slides of a page type that has slots. A deck could carry
  // column art on exactly ONE standard-3col slide. The PO's real deck has
  // four; twelve illustrations could not be imported and four pages shipped as
  // empty frames beside a cover and agenda that had art.
  const geometry = JSON.parse(fs.readFileSync(path.join(W.dir, 'out', 'geometry.json'), 'utf8'));
  const three = geometry.slides.filter((s) => s.page_type === 'standard-3col');
  assert.ok(three.length >= 2, 'the fixture must carry at least two three-column slides');

  for (const s of three) {
    for (const n of [1, 2, 3]) {
      const art = s.elements.find((e) => e.id === `card-art-${n}`);
      assert.equal(art.slot, `col-${n}-art`, `${s.slide_id}: column ${n} must claim its own slot`);
      assert.equal(art.slot_state, 'filled', `${s.slide_id}: column ${n} must have its picture`);
    }
  }

  // AND THEY ARE DIFFERENT PICTURES. Keyed by the bare slot id, both slides
  // would resolve to one asset and the bug would look fixed while every
  // three-column slide in the deck showed the same three images.
  const srcOf = (s, n) => s.images.find((i) => i.deck_id === `card-art-img-${n}`).src;
  for (const n of [1, 2, 3]) {
    const srcs = three.map((s) => srcOf(s, n));
    assert.equal(new Set(srcs).size, three.length,
      `column ${n} resolves to the same file on ${three.length} slides: ${srcs.join(', ')}`);
  }
});

test('THE THEME DECLARES NO SLOT COORDINATES THAT COLLIDE WITH FLOW CONTENT', () => {
  // The general form of the bug, so a future theme cannot reintroduce it: a
  // slot is either positioned by coordinates or laid out by the template, and
  // a slot that declares BOTH is a slot whose two positions can disagree.
  const theme = YAML.parse(fs.readFileSync(path.join(DECK_HOME, 'themes', 'watercolor', 'theme.yaml'), 'utf8'));
  for (const [pageType, geometry] of Object.entries(theme.page_types)) {
    for (const [slotId, g] of Object.entries(geometry.slots || {})) {
      if (!g.flow) continue;
      for (const coord of ['left', 'top', 'right', 'bottom']) {
        assert.equal(g[coord], undefined,
          `${pageType}.slots.${slotId} declares flow: ${g.flow} AND ${coord}: ${g[coord]}. `
          + 'A slot laid out by the template must not also carry coordinates - that is how '
          + 'col-N-art came to ship a top: 277 that was inside the card body.');
      }
    }
  }
});

test('EVERY SLOT THE FIXTURE DECLARES IS FILLED AND MEASURED', () => {
  const geometry = JSON.parse(fs.readFileSync(path.join(W.dir, 'out', 'geometry.json'), 'utf8'));
  const declared = fixtureSlots();
  assert.ok(declared.length >= 6, 'the fixture must exercise every slot the theme declares');

  for (const slot of declared) {
    const slide = geometry.slides.find((s) => s.slide_id === slot.slide);
    const box = slide.elements.find((e) => e.slot === slot.id);
    assert.ok(box, `slot ${slot.id} must be measured on slide ${slot.slide}`);
    assert.equal(box.slot_state, 'filled', `slot ${slot.id} must report itself filled`);
  }
});

test('EVERY SLOT THE THEME DECLARES IS EXERCISED BY THE FIXTURE', () => {
  // The direction that actually catches things: a slot the theme offers and
  // no fixture uses is a slot nobody has ever rendered, which is the state
  // col-N-art was in.
  const theme = YAML.parse(fs.readFileSync(path.join(DECK_HOME, 'themes', 'watercolor', 'theme.yaml'), 'utf8'));
  const used = new Set(fixtureSlots().map((s) => s.id));
  for (const [pageType, geometry] of Object.entries(theme.page_types)) {
    for (const slotId of Object.keys(geometry.slots || {})) {
      assert.ok(used.has(slotId),
        `the watercolor theme declares ${pageType}.slots.${slotId} and no fixture slide uses it. `
        + 'Add it to test/fixtures/full-deck/storyboard.yaml, or remove it from the theme.');
    }
  }
});

test('OCCUPANCY BASELINE: the theme thresholds sit outside what the fixture measures', () => {
  // THE THRESHOLDS ARE MEASURED, NOT CHOSEN. The brief was exact: measure
  // from the fixture, do not pick by feel. This is what keeps that true - it
  // re-measures the fixture and fails if theme.yaml has drifted away from the
  // deck the numbers came from.
  const theme = YAML.parse(fs.readFileSync(path.join(DECK_HOME, 'themes', 'watercolor', 'theme.yaml'), 'utf8'));
  const config = theme.lint.occupancy;
  const geometry = JSON.parse(fs.readFileSync(path.join(W.dir, 'out', 'geometry.json'), 'utf8'));

  for (const slide of geometry.slides) {
    if ((config.exempt || []).includes(slide.page_type)) continue;
    const { ratio } = occupancyOf(slide, config.grid);
    const gap = trailingGapOf(slide);
    assert.ok(ratio >= config.advise_below,
      `occupancy.advise_below is ${config.advise_below} but the fixture's ${slide.slide_id} `
      + `(${slide.page_type}) covers only ${ratio.toFixed(3)}. A threshold above the reference `
      + 'deck reports the reference deck, which means it was not derived from it.');
    assert.ok(gap <= config.trailing_gap_above,
      `occupancy.trailing_gap_above is ${config.trailing_gap_above} but the fixture's `
      + `${slide.slide_id} leaves ${gap.toFixed(3)} of its height empty at the bottom.`);
  }

  // THE EXEMPT TYPES EARN THEIR EXEMPTION. Asserted rather than assumed: if a
  // redesign made the statement page dense, the exemption would be dead
  // weight hiding a real check, and this says so.
  //
  // Measured on COVERAGE, not on the trailing gap. The statement page now
  // carries a conclusion banner - the framing it was missing, and the reason
  // it used to read as a title slide - so its content does reach the foot of
  // the page. What makes it exempt is the generous whitespace the theme
  // describes, which is a coverage property: it is the sparsest page in the
  // deck by a wide margin and every other content page is over 70%.
  const statement = geometry.slides.find((s) => s.page_type === 'statement');
  const statementCoverage = occupancyOf(statement, config.grid).ratio;
  const others = geometry.slides
    .filter((s) => !(config.exempt || []).includes(s.page_type))
    .map((s) => occupancyOf(s, config.grid).ratio);
  assert.ok(statementCoverage < Math.min(...others),
    `the statement page is exempt because its whitespace is the design, but it covers `
    + `${statementCoverage.toFixed(3)} of its region - more than the least-covered page held to the `
    + 'rule. If it stopped being sparse the exemption would be dead weight hiding a real check.');

  // And the whole point: the fixture produces no occupancy finding at all.
  const report = JSON.parse(fs.readFileSync(path.join(W.dir, 'out', 'lint', 'report.json'), 'utf8'));
  assert.deepEqual(report.findings.filter((f) => f.rule === 'occupancy'), []);
});

test('EMPTY SLOTS BLOCK LINT AND REFUSE A RELEASE', () => {
  // The PO's deck: fourteen of fifteen slots empty, lint pass, release render
  // successful. Built here from the same fixture with no pictures imported,
  // which is the only difference between the two states.
  const root = tempDir('fixture-empty');
  const state = tempDir('fixture-empty-state');
  const dir = path.join(root, 'deck');
  try {
    buildFixture(dir, { leaveEmpty: fixtureSlots().map((s) => s.id) });
    const run = (args) => {
      try {
        execFileSync(DECK_BIN, ['gate', ...args], {
          cwd: dir, encoding: 'utf8', env: { ...process.env, DECK_STATE_ROOT: state },
        });
        return { code: 0, out: '' };
      } catch (err) {
        return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
      }
    };
    assert.equal(run(['render']).code, 0, 'a PREVIEW render must still be allowed: the PO has to be able to look');

    assert.equal(run(['lint']).code, 1, 'lint must FAIL on a deck with no pictures in it');
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'lint', 'report.json'), 'utf8'));
    const slotFindings = report.findings.filter((f) => f.rule === 'slot-fill');
    assert.equal(slotFindings.length, fixtureSlots().length);
    assert.ok(slotFindings.every((f) => f.severity === 'fail'));

    // Release: approved content, every gate else clean, still refused.
    assert.equal(run(['approve', 'agenda']).code, 0);
    assert.equal(run(['approve', 'content']).code, 0);
    const rel = run(['render', '--release']);
    assert.equal(rel.code, 1, 'a release with no illustrations in it is not a release');
    assert.match(rel.out, /illustration slot\(s\) are empty/);

    // status carries the count build-cycle prints beside the verdict.
    const st = JSON.parse(execFileSync(DECK_BIN, ['gate', 'status', '--json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, DECK_STATE_ROOT: state },
    }));
    assert.equal(st.slot_fill.empty.length, fixtureSlots().length);
    assert.equal(st.slot_fill.total, fixtureSlots().length);
  } finally {
    rm(root); rm(state);
  }
});
