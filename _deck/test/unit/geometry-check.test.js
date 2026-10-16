import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECK_HOME } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
// Importing the engine is what installs the real rule set into the validator,
// so the default path below is the one the CLI takes.
const { RULES } = await import('../../src/lint/engine.js');
const { checkGeometry } = await import('../../src/lint/geometry-check.js');

/**
 * MALFORMED GEOMETRY MUST BLOCK, NOT PASS (T22).
 *
 * Every rule skips what it cannot measure, which is right for a rule and
 * catastrophic for a gate: absent coordinates made every comparison NaN, and
 * `NaN > tolerance` is false, so nine rules ran over nothing and reported a
 * pass. These tests corrupt ONE field at a time - one case per numeric field
 * a rule declares it consumes - and require a problem naming it.
 *
 * The sweeps are generated FROM the rules' own READS declarations rather than
 * from a list written here, so a rule that starts reading something new is
 * covered the moment it declares it, and a field nothing validates shows up
 * as a failure in this file instead of as a confident pass in production.
 */

const STORYBOARD = { slides: [{ id: 's1' }] };
const RECT_FIELDS = ['x', 'y', 'w', 'h', 'cx', 'cy'];

const rect = (x, y, w, h) => ({ x, y, w, h, cx: x + w / 2, cy: y + h / 2 });

/** A geometry that must be accepted, carrying every field any rule reads. */
function validGeometry() {
  return {
    document: { media: 'print' },
    slides: [{
      slide_id: 's1',
      page_type: 'statement',
      regions: {
        canvas: rect(0, 0, 1672, 941),
        'content-region': rect(60, 42, 1562, 864),
        'badge-region': rect(60, 42, 300, 80),
      },
      elements: [{
        id: 'title',
        rect: rect(100, 100, 400, 80),
        content_union: rect(110, 110, 380, 60),
        effective_opacity: 1,
        color_alpha: 1,
        style: { font_size_px: 56 },
        overflow: { scroll_w: 400, scroll_h: 80, client_w: 400, client_h: 80 },
        text_lines: [rect(110, 110, 380, 60)],
        clipping_ancestors: [{ element: 'div.stack', rect: rect(60, 42, 1562, 864) }],
        backing: {
          composited: { r: 253, g: 253, b: 251 },
          layers: [{ kind: 'colour', rgba: { r: 253, g: 253, b: 251, a: 1 }, element: 'div.deck-canvas' }],
          stack: [{ element: 'h1', background: null, opacity: 1, textured: false }],
        },
        placement: { reference: 'badge-region', align_x: 'center', align_y: 'center', measure: 'content-union', tolerance_px: 2 },
      }],
    }],
  };
}

/** @param {(g: any) => void} mutate */
function after(mutate) {
  const g = validGeometry();
  mutate(g);
  return checkGeometry(g, STORYBOARD, RULES);
}

/** The union of what the real rules declare they read. */
function declared() {
  const rects = new Set(); const optionalRects = new Set();
  const numbers = new Set(); const optionalNumbers = new Set();
  const nested = new Map();
  for (const r of RULES) {
    for (const raw of r.reads?.rects || []) {
      (raw.endsWith('?') ? optionalRects : rects).add(raw.replace(/\?$/, ''));
    }
    for (const raw of r.reads?.numbers || []) {
      (raw.endsWith('?') ? optionalNumbers : numbers).add(raw.replace(/\?$/, ''));
    }
    for (const [obj, fields] of Object.entries(r.reads?.nested || {})) {
      if (!nested.has(obj)) nested.set(obj, new Set());
      for (const f of fields) nested.get(obj).add(f);
    }
  }
  for (const n of rects) optionalRects.delete(n);
  for (const n of numbers) optionalNumbers.delete(n);
  return { rects, optionalRects, numbers, optionalNumbers, nested };
}

const D = declared();

test('the CONTROL: well-formed geometry produces no problems', () => {
  // Stated first. Every test below asserts a block, so a validator that
  // rejected everything would pass all of them and fail only this one.
  assert.deepEqual(checkGeometry(validGeometry(), STORYBOARD, RULES), []);
});

test('the CONTROL holds with the rule set the ENGINE installed', () => {
  // checkGeometry(geometry, storyboard) with no third argument is what
  // lint.js calls; it must resolve the same rules.
  assert.deepEqual(checkGeometry(validGeometry(), STORYBOARD), []);
  assert.ok(RULES.length >= 9, `expected the nine rules, found ${RULES.length}`);
  for (const r of RULES) {
    assert.ok(r.reads && typeof r.reads === 'object',
      `rule "${r.id}" declares no READS, so nothing validates what it consumes`);
  }
});

test('ZERO measured slides is not a pass', () => {
  // The originally reproduced case: "verdict: pass, slides checked: 0".
  const p = after((g) => { g.slides = []; });
  assert.ok(p.length > 0);
  assert.ok(p.some((x) => /not a pass|measured 0/.test(x)), p.join(' | '));
});

test('a missing slides array blocks', () => {
  assert.equal(after((g) => { delete g.slides; }).length, 1);
  assert.equal(after((g) => { g.slides = {}; }).length, 1);
});

test('slides that do not match the storyboard block', () => {
  assert.ok(after((g) => { g.slides[0].slide_id = 'other'; }).some((x) => /do not match/.test(x)));
  assert.ok(after((g) => { delete g.slides[0].slide_id; }).some((x) => /do not match/.test(x)));
});

test('a recorded measurement error blocks', () => {
  assert.ok(after((g) => { g.slides[0].error = 'the canvas had no size'; })
    .some((x) => /records a measurement error/.test(x)));
});

test('missing regions, elements, or an empty element list block', () => {
  assert.ok(after((g) => { delete g.slides[0].regions; }).some((x) => /no measured regions/.test(x)));
  assert.ok(after((g) => { delete g.slides[0].elements; }).some((x) => /no elements array/.test(x)));
  assert.ok(after((g) => { g.slides[0].elements = []; }).some((x) => /zero elements/.test(x)));
  for (const required of ['canvas', 'content-region']) {
    assert.ok(after((g) => { delete g.slides[0].regions[required]; })
      .some((x) => x.includes(`missing the "${required}" region`)), `${required} must be required`);
  }
});

test('EVERY coordinate of EVERY standard region is checked', () => {
  for (const name of ['canvas', 'content-region']) {
    for (const f of RECT_FIELDS) {
      assert.ok(after((g) => { delete g.slides[0].regions[name][f]; }).some((x) => x.includes(name) && x.includes(f)),
        `region ${name} missing ${f} must block`);
      assert.ok(after((g) => { g.slides[0].regions[name][f] = null; }).some((x) => x.includes(name)),
        `region ${name} with ${f}=null must block`);
    }
  }
});

test('a CUSTOM reference region a contract names is checked too', () => {
  // The reported case. The rule compares against whatever region the
  // placement contract names; validating only canvas and content-region left
  // this one able to carry undefined coordinates.
  for (const f of RECT_FIELDS) {
    const p = after((g) => { delete g.slides[0].regions['badge-region'][f]; });
    assert.ok(p.some((x) => x.includes('badge-region') && x.includes(f)),
      `badge-region missing ${f} must block, got: ${p.join(' | ') || '(nothing)'}`);
  }
  assert.ok(after((g) => { g.slides[0].regions['badge-region'].cy = NaN; })
    .some((x) => x.includes('badge-region')), 'NaN is the shape the bug actually took');
});

test('EVERY coordinate of EVERY required element rect is checked', () => {
  assert.ok(D.rects.size > 0, 'the rules must declare at least one required rect');
  for (const name of D.rects) {
    for (const f of RECT_FIELDS) {
      assert.ok(after((g) => { delete g.slides[0].elements[0][name][f]; }).some((x) => x.includes(name) && x.includes(f)),
        `${name} missing ${f} must block`);
      assert.ok(after((g) => { g.slides[0].elements[0][name][f] = 'NaN'; }).some((x) => x.includes(name)),
        `${name} with a string ${f} must block`);
    }
    assert.ok(after((g) => { delete g.slides[0].elements[0][name]; }).some((x) => x.includes(name)),
      `a missing ${name} must block`);
  }
});

test('an OPTIONAL rect may be absent, but not malformed', () => {
  // This is the false-failure half: content-union is genuinely absent for an
  // element with no painted descendants, and that must stay a pass.
  for (const name of D.optionalRects) {
    assert.deepEqual(after((g) => { delete g.slides[0].elements[0][name]; }), [],
      `an absent ${name} must not block`);
    assert.deepEqual(after((g) => { g.slides[0].elements[0][name] = null; }), [],
      `an explicitly null ${name} must not block`);
    for (const f of RECT_FIELDS) {
      assert.ok(after((g) => { delete g.slides[0].elements[0][name][f]; }).some((x) => x.includes(name)),
        `a present ${name} missing ${f} must block`);
    }
  }
});

test('EVERY nested measurement a rule declares is checked', () => {
  // overflow.client_w is the reported case: scroll_w and scroll_h were
  // validated and the two client dimensions were not, so an overflow
  // comparison against undefined silently reported nothing.
  assert.ok(D.nested.size > 0);
  for (const [obj, fields] of D.nested) {
    assert.ok(after((g) => { delete g.slides[0].elements[0][obj]; }).some((x) => x.includes(obj)),
      `a missing ${obj} must block`);
    for (const f of fields) {
      assert.ok(after((g) => { delete g.slides[0].elements[0][obj][f]; })
        .some((x) => x.includes(`${obj}.${f}`)), `${obj}.${f} missing must block`);
      assert.ok(after((g) => { g.slides[0].elements[0][obj][f] = null; })
        .some((x) => x.includes(`${obj}.${f}`)), `${obj}.${f} = null must block`);
      assert.ok(after((g) => { g.slides[0].elements[0][obj][f] = '400px'; })
        .some((x) => x.includes(`${obj}.${f}`)), `${obj}.${f} as a string must block`);
    }
  }
});

test('an OPTIONAL number may be absent, but not non-finite', () => {
  for (const name of D.optionalNumbers) {
    assert.deepEqual(after((g) => { delete g.slides[0].elements[0][name]; }), [],
      `an absent ${name} must not block`);
    for (const bad of [null, NaN, 'none', Infinity]) {
      assert.ok(after((g) => { g.slides[0].elements[0][name] = bad; }).some((x) => x.includes(name)),
        `${name} = ${JSON.stringify(bad)} must block`);
    }
  }
});

test('text lines are checked as rectangles', () => {
  assert.ok(after((g) => { delete g.slides[0].elements[0].text_lines; })
    .some((x) => /no text_lines array/.test(x)));
  for (const f of RECT_FIELDS) {
    assert.ok(after((g) => { delete g.slides[0].elements[0].text_lines[0][f]; })
      .some((x) => /text line 1/.test(x)), `text line missing ${f} must block`);
  }
});

test('clipping ancestor rects are checked', () => {
  assert.ok(after((g) => { delete g.slides[0].elements[0].clipping_ancestors; })
    .some((x) => /no clipping_ancestors array/.test(x)));
  assert.ok(after((g) => { delete g.slides[0].elements[0].clipping_ancestors[0].rect; })
    .some((x) => /clipping ancestor 1/.test(x)));
  for (const f of RECT_FIELDS) {
    assert.ok(after((g) => { g.slides[0].elements[0].clipping_ancestors[0].rect[f] = undefined; })
      .some((x) => /clipping ancestor 1/.test(x)), `clipping ancestor missing ${f} must block`);
  }
});

test('the composited backing colour and the stack opacities are checked', () => {
  assert.ok(after((g) => { delete g.slides[0].elements[0].backing; })
    .some((x) => /no backing measurement/.test(x)));
  assert.ok(after((g) => { delete g.slides[0].elements[0].backing.composited; })
    .some((x) => /no composited colour/.test(x)));
  for (const ch of ['r', 'g', 'b']) {
    assert.ok(after((g) => { g.slides[0].elements[0].backing.composited[ch] = null; })
      .some((x) => x.includes(ch)), `a null ${ch} channel must block`);
  }
  assert.ok(after((g) => { g.slides[0].elements[0].backing.stack = {}; })
    .some((x) => /not an array/.test(x)));
  // The opacity of each stack entry is what the compositing walk multiplies.
  // A missing one silently becomes NaN and takes the whole composite with it.
  assert.ok(after((g) => { delete g.slides[0].elements[0].backing.stack[0].opacity; })
    .some((x) => /backing layer 1 has opacity/.test(x)));
  assert.ok(after((g) => { g.slides[0].elements[0].backing.stack[0].opacity = '0.4'; })
    .some((x) => /backing layer 1 has opacity/.test(x)));
  // An absent stack is not a malformation: an element with no translucent
  // ancestor has nothing to record.
  assert.deepEqual(after((g) => { delete g.slides[0].elements[0].backing.stack; }), []);
});

test('an element that is not an object, or has no id, blocks', () => {
  assert.ok(after((g) => { g.slides[0].elements[0] = null; }).some((x) => /is not an object/.test(x)));
  assert.ok(after((g) => { delete g.slides[0].elements[0].id; }).some((x) => /has no id/.test(x)));
});

test('a problem is reported for EVERY bad slide, not just the first', () => {
  const g = validGeometry();
  g.slides.push(JSON.parse(JSON.stringify(g.slides[0])));
  g.slides[1].slide_id = 's2';
  delete g.slides[0].elements[0].rect.cx;
  delete g.slides[1].elements[0].style.font_size_px;
  const p = checkGeometry(g, { slides: [{ id: 's1' }, { id: 's2' }] }, RULES);
  assert.ok(p.some((x) => x.includes('"s1"')), p.join(' | '));
  assert.ok(p.some((x) => x.includes('"s2"')), p.join(' | '));
});
