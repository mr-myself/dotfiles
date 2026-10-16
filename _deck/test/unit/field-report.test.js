import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collisionRule } from '../../src/lint/rules/collision.js';
import {
  isExempt, occupancyOf, occupancyRule, trailingGapOf,
} from '../../src/lint/rules/occupancy.js';
import { repetitionRule } from '../../src/lint/rules/repetition.js';
import { slotFillRule } from '../../src/lint/rules/slot-fill.js';
import { EXAMPLES } from '../../src/commands/schema.js';
import { validate } from '../../src/schema.js';
import { DECK_HOME, element, measuredSlide, rect } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;

/**
 * THE PO'S FIELD REPORT, AS TESTS.
 *
 * Each of these is a case the PO measured while building a real deck end to
 * end, pinned here with their numbers where they gave numbers. The point of
 * using their values rather than convenient ones is that a future change
 * which "fixes" a rule by removing its coverage fails here: several of these
 * assert that a rule still reports a REAL defect of the same shape as the
 * false one it used to report.
 */

// ---------------------------------------------------------------------------
// Item 4: repetition on centred text.
// ---------------------------------------------------------------------------

/** The four chapter subtitles, exactly as the PO measured them. */
const PO_SUBTITLES = [
  ['ch-01', 509.5, 662.98],
  ['ch-02', 541.75, 598.5],
  ['ch-03', 577.86, 526.28],
  ['ch-04', 560.98, 560.03],
];

function centredSubtitles(rows = PO_SUBTITLES) {
  return rows.map(([id, left, width]) => measuredSlide({
    slide_id: id,
    page_type: 'section-divider',
    elements: [element({
      id: 'subtitle',
      role: 'subtitle',
      tag: 'p',
      rect: rect(left, 600, width, 40),
      // A content-sized box: the rect hugs its own ink, which is what makes
      // left and width a function of the string rather than of the design.
      content_union: rect(left, 600, width, 40),
    })],
  }));
}

const REP_THEME = { lint: { repetition_tolerance_px: 1.5, repetition_roles: ['subtitle'] } };

test("REPETITION: the PO's four centred subtitles produce no findings", () => {
  // Ten blocking findings, every one of them wrong, on a deck whose chapter
  // pages were perfectly consistent - and they drowned out the fact that the
  // same deck had no pictures on it and a word split across the paper edge.
  const slides = centredSubtitles();
  const centres = slides.map((s) => s.elements[0].rect.cx);
  assert.deepEqual(
    centres.map((c) => Math.round(c * 100) / 100),
    [840.99, 841, 841, 841],
    'the premise: these four differ by 68 px on the left edge and agree on the centre',
  );
  assert.deepEqual(repetitionRule({ slides, theme: REP_THEME }), []);
});

test('REPETITION: a genuinely mis-centred subtitle is STILL caught', () => {
  // The half that matters. Exempting centred roles from `left` silences the
  // false findings and the true ones together; comparing the centre line
  // keeps the coverage.
  const slides = centredSubtitles();
  slides[2].elements[0] = element({
    id: 'subtitle',
    role: 'subtitle',
    tag: 'p',
    rect: rect(540, 600, 526.28, 40),
    content_union: rect(540, 600, 526.28, 40),
  });
  const found = repetitionRule({ slides, theme: REP_THEME });
  assert.equal(found.length, 1);
  assert.equal(found[0].slide, 'ch-03');
  assert.equal(found[0].axis, 'x');
  assert.match(found[0].message, /horizontal centre line/);
});

test('REPETITION: a LEFT-ALIGNED content-sized role is still compared on its left edge', () => {
  // The other direction. A left-aligned run of text agrees on its left edge
  // and scatters its centre, and the rule must report against the edge - if
  // it always reached for the centre it would just invert the false
  // findings instead of ending them.
  const rows = [['s1', 60, 400], ['s2', 60, 520], ['s3', 60, 300], ['s4', 96, 410]];
  const slides = rows.map(([id, left, width]) => measuredSlide({
    slide_id: id,
    page_type: 'statement',
    elements: [element({
      id: 'note', role: 'subtitle', tag: 'p', rect: rect(left, 600, width, 40), content_union: rect(left, 600, width, 40),
    })],
  }));
  const found = repetitionRule({ slides, theme: REP_THEME });
  assert.equal(found.length, 1, 'exactly the one slide that moved');
  assert.equal(found[0].slide, 's4');
  assert.match(found[0].message, /left edge/);
});

test('REPETITION: a repeated role is measured as a ROW, not as its first member', () => {
  // The PO: comparing card height across slides reports "this slide's body
  // text is longer", which is content. The row's TOP is the design decision.
  const slide = (id, top, heights) => measuredSlide({
    slide_id: id,
    page_type: 'standard-3col',
    elements: heights.map((h, i) => element({
      id: `card-${i + 1}`,
      role: 'card',
      rect: rect(60 + i * 544, top, 474, h),
      content_union: rect(60 + i * 544, top, 474, h),
    })),
  });
  const theme = { lint: { repetition_tolerance_px: 1.5, repetition_roles: ['card'] } };

  // Same row top, wildly different card heights: that is body text, not drift.
  assert.deepEqual(
    repetitionRule({ slides: [slide('a', 300, [250, 180, 310]), slide('b', 300, [140, 400, 200])], theme }),
    [],
  );

  // The row itself moved down 40 px on one slide: that IS drift.
  const found = repetitionRule({
    slides: [slide('a', 300, [250, 180, 310]), slide('b', 300, [250, 180, 310]), slide('c', 340, [250, 180, 310])],
    theme,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].slide, 'c');
  assert.match(found[0].message, /top/);
});

// ---------------------------------------------------------------------------
// Item 5: collision does not detect occlusion.
// ---------------------------------------------------------------------------

test('COLLISION: text under a painted band is reported even where the band has no ink', () => {
  // Reproduced on real hardware before this changed: a table cell plainly
  // washed out in the PNG, 2418 px2 inside the footer banner, and
  // `collision` reported nothing - because the banner's INK is 722 px wide
  // while the band it paints is 1672.
  const banner = element({
    id: 'footer-banner',
    role: 'footer-banner',
    zone: 'footer',
    tag: 'aside',
    paints_background: true,
    rect: rect(0, 819, 1672, 92),
    content_union: rect(60, 834, 722, 62),
  });
  const hidden = element({
    id: 'td-7-3',
    role: 'cell',
    tag: 'td',
    rect: rect(1340, 838, 120, 36),
    content_union: rect(1340, 838, 120, 36),
  });
  const slide = measuredSlide({ elements: [hidden, banner] });

  const found = collisionRule({ slides: [slide], theme: { lint: { collision_min_area_px2: 4 } } });
  assert.equal(found.length, 1);
  assert.match(found[0].message, /paints a surface/);
  assert.ok(found[0].measured.a_paints || found[0].measured.b_paints);
});

test('COLLISION: a band that paints nothing still only collides at its ink', () => {
  // The guard on the fix. Widening EVERY element to its rect would report
  // every flex wrapper against everything it contains - which is the finding
  // the ink comparison was introduced to stop in the first place.
  const wrapper = element({
    id: 'content',
    tag: 'div',
    paints_background: false,
    rect: rect(60, 42, 1562, 864),
    content_union: rect(60, 42, 400, 120),
  });
  const folio = element({
    id: 'page-number', role: 'page-number', zone: 'pagination', rect: rect(1540, 860, 60, 30), content_union: rect(1540, 860, 60, 30),
  });
  const body = element({ id: 'body', tag: 'p', rect: rect(60, 500, 800, 40), content_union: rect(60, 500, 800, 40) });
  const found = collisionRule({
    slides: [measuredSlide({ elements: [wrapper, folio, body] })],
    theme: { lint: { collision_min_area_px2: 4 } },
  });
  assert.deepEqual(found, []);
});

test('COLLISION: a painted band still does not collide with its own children', () => {
  const banner = element({
    id: 'footer-banner', zone: 'footer', paints_background: true, rect: rect(0, 819, 1672, 92), content_union: rect(60, 834, 722, 62),
  });
  const label = element({
    id: 'footer-text',
    zone: 'footer',
    ancestry: ['footer-banner'],
    rect: rect(282, 844, 500, 40),
    content_union: rect(282, 844, 500, 40),
  });
  assert.deepEqual(
    collisionRule({ slides: [measuredSlide({ elements: [banner, label] })], theme: {} }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Item 1: an empty slot must fail something.
// ---------------------------------------------------------------------------

function slotDeck({ state, reuse = false, decorative = false }) {
  const storyboard = {
    slides: [{
      id: 'cover',
      page_type: 'cover',
      slots: [{
        id: 'cover-art', brief: '表紙のイラスト', width_px: 760, height_px: 941, reuse_unchanged: reuse, decorative,
      }],
    }],
  };
  const elements = state === 'absent' ? [] : [element({
    id: 'slot-cover-art', role: 'slot', slot: 'cover-art', slot_state: state, rect: rect(912, 0, 760, 941),
  })];
  return { storyboard, slides: [measuredSlide({ slide_id: 'cover', page_type: 'cover', elements })] };
}

test('SLOT-FILL: an empty slot BLOCKS', () => {
  const found = slotFillRule(slotDeck({ state: 'empty' }));
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'fail');
  assert.match(found[0].message, /is empty/);
  assert.match(found[0].message, /表紙のイラスト/, 'the brief tells the author what to draw');
});

test('SLOT-FILL: a slot that renders NO BOX AT ALL is still reported', () => {
  // An empty bleed slot deliberately renders nothing - the theme's own
  // watercolour already fills that corner. A rule that only looked at the DOM
  // found zero findings on a deck with six empty slots, three of them bleed.
  const found = slotFillRule(slotDeck({ state: 'absent' }));
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'fail');
  assert.equal(found[0].measured.slot_state, 'not rendered');
});

test('SLOT-FILL: a filled slot passes, and reuse_unchanged is a suggestion', () => {
  assert.deepEqual(slotFillRule(slotDeck({ state: 'filled' })), []);
  const reuse = slotFillRule(slotDeck({ state: 'empty', reuse: true }));
  assert.equal(reuse.length, 1);
  assert.equal(reuse[0].severity, 'suggestion', 'deck does not generate a logo or a photo, so it cannot demand one');
  assert.deepEqual(slotFillRule(slotDeck({ state: 'empty', decorative: true })), []);
});

test('SLOT-FILL: no storyboard means no opinion, not a false pass', () => {
  assert.deepEqual(slotFillRule({ slides: [measuredSlide()] }), []);
});

// ---------------------------------------------------------------------------
// Item 2 (the rule half): occupancy.
// ---------------------------------------------------------------------------

/** A slide whose content fills `fraction` of the content region's height. */
function filledTo(pageType, fraction) {
  const region = { ...rect(60, 42, 1562, 864) };
  return measuredSlide({
    slide_id: `s-${pageType}-${fraction}`,
    page_type: pageType,
    regions: { canvas: rect(0, 0, 1672, 941), 'content-region': region },
    elements: [element({
      id: 'body',
      tag: 'p',
      rect: rect(60, 42, 1562, 864 * fraction),
      content_union: rect(60, 42, 1562, 864 * fraction),
    })],
  });
}

const OCC_THEME = {
  lint: {
    occupancy: {
      grid: 48,
      exempt: ['statement'],
      advise_below: 0.30,
      trailing_gap_above: 0.42,
    },
  },
};

test('OCCUPANCY: a well-filled page is silent and a sparse one SUGGESTS, never fails', () => {
  assert.deepEqual(occupancyRule({ slides: [filledTo('table', 0.8)], theme: OCC_THEME }), []);

  const sparse = occupancyRule({ slides: [filledTo('table', 0.2)], theme: OCC_THEME });
  assert.ok(sparse.length > 0);
  assert.ok(sparse.every((f) => f.severity === 'suggestion'),
    'deliberate whitespace is good design; a gate that fails on it teaches the author to pad');
});

test('OCCUPANCY: there is NO blocking tier, and that is deliberate', () => {
  // A per-page-type blocking floor was built first and it failed deck's own
  // `init` scaffold - a perfectly composed three-item agenda - at 33.6%
  // against a floor of 37%. The good and the under-filled pages overlap on
  // every metric tried, and a threshold placed in the overlap fails correct
  // work. If this ever starts producing a `fail`, the thresholds have been
  // set from something other than measurement again.
  for (const fraction of [0.5, 0.2, 0.05, 0.01]) {
    const found = occupancyRule({ slides: [filledTo('comparison', fraction)], theme: OCC_THEME });
    assert.ok(found.every((f) => f.severity === 'suggestion'),
      `occupancy must never block (page filled to ${fraction})`);
  }
});

test('OCCUPANCY: emptiness at the SIDE is not emptiness at the BOTTOM', () => {
  // The case that killed the blocking tier: a three-item agenda covers about
  // a third of the region and leaves the right-hand side to the theme's
  // landscape. Coverage calls that sparse; the trailing gap - the measurement
  // that matches 下半分が完全な空白 - correctly calls it zero.
  const region = rect(60, 42, 1562, 864);
  const sideways = measuredSlide({
    page_type: 'agenda',
    regions: { canvas: rect(0, 0, 1672, 941), 'content-region': region },
    elements: [element({
      id: 'list', tag: 'ul', rect: rect(60, 42, 700, 864), content_union: rect(60, 42, 700, 864),
    })],
  });
  assert.equal(trailingGapOf(sideways), 0, 'the content reaches the bottom; the space is beside it');
  assert.ok(occupancyOf(sideways, 48).ratio < 0.5, 'and yet less than half the region is covered');

  const bottomless = measuredSlide({
    page_type: 'table',
    regions: { canvas: rect(0, 0, 1672, 941), 'content-region': region },
    elements: [element({
      id: 'table', tag: 'table', rect: rect(60, 42, 1562, 400), content_union: rect(60, 42, 1562, 400),
    })],
  });
  assert.ok(trailingGapOf(bottomless) > 0.5, 'this one really does stop halfway down');
  const found = occupancyRule({ slides: [bottomless], theme: OCC_THEME });
  assert.ok(found.some((f) => f.measured.trailing_gap !== undefined));
});

test("OCCUPANCY: the theme's statement exemption is honoured", () => {
  // themes/watercolor/theme.yaml has said since it was first written that
  // statement's whitespace "must not be treated as an error by any occupancy
  // heuristic". The exemption predates the rule by several rounds of work,
  // and the fixture's statement page proves it was right: 54% of its height
  // is empty under the words.
  assert.deepEqual(occupancyRule({ slides: [filledTo('statement', 0.05)], theme: OCC_THEME }), []);
  assert.equal(isExempt(OCC_THEME.lint.occupancy, 'statement'), true);
  assert.equal(isExempt(OCC_THEME.lint.occupancy, 'comparison'), false);
});

test("OCCUPANCY: a theme with no measured thresholds is not held to another theme's", () => {
  assert.deepEqual(occupancyRule({ slides: [filledTo('table', 0.01)], theme: {} }), []);
});

test('OCCUPANCY: an empty slot is empty space, and decoration does not fill a page', () => {
  // Both would let a page with nothing on it score as full, and both were on
  // the pages this rule was written for: every one of them was decorated, and
  // fourteen of fifteen reserved a picture that never arrived.
  const region = rect(60, 42, 1562, 864);
  const slide = measuredSlide({
    page_type: 'table',
    regions: { canvas: rect(0, 0, 1672, 941), 'content-region': region },
    elements: [
      element({ id: 'decor', decorative: true, tag: 'svg', rect: region, content_union: region }),
      element({
        id: 'slot-x', role: 'slot', slot: 'x', slot_state: 'empty', rect: region, content_union: region,
      }),
      element({ id: 'bg', background_of: 'card-1', rect: region, content_union: region }),
    ],
  });
  assert.equal(occupancyOf(slide, 48).ratio, 0,
    'none of scenery, a reserved frame or a card backing is content');
  assert.equal(trailingGapOf(slide), 1, 'a page with no content at all is empty all the way up');
});

// ---------------------------------------------------------------------------
// Item 6: the schema examples must be documents deck accepts.
// ---------------------------------------------------------------------------

test('SCHEMA EXAMPLES are valid documents of their own schemas', () => {
  // An example that does not validate is worse than no example, because it is
  // believed. Two of these were wrong when first written, which is the whole
  // argument for the test.
  const schemas = {
    sources: 'sources.schema.json',
    ledger: 'ledger.schema.json',
    agenda: 'agenda.schema.json',
  };
  for (const [name, schema] of Object.entries(schemas)) {
    assert.ok(EXAMPLES[name], `deck schema ${name} must carry a worked example`);
    assert.deepEqual(validate(schema, EXAMPLES[name], name), [],
      `the worked example printed by \`deck schema ${name}\` must be a document deck accepts`);
  }
});

test('SCHEMA EXAMPLES carry the keys the PO had to binary-search for', () => {
  // The specific shapes named in the field report, so an example that quietly
  // drops one stops being the answer to the question that was actually asked.
  assert.ok('source_id' in EXAMPLES.ledger.entries[0]);
  assert.ok('note' in EXAMPLES.ledger.entries[0]);
  assert.ok('heading' in EXAMPLES.agenda.items[0] && 'why' in EXAMPLES.agenda.items[0]);
  assert.ok('reason' in EXAMPLES.agenda.excluded[0], 'excluded says `reason`, not `why`');
  assert.deepEqual(Object.keys(EXAMPLES.agenda.missing_evidence[0]).sort(), ['what', 'why']);
  assert.deepEqual(Object.keys(EXAMPLES.sources.sources[0].pagination).sort(), ['has_more', 'requests']);
  assert.deepEqual(Object.keys(EXAMPLES.sources.sources[0].missing[0]).sort(), ['what', 'why']);
});
