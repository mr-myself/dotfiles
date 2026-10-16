import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { DECK_HOME, element, measuredSlide, rect, theme as loadTheme } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const T = await loadTheme();
const { validateSemantics } = await import('../../src/deck.js');
const { RULES } = await import('../../src/lint/engine.js');
const { contentIntegrityRule } = await import('../../src/lint/rules/content-integrity.js');
const { overflowRule } = await import('../../src/lint/rules/overflow.js');
const { safeMarginsRule } = await import('../../src/lint/rules/safe-margins.js');

/**
 * CAPACITY, AND THE REPORTING OF WHAT WILL NOT FIT.
 *
 * From a stress harness that fed every page type content shaped unlike the
 * fixture's: every count at the schema's declared caps, and every text field a
 * long Japanese sentence. It produced 925 blocking findings and a cover whose
 * subtitle was visibly cut off mid-sentence.
 *
 * Isolating the two dimensions is what found the actual cause. Counts at the
 * caps with SHORT text still gave 178 findings - so "lengths are unbounded
 * while counts are bounded" was not the story. The dimensions that broke were
 * exactly the ones with no declared bound at all.
 */

// ---------------------------------------------------------------------------
// The root cause: declared capacity vs page capacity.
// ---------------------------------------------------------------------------

function slide(patch) {
  return {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{
      id: 's', purpose: 'p', section_label: '検証', subtitle: null, ...patch,
    }],
  };
}

test('CAPACITY: a count the page cannot lay out is refused BEFORE anything renders', () => {
  // The schema permits any number of agenda items; the page holds seven. That
  // used to render, and then report 25 geometry findings about where the rows
  // had landed - effects, in pixels, of one authoring decision.
  const problems = validateSemantics(slide({
    page_type: 'agenda',
    title: '目次',
    agenda: { items: Array.from({ length: 9 }, (_, i) => `項目${i + 1}`), active: 1 },
  }), T);
  assert.equal(problems.length, 1, problems.join('; '));
  assert.match(problems[0], /agenda\.items has 9 entries/);
  assert.match(problems[0], /at most 7/);
  // The remedy is the design kit's, and the three things it forbids are named
  // so that nobody resolves an overflow by quietly deleting a line.
  assert.match(problems[0], /Split it across two slides/);
  assert.match(problems[0], /無断要約/);
});

test('CAPACITY: at the limit it passes, so the cap is a boundary and not a mood', () => {
  assert.deepEqual(validateSemantics(slide({
    page_type: 'agenda',
    title: '目次',
    agenda: { items: Array.from({ length: 7 }, (_, i) => `項目${i + 1}`), active: 1 },
  }), T), []);
});

test('CAPACITY: a footer banner costs one row, and the limit knows it', () => {
  // MEASURED, and only found because a realistic mid-sized deck failed on a
  // six-row table that was under the plain cap of seven: the banner takes
  // 92 px off the bottom of the page and a row is about 90.
  const rows = Array.from({ length: 7 }, (_, i) => [`値${i + 1}`, 'あ', 'い']);
  const table = {
    columns: [{ heading: '列1' }, { heading: '列2' }, { heading: '列3' }],
    rows,
    note: null,
  };
  assert.deepEqual(
    validateSemantics(slide({ page_type: 'table', title: '表', table }), T), [],
    'seven rows fit on a table page with no banner',
  );
  const withFooter = validateSemantics(slide({
    page_type: 'table', title: '表', table, footer: { label: 'ご判断', text: '短い' },
  }), T);
  assert.equal(withFooter.length, 1, withFooter.join('; '));
  assert.match(withFooter[0], /at most 6/);
  assert.match(withFooter[0], /footer banner/);
  assert.match(withFooter[0], /7 without one/);
});

test('CAPACITY: a page type the theme declares nothing for is not held to another\'s', () => {
  // Every dimension that HAS a schema maxItems holds at its cap - measured by
  // rendering a deck built exactly on them. Those stay in the schema, which
  // says what is MEANINGFUL; the theme says what FITS, and only where it was
  // measured. An undeclared dimension is left alone rather than guessed at.
  const themeWithout = { ...T, page_types: { ...T.page_types, agenda: { composition: 'x' } } };
  assert.deepEqual(validateSemantics(slide({
    page_type: 'agenda',
    title: '目次',
    agenda: { items: Array.from({ length: 30 }, (_, i) => `項目${i + 1}`), active: 1 },
  }), themeWithout), []);
});

test('CAPACITY: the theme declares no limit it did not measure', () => {
  // test/fixtures and the sweeps behind these numbers are in the theme's own
  // comments. A limit with no measurement behind it is the defect this whole
  // mechanism exists to end, so the shape is checked rather than trusted.
  const themeFile = YAML.parse(
    fs.readFileSync(path.join(DECK_HOME, 'themes', 'watercolor', 'theme.yaml'), 'utf8'),
  );
  for (const [pageType, geometry] of Object.entries(themeFile.page_types)) {
    for (const [dimension, declared] of Object.entries(geometry.capacity || {})) {
      const limits = typeof declared === 'number' ? { max: declared } : declared;
      assert.ok(Number.isFinite(limits.max) && limits.max > 0,
        `${pageType}.capacity.${dimension} must declare a positive max`);
      if (limits.max_with_footer !== undefined) {
        assert.ok(limits.max_with_footer > 0 && limits.max_with_footer <= limits.max,
          `${pageType}.capacity.${dimension}: max_with_footer must not exceed max`);
      }
      assert.match(dimension, /^[a-z_]+(\.[a-z_]+)+$/,
        `${pageType}.capacity.${dimension} must be a dotted path into the slide`);
    }
  }
});

// ---------------------------------------------------------------------------
// The words that reached the page.
// ---------------------------------------------------------------------------

/** A measured slide whose field wraps to `lines` lines, `off` of them past the paper. */
function wrapped(text, lines, off, { fontSize = 32, lineHeight = 49 } = {}) {
  const per = Math.ceil(text.length / lines);
  const canvasH = 941;
  const top = canvasH - (lines - off) * lineHeight;
  return measuredSlide({
    slide_id: 's',
    regions: { canvas: rect(0, 0, 1672, canvasH), 'content-region': rect(60, 42, 1562, 864) },
    elements: [element({
      id: 'subtitle',
      role: 'subtitle',
      tag: 'p',
      own_text: true,
      text,
      rect: rect(60, top, 800, lines * lineHeight),
      content_union: rect(60, top, 800, lines * lineHeight),
      style: { font_size_px: fontSize, font_family: 'x' },
      text_lines: Array.from({ length: lines }, (_, i) => ({
        ...rect(60, top + i * lineHeight, 800, lineHeight),
        text: text.slice(i * per, (i + 1) * per),
      })),
    })],
  });
}

const STORY = (text) => ({ slides: [{ id: 's', page_type: 'cover', subtitle: text }] });

test('CONTENT-INTEGRITY: characters laid out past the paper edge are NAMED', () => {
  // THE QUESTION THIS ANSWERS. A cover subtitle was visibly cut off mid-
  // sentence on a rendered page and this rule reported nothing, because every
  // check it made was satisfied: the element existed, was visible, had a
  // painted box, had text lines, and `el.text` - which is textContent, and
  // retains every character of a line typeset below the paper - contained the
  // storyboard's string.
  const text = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも';
  const found = contentIntegrityRule({
    slides: [wrapped(text, 4, 2)],
    storyboard: STORY(text),
  });
  assert.equal(found.length, 1, JSON.stringify(found.map((f) => f.message)));
  assert.equal(found[0].rule, 'content-integrity');
  // The last two lines' worth of characters, and nothing else.
  assert.equal(found[0].measured.missing, text.slice(18));
  assert.match(found[0].message, /NOT ON THE PAGE/);
});

test('CONTENT-INTEGRITY: a field that fits entirely is silent', () => {
  const text = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも';
  assert.deepEqual(
    contentIntegrityRule({ slides: [wrapped(text, 4, 0)], storyboard: STORY(text) }),
    [],
  );
});

test('CONTENT-INTEGRITY: the font\'s leading is not mistaken for a lost line', () => {
  // The trap in both directions. A line box carries the font's reserved space
  // above and below the glyphs - here 8.5 px of the 49 - so a last line whose
  // BOX pokes a few px past the paper is still perfectly readable, and calling
  // it missing would be the most alarming false alarm this rule could raise.
  // Testing the line's centre instead goes wrong the other way and was
  // measured doing so: a line with its lower half off the paper, visibly
  // chopped, counted as delivered. The glyph band is the thing compared.
  const text = 'あいうえおかきくけこさしすせそたちつてと';
  const s = wrapped(text, 2, 0);
  const last = s.elements[0].text_lines[1];
  // Push the last line's BOX 6 px past the paper; its glyph band (inset by
  // 8.5 px of leading) is still inside.
  const overhang = 941 - (last.y + last.h) + 6;
  s.elements[0].text_lines[1] = { ...last, y: last.y + overhang };
  assert.deepEqual(
    contentIntegrityRule({ slides: [s], storyboard: STORY(text) }), [],
    'leading past the paper is not ink past the paper',
  );

  // ...and 20 px past, where the glyphs really do leave, IS reported.
  s.elements[0].text_lines[1] = { ...last, y: last.y + overhang + 14 };
  assert.equal(contentIntegrityRule({ slides: [s], storyboard: STORY(text) }).length, 1);
});

// ---------------------------------------------------------------------------
// One defect, one finding.
// ---------------------------------------------------------------------------

test('OVERFLOW: a clipped line is reported against the element that OWNS the text', () => {
  // text_lines walks the subtree, so a <td>'s clipped line is also a line of
  // its <tr>, of the <table> and of every wrapper above. Each one reported it:
  // one over-long table produced 236 findings across 93 elements, of which 78
  // came from the <table> alone. The element an author can act on is the one
  // that owns the text.
  const line = { ...rect(60, 960, 400, 40), text: 'こぼれた行' };
  const slides = [measuredSlide({
    regions: { canvas: rect(0, 0, 1672, 941), 'content-region': rect(60, 42, 1562, 864) },
    elements: [
      element({
        id: 'wrapper', tag: 'div', own_text: false, rect: rect(60, 900, 400, 100), text_lines: [line],
      }),
      element({
        id: 'cell', tag: 'td', own_text: true, rect: rect(60, 960, 400, 40), text_lines: [line],
      }),
    ],
  })];
  const found = overflowRule({ slides, theme: T });
  const offCanvas = found.filter((f) => /fall outside the canvas/.test(f.message));
  assert.deepEqual(offCanvas.map((f) => f.element), ['cell'],
    'only the element that owns the text reports its line');
});

test('OVERFLOW: every lost line of one element is ONE finding, with all of them as evidence', () => {
  // Per-line reporting made a single over-long comparison cell five findings.
  // The defect is "this element does not fit", which is fixed once.
  const lines = [0, 1, 2, 3].map((i) => ({
    ...rect(60, 960 + i * 40, 400, 40), text: `行${i + 1}`,
  }));
  const found = overflowRule({
    slides: [measuredSlide({
      regions: { canvas: rect(0, 0, 1672, 941), 'content-region': rect(60, 42, 1562, 864) },
      elements: [element({
        id: 'cell', tag: 'td', own_text: true, rect: rect(60, 960, 400, 160), text_lines: lines,
      })],
    })],
    theme: T,
  });
  const offCanvas = found.filter((f) => /fall outside the canvas/.test(f.message));
  assert.equal(offCanvas.length, 1);
  assert.equal(offCanvas[0].measured.lines_lost, 4);
  assert.equal(offCanvas[0].measured.lines.length, 4, 'every lost line is still in the evidence');
});

test('SAFE-MARGINS: a container past the margin only because its content is, is not a second finding', () => {
  // 29 of 126 findings on a heavy page were ancestors repeating a
  // descendant's breach.
  const slides = [measuredSlide({
    regions: { canvas: rect(0, 0, 1672, 941), 'content-region': rect(60, 42, 1562, 864) },
    elements: [
      element({ id: 'table', tag: 'table', rect: rect(60, 400, 1000, 600), content_union: rect(60, 400, 1000, 600) }),
      element({
        id: 'row', tag: 'tr', ancestry: ['table'], rect: rect(60, 940, 1000, 60), content_union: rect(60, 940, 1000, 60),
      }),
    ],
  })];
  const found = safeMarginsRule({ slides, theme: T }).filter((f) => f.severity !== 'suggestion');
  assert.deepEqual(found.map((f) => f.element), ['row'],
    'the innermost offender is the one an author can move');
});

test('SAFE-MARGINS: a container that sticks out FURTHER than its content still reports', () => {
  // "Only because" is the load-bearing phrase. A box that overhangs on its own
  // account is its own defect.
  const slides = [measuredSlide({
    regions: { canvas: rect(0, 0, 1672, 941), 'content-region': rect(60, 42, 1562, 864) },
    elements: [
      element({ id: 'panel', tag: 'div', rect: rect(60, 400, 1000, 700), content_union: rect(60, 400, 1000, 700) }),
      element({
        id: 'child', tag: 'p', ancestry: ['panel'], rect: rect(60, 920, 1000, 40), content_union: rect(60, 920, 1000, 40),
      }),
    ],
  })];
  const found = safeMarginsRule({ slides, theme: T }).filter((f) => f.severity !== 'suggestion');
  assert.deepEqual(found.map((f) => f.element).sort(), ['child', 'panel']);
});

// ---------------------------------------------------------------------------
// The report schema describes the report.
// ---------------------------------------------------------------------------

test('THE LINT REPORT SCHEMA KNOWS EVERY RULE THAT CAN WRITE INTO IT', () => {
  // It was three rules out of date - content-integrity, slot-fill and
  // occupancy - and nothing noticed, because the decks it was validated
  // against happened never to make those rules fire. A deck that did made
  // deck's own report fail its own schema. Asserted against the rule set so
  // the two cannot part company again.
  const schema = JSON.parse(
    fs.readFileSync(path.join(DECK_HOME, 'schemas', 'lint-report.schema.json'), 'utf8'),
  );
  const enumerated = JSON.stringify(schema).match(/"rule":\s*\{[^}]*?"enum":\s*(\[[^\]]*\])/);
  assert.ok(enumerated, 'the schema must enumerate the rule ids');
  assert.deepEqual(
    JSON.parse(enumerated[1]).slice().sort(),
    RULES.map((r) => r.id).slice().sort(),
  );
});
