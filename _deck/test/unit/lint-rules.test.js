import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECK_HOME, element, measuredSlide, rect, theme } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const T = await theme();
const { centringRule } = await import('../../src/lint/rules/centring.js');
const { overflowRule } = await import('../../src/lint/rules/overflow.js');
const { collisionRule } = await import('../../src/lint/rules/collision.js');
const { safeMarginsRule } = await import('../../src/lint/rules/safe-margins.js');
const { alignmentRule } = await import('../../src/lint/rules/alignment.js');
const { typeSizeRule } = await import('../../src/lint/rules/type-size.js');
const { contrastRule, contrastRatio, isLargeText, parseHex } = await import('../../src/lint/rules/contrast.js');
const { repetitionRule } = await import('../../src/lint/rules/repetition.js');
const { proximityRule } = await import('../../src/lint/rules/proximity.js');
const { RULES, runLint } = await import('../../src/lint/engine.js');

const CONTRACT = {
  reference: 'content-region', align_x: 'center', align_y: 'center',
  measure: 'content-union', tolerance_px: 2,
};

/** An element perfectly centred on the content region, then displaced. */
function centred({ dx = 0, dy = 0, placement = CONTRACT, ...rest } = {}) {
  const safe = { x: 60, y: 42, w: 1562, h: 864 };
  const w = 400;
  const h = 100;
  const r = rect(safe.x + (safe.w - w) / 2 + dx, safe.y + (safe.h - h) / 2 + dy, w, h);
  return element({ id: 'title', placement, rect: r, content_union: r, ...rest });
}

// ---------------------------------------------------------------- centring

test('a perfectly centred element passes both axes', () => {
  const f = centringRule({ slides: [measuredSlide({ elements: [centred()] })], theme: T });
  assert.deepEqual(f, []);
});

test('A HORIZONTAL-ONLY error fails x AND ONLY x', () => {
  const f = centringRule({ slides: [measuredSlide({ elements: [centred({ dx: 9 })] })], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].axis, 'x');
  assert.equal(f[0].element, 'title');
  assert.equal(f[0].reference, 'content-region');
  assert.equal(f[0].measured.dx, 9);
  assert.match(f[0].message, /9\.00 px too far right/);
  assert.ok(f[0].boxes.length >= 2, 'a finding carries boxes to annotate');
});

test('A VERTICAL-ONLY error fails y AND ONLY y', () => {
  const f = centringRule({ slides: [measuredSlide({ elements: [centred({ dy: -7.5 })] })], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].axis, 'y');
  assert.equal(f[0].measured.dy, -7.5);
  assert.match(f[0].message, /7\.50 px too far up/);
});

test('an error on both axes produces one finding PER AXIS', () => {
  const f = centringRule({ slides: [measuredSlide({ elements: [centred({ dx: 5, dy: 5 })] })], theme: T });
  assert.deepEqual(f.map((x) => x.axis).sort(), ['x', 'y']);
});

test('tolerance boundary: exactly 2 px passes, just over fails', () => {
  const at = centringRule({ slides: [measuredSlide({ elements: [centred({ dx: 2 })] })], theme: T });
  assert.deepEqual(at, [], 'exactly at tolerance is not a failure');
  const over = centringRule({ slides: [measuredSlide({ elements: [centred({ dx: 2.01 })] })], theme: T });
  assert.equal(over.length, 1);
  assert.equal(over[0].axis, 'x');
});

test('THE WRONG REFERENCE REGION FAILS, because the two centres differ', () => {
  // The whole reason a contract must NAME its reference. This theme's margins
  // are asymmetric on BOTH axes - left 60 / right 50, top 42 / bottom 35 - so
  //   canvas centre        = (836.0, 470.5)
  //   content-region centre = (841.0, 474.0)
  // An element centred on the canvas while declaring content-region is 5 px
  // out horizontally and 3.5 px out vertically. Both are over the 2 px
  // tolerance, and both are invisible to anyone who assumed the two regions
  // shared a centre.
  const canvas = measuredSlide().regions.canvas;
  const safe = measuredSlide().regions['content-region'];
  assert.notEqual(canvas.cx, safe.cx);
  assert.notEqual(canvas.cy, safe.cy);

  const canvasCentred = element({
    id: 'title',
    placement: CONTRACT,
    rect: rect(canvas.cx - 200, canvas.cy - 50, 400, 100),
    content_union: rect(canvas.cx - 200, canvas.cy - 50, 400, 100),
  });
  const f = centringRule({ slides: [measuredSlide({ elements: [canvasCentred] })], theme: T });
  assert.deepEqual(f.map((x) => x.axis).sort(), ['x', 'y']);
  assert.equal(f.find((x) => x.axis === 'x').measured.dx, -5);
  assert.equal(f.find((x) => x.axis === 'y').measured.dy, -3.5);
  for (const x of f) assert.equal(x.reference, 'content-region');

  // ...and the same element, centred on the region it declares, passes.
  const correct = element({
    id: 'title',
    placement: CONTRACT,
    rect: rect(safe.cx - 200, safe.cy - 50, 400, 100),
    content_union: rect(safe.cx - 200, safe.cy - 50, 400, 100),
  });
  assert.deepEqual(centringRule({ slides: [measuredSlide({ elements: [correct] })], theme: T }), []);
});

test('A CENTRED WRAPPER WHOSE INNER CONTENT IS DISPLACED IS CAUGHT', () => {
  // The exact bug the rule exists for. The wrapper's own box is the full
  // content region, so it is centred by definition; its ink is not.
  const wrapper = element({
    id: 'stack',
    placement: CONTRACT,
    rect: rect(60, 42, 1562, 864),
    content_union: rect(60 + 400, 42 + 100, 400, 100),
  });
  const f = centringRule({ slides: [measuredSlide({ elements: [wrapper] })], theme: T });
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.expected.measure === 'content-union'));
  // Measuring the box instead would have passed it, which is the point.
  const asBox = centringRule({
    slides: [measuredSlide({
      elements: [{ ...wrapper, placement: { ...CONTRACT, measure: 'box' } }],
    })],
    theme: T,
  });
  assert.deepEqual(asBox, []);
});

test('an unknown reference region is UNSUPPORTED, never a pass', () => {
  const f = centringRule({
    slides: [measuredSlide({ elements: [centred({ placement: { ...CONTRACT, reference: 'no-such-region' } })] })],
    theme: T,
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'unsupported');
  assert.match(f[0].message, /does not exist on this slide/);
});

test('a contract with no reference is UNSUPPORTED; deck refuses to guess', () => {
  const { reference, ...noRef } = CONTRACT;
  void reference;
  const f = centringRule({ slides: [measuredSlide({ elements: [centred({ placement: noRef })] })], theme: T });
  assert.equal(f[0].severity, 'unsupported');
  assert.match(f[0].message, /refuses to guess/);
});

test('unparseable placement JSON is UNSUPPORTED, not ignored', () => {
  const f = centringRule({
    slides: [measuredSlide({ elements: [centred({ placement: { __parse_error: 'bad json', __raw: '{oops' } })] })],
    theme: T,
  });
  assert.equal(f[0].severity, 'unsupported');
});

test('a centred element with no measurable content is UNSUPPORTED', () => {
  const f = centringRule({
    slides: [measuredSlide({ elements: [centred({ content_union: null })] })],
    theme: T,
  });
  assert.equal(f[0].severity, 'unsupported');
  assert.match(f[0].message, /cannot be verified/);
});

test('an element with no contract is simply not checked', () => {
  const f = centringRule({ slides: [measuredSlide({ elements: [element({ placement: null })] })], theme: T });
  assert.deepEqual(f, []);
});

// ---------------------------------------------------------------- overflow

test('clipped overflow is caught; overflow:visible is not', () => {
  const clipped = element({
    id: 'box',
    rect: rect(100, 100, 200, 50),
    overflow: { ...element().overflow, scroll_h: 120, client_h: 50, overflow_y: 'hidden' },
  });
  const f = overflowRule({ slides: [measuredSlide({ elements: [clipped] })], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].axis, 'y');

  const visible = { ...clipped, overflow: { ...clipped.overflow, overflow_y: 'visible' } };
  assert.deepEqual(overflowRule({ slides: [measuredSlide({ elements: [visible] })], theme: T }), []);
});

test('one pixel of sub-pixel noise is not overflow', () => {
  const el = element({
    overflow: { ...element().overflow, scroll_h: 41, client_h: 40, overflow_y: 'hidden' },
  });
  assert.deepEqual(overflowRule({ slides: [measuredSlide({ elements: [el] })], theme: T }), []);
});

test('an active line clamp is reported, because it drops the PO\'s lines', () => {
  const el = element({
    id: 'body',
    overflow: { ...element().overflow, line_clamp: '2', scroll_h: 120, client_h: 60 },
  });
  const f = overflowRule({ slides: [measuredSlide({ elements: [el] })], theme: T });
  assert.ok(f.some((x) => /line-clamp/.test(x.message)));
});

test('an active ellipsis is reported, because the rendered text is not the storyboard\'s', () => {
  const el = element({
    id: 't',
    overflow: { ...element().overflow, text_overflow: 'ellipsis', scroll_w: 400, client_w: 200, overflow_x: 'hidden' },
  });
  const f = overflowRule({ slides: [measuredSlide({ elements: [el] })], theme: T });
  assert.ok(f.some((x) => /ellipsis/.test(x.message)));
});

test('a text line off the canvas is caught, because it renders as nothing', () => {
  const el = element({
    id: 't',
    text_lines: [{ ...rect(1600, 400, 300, 40), text: 'はみ出した行' }],
  });
  const f = overflowRule({ slides: [measuredSlide({ elements: [el] })], theme: T });
  assert.ok(f.some((x) => /outside the canvas/.test(x.message)));
});

test('A CLIPPING ANCESTOR that cuts a text line is caught and named', () => {
  const el = element({
    id: 'inner',
    rect: rect(100, 100, 200, 40),
    text_lines: [{ ...rect(100, 100, 400, 40), text: '切れている行' }],
    clipping_ancestors: [{
      element: '#card', deck_id: 'card', overflow_x: 'hidden', overflow_y: 'visible',
      clip_path: null, rect: rect(100, 100, 200, 40),
    }],
  });
  const f = overflowRule({ slides: [measuredSlide({ elements: [el] })], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].reference, 'card');
  assert.match(f[0].message, /clipped by card/);
});

// --------------------------------------------------------------- collision

test('unrelated overlapping content collides', () => {
  const a = element({ id: 'a', rect: rect(100, 100, 200, 100), content_union: rect(100, 100, 200, 100) });
  const b = element({ id: 'b', rect: rect(250, 150, 200, 100), content_union: rect(250, 150, 200, 100) });
  const f = collisionRule({ slides: [measuredSlide({ elements: [a, b] })], theme: T });
  assert.equal(f.length, 1);
  assert.match(f[0].message, /content overlapping by 50x50/);
});

test('DOM nesting, declared backgrounds, same group and decorative do NOT collide', () => {
  // `inner` and `bg` declare real ANCESTRY. Geometric containment is no longer
  // an exemption on its own: two unrelated elements sharing a rectangle used
  // to be exempt by it, which is the worst collision there is.
  const outer = element({ id: 'card', rect: rect(100, 100, 400, 300), content_union: rect(100, 100, 400, 300) });
  const inner = element({ id: 'heading', ancestry: ['card'], rect: rect(120, 120, 200, 40), content_union: rect(120, 120, 200, 40) });
  const bg = element({ id: 'bg', ancestry: ['card'], background_of: 'card', rect: rect(100, 100, 400, 300), content_union: rect(100, 100, 400, 300) });
  const wash = element({ id: 'wash', decorative: true, rect: rect(0, 0, 900, 900), content_union: rect(0, 0, 900, 900) });
  const g1 = element({ id: 'g1', group: 'g', rect: rect(600, 100, 100, 100), content_union: rect(600, 100, 100, 100) });
  const g2 = element({ id: 'g2', group: 'g', rect: rect(650, 100, 100, 100), content_union: rect(650, 100, 100, 100) });
  const f = collisionRule({ slides: [measuredSlide({ elements: [outer, inner, bg, wash, g1, g2] })], theme: T });
  assert.deepEqual(f, []);
});

test('GEOMETRIC CONTAINMENT ALONE IS NOT AN EXEMPTION', () => {
  // Reproduced by the reviewer: zero findings for unrelated text elements
  // occupying the same rectangle.
  const same = rect(100, 100, 300, 80);
  const a = element({ id: 'a', text: '一番目', rect: same, content_union: same });
  const b = element({ id: 'b', text: '二番目', rect: same, content_union: same });
  assert.equal(collisionRule({ slides: [measuredSlide({ elements: [a, b] })], theme: T }).length, 1);

  // ...and one unrelated element completely covering another.
  const big = rect(100, 100, 300, 80);
  const small = rect(150, 120, 100, 20);
  const cover = element({ id: 'cover', text: '覆う', rect: big, content_union: big });
  const under = element({ id: 'under', text: '覆われる', rect: small, content_union: small });
  assert.equal(collisionRule({ slides: [measuredSlide({ elements: [cover, under] })], theme: T }).length, 1);
});

test('ancestry that was never recorded fails CLOSED, not open', () => {
  // Geometry from an older render has no `ancestry`. A missing exemption
  // costs a finding the author dismisses; a wrong exemption costs two
  // headings printed on top of each other with nobody told.
  const big = rect(100, 100, 400, 300);
  const small = rect(120, 120, 200, 40);
  const outer = element({ id: 'card', rect: big, content_union: big, ancestry: undefined });
  const inner = element({ id: 'heading', rect: small, content_union: small, ancestry: undefined });
  assert.equal(collisionRule({ slides: [measuredSlide({ elements: [outer, inner] })], theme: T }).length, 1);
});

test('pagination and bleed zones do not collide; the FOOTER zone still does', () => {
  const body = element({ id: 'body', rect: rect(1500, 860, 160, 60), content_union: rect(1500, 860, 160, 60) });
  const folio = element({ id: 'page-number', zone: 'pagination', rect: rect(1560, 880, 80, 40), content_union: rect(1560, 880, 80, 40) });
  assert.deepEqual(collisionRule({ slides: [measuredSlide({ elements: [body, folio] })], theme: T }), []);

  // Body content running into the footer band IS a defect, and this is the
  // only rule that can see it: the band sits inside the safe region.
  const footer = element({ id: 'footer-text', zone: 'footer', rect: rect(1480, 850, 200, 50), content_union: rect(1480, 850, 200, 50) });
  const f = collisionRule({ slides: [measuredSlide({ elements: [body, footer] })], theme: T });
  assert.equal(f.length, 1);
});

test('collision compares INK, so a full-region layout wrapper is not a collider', () => {
  const wrapper = element({
    id: 'stack', rect: rect(60, 42, 1562, 864), content_union: rect(700, 400, 300, 100),
  });
  const folio = element({ id: 'other', group: 'x', rect: rect(1560, 880, 80, 40), content_union: rect(1560, 880, 80, 40) });
  assert.deepEqual(collisionRule({ slides: [measuredSlide({ elements: [wrapper, folio] })], theme: T }), []);
});

// ------------------------------------------------------------ safe margins

test('body content outside the safe region fails; a permitted zone does not', () => {
  const out = element({ id: 'stray', rect: rect(20, 400, 100, 40) });
  const f = safeMarginsRule({ slides: [measuredSlide({ elements: [out] })], theme: T });
  assert.equal(f.length, 1);
  assert.match(f[0].message, /40\.00 px past the left/);

  for (const zone of ['footer', 'pagination', 'decorative', 'bleed']) {
    const permitted = element({ id: 'z', zone, rect: rect(20, 400, 100, 40) });
    assert.deepEqual(safeMarginsRule({ slides: [measuredSlide({ elements: [permitted] })], theme: T }), [],
      `zone "${zone}" should be permitted`);
  }
});

test('an UNDECLARED zone is treated as body, so forgetting it is stricter not looser', () => {
  const out = element({ id: 'stray', zone: null, rect: rect(20, 400, 100, 40) });
  const f = safeMarginsRule({ slides: [measuredSlide({ elements: [out] })], theme: T });
  assert.equal(f.length, 1);
  assert.match(f[0].message, /no zone declared/);
});

test('a font box past the margin is a SUGGESTION, not a failure', () => {
  // Noto Sans JP reserves 1.44 em of vertical space against ~0.88 em of ink,
  // so a first line sitting exactly on the margin always pokes above it.
  const el = element({
    id: 'section-label',
    rect: rect(88, 42, 200, 31),
    content_union: rect(88, 42, 200, 31),
    text_lines: [{ ...rect(88, 39, 200, 36), text: '本日の流れ' }],
  });
  const f = safeMarginsRule({ slides: [measuredSlide({ elements: [el] })], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'suggestion');
  assert.equal(f[0].measured.font_box_ratio, 1.5);
});

test('a slide with no content-region is UNSUPPORTED, never a silent pass', () => {
  const slide = measuredSlide({ regions: { canvas: rect(0, 0, 1672, 941) }, elements: [element()] });
  const f = safeMarginsRule({ slides: [slide], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'unsupported');
});

test('A LARGE INTENTIONALLY BLANK AREA DOES NOT FAIL ANY RULE', () => {
  // Intentional whitespace is good design. There is no occupancy heuristic in
  // this linter, deliberately, and this test is what keeps it that way.
  const safe = measuredSlide().regions['content-region'];
  const r = rect(safe.cx - 200, safe.cy - 50, 400, 100);
  const lonely = element({
    id: 'statement', role: 'statement-title', text: '余白は意図である',
    placement: CONTRACT,
    rect: r, content_union: r,
    style: { ...element().style, font_size_px: 84, font_weight: '700' },
    text_lines: [{ ...r, text: '余白は意図である' }],
  });
  const result = runLint({ slides: [measuredSlide({ elements: [lonely] })], theme: T });
  assert.equal(result.summary.blocking, 0,
    `a page that is 97% empty must pass: ${JSON.stringify(result.findings.map((x) => x.message))}`);
});

// ---------------------------------------------------------------- alignment

test('a violated DECLARED anchor fails; a near miss is only a suggestion', () => {
  const a = element({ id: 'a', anchor: 'left:col', rect: rect(100, 100, 200, 40) });
  const b = element({ id: 'b', anchor: 'left:col', rect: rect(100, 200, 200, 40) });
  const c = element({ id: 'c', anchor: 'left:col', rect: rect(104, 300, 200, 40) });
  const f = alignmentRule({ slides: [measuredSlide({ elements: [a, b, c] })], theme: T });
  const fails = f.filter((x) => x.severity === 'fail');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].element, 'c', 'the odd one out is named, not all three');
  assert.equal(fails[0].measured.off_by_px, 4);
});

test('an undeclared near miss is a SUGGESTION and never fails the gate', () => {
  const a = element({ id: 'a', rect: rect(100, 100, 200, 40) });
  const b = element({ id: 'b', rect: rect(101.4, 300, 200, 40) });
  const f = alignmentRule({ slides: [measuredSlide({ elements: [a, b] })], theme: T });
  const left = f.filter((x) => x.axis === 'x' && x.severity === 'suggestion');
  assert.ok(left.length >= 1);
  assert.equal(f.filter((x) => x.severity === 'fail').length, 0);
});

test('a malformed anchor is UNSUPPORTED rather than skipped', () => {
  const a = element({ id: 'a', anchor: 'sideways:col', rect: rect(100, 100, 200, 40) });
  const f = alignmentRule({ slides: [measuredSlide({ elements: [a] })], theme: T });
  assert.equal(f[0].severity, 'unsupported');
});

// ---------------------------------------------------------------- type size

test('text below the absolute floor fails even with no declared role', () => {
  const tiny = element({ id: 't', role: null, text: '小さすぎる', style: { ...element().style, font_size_px: 11 } });
  const f = typeSizeRule({ slides: [measuredSlide({ elements: [tiny] })], theme: T });
  assert.equal(f.length, 1);
  assert.match(f[0].message, /below the theme's absolute readable floor/);
});

test('a role outside its band fails on either side', () => {
  const small = element({ id: 'a', role: 'title', text: 'x', style: { ...element().style, font_size_px: 30 } });
  const big = element({ id: 'b', role: 'title', text: 'x', style: { ...element().style, font_size_px: 200 } });
  const f = typeSizeRule({ slides: [measuredSlide({ elements: [small, big] })], theme: T });
  assert.equal(f.length, 2);
});

test('a role inside its band passes', () => {
  const ok = element({ id: 'a', role: 'title', text: 'x', style: { ...element().style, font_size_px: 61 } });
  assert.deepEqual(typeSizeRule({ slides: [measuredSlide({ elements: [ok] })], theme: T }), []);
});

// ----------------------------------------------------------------- contrast

test('contrast uses the COMPOSITED backing, not the nearest CSS background', () => {
  // White text on a transparent element inside a navy band: reading the
  // element's own background-color would composite to white and score a
  // beautiful, entirely fictional ratio.
  const el = element({
    id: 'th', text: '見出し',
    text_lines: [{ ...rect(0, 0, 100, 30), text: '見出し' }],
    // 20 px regular is NOT WCAG large text, so the full 4.5:1 applies.
    style: { ...element().style, font_size_px: 20, color: 'rgb(255, 255, 255)', background_color: 'rgba(0, 0, 0, 0)' },
    backing: { textured: false, composited: { r: 16, g: 67, b: 109 }, layers: [] },
  });
  assert.deepEqual(contrastRule({ slides: [measuredSlide({ elements: [el] })], theme: T }), []);

  const wrong = { ...el, backing: { textured: false, composited: { r: 253, g: 253, b: 251 }, layers: [] } };
  const f = contrastRule({ slides: [measuredSlide({ elements: [wrong] })], theme: T });
  assert.equal(f.length, 1);
  assert.match(f[0].message, /below the required 4.5/);
});

test('A TEXTURED BACKING IS UNSUPPORTED, NEVER A SILENT PASS', () => {
  const el = element({
    id: 't', text: 'over an image',
    text_lines: [{ ...rect(0, 0, 100, 30), text: 'over an image' }],
    backing: {
      textured: true,
      composited: { r: 200, g: 200, b: 200 },
      layers: [{ kind: 'image', value: 'url(photo.png)', element: '#hero' }],
    },
  });
  const f = contrastRule({ slides: [measuredSlide({ elements: [el] })], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'unsupported');
  assert.match(f[0].message, /will not guess/);
});

test('a component may DECLARE its backing over a gradient, and it is named in the report', () => {
  const el = element({
    id: 'footer-text', text: '要点',
    text_lines: [{ ...rect(0, 0, 100, 30), text: '要点' }],
    placement: { contrast_backing: '#F1F8F5' },
    style: { ...element().style, color: 'rgb(6, 121, 110)' },
    backing: { textured: true, composited: { r: 255, g: 255, b: 255 }, layers: [{ kind: 'image', value: 'linear-gradient(...)', element: '#banner' }] },
  });
  assert.deepEqual(contrastRule({ slides: [measuredSlide({ elements: [el] })], theme: T }), []);
});

test('large text qualifies for 3:1, normal text does not', () => {
  assert.equal(isLargeText(24, '400'), true);
  assert.equal(isLargeText(23, '400'), false);
  assert.equal(isLargeText(19, '700'), true);
  assert.equal(isLargeText(18, '700'), false);
});

test('THE DECLARED THEME EXCEPTION IS REPORTED ON EVERY RUN, not only on failure', () => {
  // The PO's decision: record the design kit's pale agenda grey as an
  // explicit, reported exception rather than silently darkening it. An
  // exception that only surfaced when it failed would never surface at all.
  const el = element({
    id: 'agenda-text-2', role: 'agenda-text', text: 'ご提案の内容',
    text_lines: [{ ...rect(0, 0, 200, 30), text: 'ご提案の内容' }],
    style: { ...element().style, color: 'rgb(184, 184, 184)' },
    backing: { textured: false, composited: { r: 253, g: 253, b: 251 }, layers: [] },
  });
  const f = contrastRule({ slides: [measuredSlide({ elements: [el] })], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'suggestion', 'it passes the gate...');
  assert.match(f[0].message, /THEME EXCEPTION IN USE/, '...but it is never silent');
  assert.match(f[0].message, /intentional/);
});

test('the agenda grey really is far below 4.5:1, so the exception is load-bearing', () => {
  const ratio = contrastRatio(parseHex('#B8B8B8'), parseHex('#FDFDFB'));
  assert.ok(ratio < 2, `expected the kit grey to be under 2:1, got ${ratio.toFixed(2)}`);
});

// --------------------------------------------------------------- repetition

test('one slide out of step with its page-type peers is named', () => {
  const slides = ['a', 'b', 'c'].map((id, i) => measuredSlide({
    slide_id: id,
    page_type: 'standard-3col',
    elements: [element({ id: 'title', role: 'title', rect: rect(60, i === 2 ? 120 : 100, 400, 60) })],
  }));
  const f = repetitionRule({ slides, theme: T });
  const tops = f.filter((x) => x.expected.metric === 'top');
  assert.equal(tops.length, 1);
  assert.equal(tops[0].slide, 'c');
  assert.equal(tops[0].measured.off_by_px, 20);
});

test('A DECLARED VARIANT is compared only against its own kind', () => {
  const slides = [
    measuredSlide({ slide_id: 'a', page_type: 'standard-3col', elements: [element({ id: 'title', role: 'title', rect: rect(60, 100, 400, 60) })] }),
    measuredSlide({ slide_id: 'b', page_type: 'standard-3col', elements: [element({ id: 'title', role: 'title', rect: rect(60, 100, 400, 60) })] }),
    measuredSlide({ slide_id: 'c', page_type: 'standard-3col', variant: 'tall', elements: [element({ id: 'title', role: 'title', rect: rect(60, 300, 400, 60) })] }),
  ];
  assert.deepEqual(repetitionRule({ slides, theme: T }), [],
    'a declared variant is a legitimate exception and must not fail');
});

test('a single slide of a page type is not compared against anything', () => {
  const slides = [measuredSlide({ slide_id: 'a', page_type: 'cover', elements: [element({ id: 'title', role: 'title' })] })];
  assert.deepEqual(repetitionRule({ slides, theme: T }), []);
});

// ---------------------------------------------------------------- proximity

test('a group looser than its declared internal maximum fails', () => {
  const container = element({ id: 'card', group: 'c1', proximity: { max_internal_gap_px: 20 }, rect: rect(60, 100, 400, 300) });
  const h = element({ id: 'h', group: 'c1', rect: rect(60, 100, 400, 40) });
  const b = element({ id: 'b', group: 'c1', rect: rect(60, 200, 400, 40) });
  const f = proximityRule({ slides: [measuredSlide({ elements: [container, h, b] })] });
  assert.equal(f.length, 1);
  assert.equal(f[0].measured.gap_px, 60);
  assert.match(f[0].message, /will not read as one unit/);
});

test('a group within its contract passes', () => {
  const container = element({ id: 'card', group: 'c1', proximity: { max_internal_gap_px: 20 }, rect: rect(60, 100, 400, 300) });
  const h = element({ id: 'h', group: 'c1', rect: rect(60, 100, 400, 40) });
  const b = element({ id: 'b', group: 'c1', rect: rect(60, 150, 400, 40) });
  assert.deepEqual(proximityRule({ slides: [measuredSlide({ elements: [container, h, b] })] }), []);
});

test('two groups closer than the declared minimum separation fail', () => {
  const c1 = element({ id: 'c1', group: 'g1', proximity: { min_external_gap_px: 40 }, rect: rect(60, 100, 200, 100) });
  const m1 = element({ id: 'm1', group: 'g1', rect: rect(60, 100, 200, 100) });
  const m2 = element({ id: 'm2', group: 'g2', rect: rect(270, 100, 200, 100) });
  const f = proximityRule({ slides: [measuredSlide({ elements: [c1, m1, m2] })] });
  assert.equal(f.length, 1);
  assert.equal(f[0].measured.gap_px, 10);
});

test('an UNDECLARED cluster is not guessed at', () => {
  const a = element({ id: 'a', rect: rect(60, 100, 200, 40) });
  const b = element({ id: 'b', rect: rect(60, 400, 200, 40) });
  assert.deepEqual(proximityRule({ slides: [measuredSlide({ elements: [a, b] })] }), []);
});

test('unparseable proximity JSON is UNSUPPORTED', () => {
  const el = element({ id: 'c', group: 'g', proximity: { __parse_error: 'bad' } });
  const f = proximityRule({ slides: [measuredSlide({ elements: [el] })] });
  assert.equal(f[0].severity, 'unsupported');
});

// ------------------------------------------------------------------ engine

test('A RULE THAT THROWS BECOMES A BLOCKING FINDING, never a quiet pass', () => {
  // A visible text element with no `style` object: every rule that reads a
  // computed style throws on it. Geometry this malformed only reaches the
  // linter through a deck bug, which is exactly when a clean report would be
  // most damaging.
  const broken = measuredSlide({
    elements: [{ ...element({ id: 'broken', text: 'x' }), style: null }],
  });
  const result = runLint({ slides: [broken], theme: T });
  assert.ok(result.summary.blocking > 0, 'a rule crash must not produce a clean report');
  const crashed = result.findings.filter((f) => f.severity === 'unsupported' && /FAILED to run/.test(f.message));
  assert.ok(crashed.length > 0, JSON.stringify(result.summary.rule_status));
  for (const f of crashed) assert.equal(result.summary.rule_status[f.rule].ran, false);
});

test('every rule runs, and the honest limits are reported', () => {
  const result = runLint({ slides: [measuredSlide()], theme: T });
  // Asserted against RULES rather than a literal, so adding a rule does not
  // need this number edited in three places.
  assert.equal(result.summary.rules_total, RULES.length);
  assert.equal(result.summary.rules_run, RULES.length);
  assert.equal(Object.keys(result.summary.by_rule).length, RULES.length);
  assert.ok(result.summary.honest_limits.length >= 4);
  assert.ok(result.summary.honest_limits.some((l) => /optical balance/.test(l)));
  // The occupancy limit replaced the old "there is no occupancy heuristic"
  // line when the rule was built: the claim changed, so the assertion did.
  assert.ok(result.summary.honest_limits.some((l) => /sparse page is reported as a suggestion/.test(l)));
  // And the limit that matters most, because no rule here will ever close it:
  // five errors reached a real page and every one was visible in the copy
  // sheet. The report has to say so.
  assert.ok(result.summary.honest_limits.some((l) => /Nothing here reads the WORDS/.test(l)));
});

test('findings are ordered deterministically, so two runs produce one report', () => {
  const slides = [measuredSlide({
    elements: [centred({ dx: 9, dy: 9 }), element({ id: 'z', rect: rect(10, 10, 20, 20) })],
  })];
  const a = runLint({ slides, theme: T }).findings.map((f) => `${f.rule}/${f.slide}/${f.element}/${f.axis}`);
  const b = runLint({ slides, theme: T }).findings.map((f) => `${f.rule}/${f.slide}/${f.element}/${f.axis}`);
  assert.deepEqual(a, b);
});

// ============================================================ REPETITION
//
// The rule blocked a valid deck with ten findings. It compared `left` and
// `width` of CENTRED, AUTO-WIDTH text across slides at 1.5 px tolerance, so
// four chapter titles of different lengths were each reported as an outlier
// against the others - and the peers quoted in the finding disagreed among
// themselves (509.5, 577.86, 560.98) by more than the slide being blamed
// (541.75) differed from any of them.

/** A slide carrying one auto-width text element: the box hugs its own ink. */
function slideWithAutoWidthTitle(id, x, w) {
  return measuredSlide({
    slide_id: id,
    page_type: 'section-divider',
    elements: [element({
      id: 'title',
      role: 'title',
      text: 'タイトル',
      rect: rect(x, 300, w, 70),
      // A box that hugs its text: the ink union is the box.
      content_union: rect(x, 300, w, 70),
    })],
  });
}

test('REPETITION DOES NOT COMPARE THE EXTENT OF VARIABLE-LENGTH TEXT', async () => {
  const { repetitionRule } = await import('../../src/lint/rules/repetition.js');
  // The real numbers from the deck this blocked.
  const slides = [
    slideWithAutoWidthTitle('ch-01', 509.5, 653),
    slideWithAutoWidthTitle('ch-02', 577.86, 516.28),
    slideWithAutoWidthTitle('ch-03', 560.98, 550.04),
    slideWithAutoWidthTitle('ch-04', 541.75, 588.5),
  ];
  const findings = repetitionRule({ slides, theme: { lint: { repetition_tolerance_px: 1.5 } } });
  assert.deepEqual(findings, [],
    `different-length titles are not a layout defect; got ${JSON.stringify(findings.map((f) => f.message))}`);
});

test('but it STILL catches a title that really did drift', async () => {
  const { repetitionRule } = await import('../../src/lint/rules/repetition.js');
  // Full-width blocks: the box is far wider than its ink, so `top` is a
  // design decision and is compared.
  const block = (id, y) => measuredSlide({
    slide_id: id,
    page_type: 'standard-3col',
    elements: [element({
      id: 'title',
      role: 'title',
      text: 'タイトル',
      rect: rect(60, y, 1562, 70),
      content_union: rect(60, y, 420, 70),
    })],
  });
  const findings = repetitionRule({
    slides: [block('a', 108), block('b', 108), block('c', 131)],
    theme: { lint: { repetition_tolerance_px: 1.5 } },
  });
  assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.message)));
  assert.equal(findings[0].slide, 'c');
  assert.match(findings[0].message, /top 131/);
});

test('and a full-width block IS compared on left, because that is the margin', async () => {
  const { repetitionRule } = await import('../../src/lint/rules/repetition.js');
  const block = (id, x) => measuredSlide({
    slide_id: id,
    page_type: 'standard-3col',
    elements: [element({
      id: 'title',
      role: 'title',
      text: 'タイトル',
      rect: rect(x, 108, 1562, 70),
      content_union: rect(x, 108, 420, 70),
    })],
  });
  const findings = repetitionRule({
    slides: [block('a', 60), block('b', 60), block('c', 92)],
    theme: { lint: { repetition_tolerance_px: 1.5 } },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].slide, 'c');
  assert.equal(findings[0].axis, 'x');
});

test('when no two slides agree there is no intended value, so nothing is reported', async () => {
  const { repetitionRule } = await import('../../src/lint/rules/repetition.js');
  // Four full-width blocks at four different tops. Naming one of them as the
  // offender would be inventing a value none of them share.
  const block = (id, y) => measuredSlide({
    slide_id: id,
    page_type: 'table',
    elements: [element({
      id: 'title', role: 'title', text: 'x', rect: rect(60, y, 1562, 70), content_union: rect(60, y, 300, 70),
    })],
  });
  const findings = repetitionRule({
    slides: [block('a', 100), block('b', 140), block('c', 180), block('d', 220)],
    theme: { lint: { repetition_tolerance_px: 1.5 } },
  });
  assert.deepEqual(findings, []);
});

test('a card\'s HEIGHT is its body text, not a design decision', async () => {
  const { repetitionRule } = await import('../../src/lint/rules/repetition.js');
  // Two three-column pages whose cards differ in height because one has an
  // extra line of body copy. The card hugs its content, so its height is an
  // extent.
  const card = (id, h) => measuredSlide({
    slide_id: id,
    page_type: 'standard-3col',
    elements: [element({
      id: 'card-1', role: 'card', rect: rect(60, 300, 474, h), content_union: rect(60, 300, 474, h),
    })],
  });
  assert.deepEqual(
    repetitionRule({ slides: [card('a', 486), card('b', 486), card('c', 608)], theme: { lint: {} } }),
    [],
  );
  // ...but where it starts still is.
  const top = (id, y) => measuredSlide({
    slide_id: id,
    page_type: 'standard-3col',
    elements: [element({
      id: 'card-1', role: 'card', rect: rect(60, y, 474, 486), content_union: rect(60, y, 474, 486),
    })],
  });
  const drifted = repetitionRule({ slides: [top('a', 300), top('b', 300), top('c', 340)], theme: { lint: {} } });
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0].slide, 'c');
});
