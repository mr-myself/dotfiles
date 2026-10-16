import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DECK_HOME, theme } from '../helpers.js';
import { closeBrowser, measure, page } from './fixture.js';

process.env.DECK_HOME = DECK_HOME;
const T = await theme();
const { contrastRule } = await import('../../src/lint/rules/contrast.js');

after(closeBrowser);

/**
 * CONTRAST, MEASURED FROM A REAL BROWSER.
 *
 * The earlier contrast tests handed the rule an already-composited backing
 * object, so they tested the rule's arithmetic and nothing about whether the
 * collector produces the right input. These build real DOM and let Chrome
 * resolve it.
 */

const run = (slide) => contrastRule({ slides: [slide], theme: T });

test('THE ELEMENT\'S OWN BACKGROUND IS THE BACKING', async () => {
  // Reproduced by review: backingColour walked from the PARENT, so a table
  // header painting its own navy fill and white text on top of it scored
  // 1.02:1 against page white - a confident, precise, entirely wrong answer.
  const slide = await measure(page(
    '<div class="band" data-deck-id="th">見出し</div>',
    { extraCss: '.band { position:absolute; left:100px; top:100px; padding:20px; background:#10436D; color:#FFFFFF; font-size:30px; font-weight:700 }' },
  ));
  const el = slide.elements.find((e) => e.id === 'th');
  assert.deepEqual(el.backing.composited, { r: 16, g: 67, b: 109 }, 'the element paints its own navy');
  assert.deepEqual(run(slide), [], 'white on that navy is 10:1 and must pass');
});

test('a TRANSPARENT element inside a coloured band composites to the band', async () => {
  const slide = await measure(page(
    '<div class="band"><span data-deck-id="label">見出し</span></div>',
    { extraCss: '.band { position:absolute; left:100px; top:100px; padding:20px; background:#10436D } .band span { color:#FFFFFF; font-size:30px; font-weight:700 }' },
  ));
  assert.deepEqual(run(slide).filter((f) => f.element === 'label'), []);
});

test('FOREGROUND ALPHA IS COMPOSITED AGAINST THE REAL BACKING', async () => {
  // Reproduced by review: rgba(255,255,255,0.1) over black produced NO
  // finding, because translucent text was flattened over white regardless of
  // what was actually behind it. Its effective contrast is about 1.20:1.
  const slide = await measure(page(
    '<div class="band"><span data-deck-id="faint">うすい文字</span></div>',
    { extraCss: '.band { position:absolute; left:100px; top:100px; padding:20px; background:#000000 } .band span { color:rgba(255,255,255,0.1); font-size:20px }' },
  ));
  const el = slide.elements.find((e) => e.id === 'faint');
  assert.equal(el.color_alpha, 0.1, 'the collector must report the text alpha');

  const f = run(slide).filter((x) => x.element === 'faint');
  assert.equal(f.length, 1, 'invisible text must not pass');
  assert.ok(f[0].measured.ratio < 1.5, `ratio was ${f[0].measured.ratio}`);
  assert.equal(f[0].measured.text_alpha, 0.1);
  assert.match(f[0].message, /effective alpha/);
});

test('ANCESTOR OPACITY IS COMPOSITED TOO', async () => {
  // CSS opacity on a group fades its text exactly as a translucent colour
  // does, and the collector ignored it entirely.
  const slide = await measure(page(
    '<div class="band"><div class="faded"><span data-deck-id="ghost">薄い文字</span></div></div>',
    {
      extraCss: `
        .band { position:absolute; left:100px; top:100px; padding:20px; background:#000000 }
        .faded { opacity: 0.12 }
        .faded span { color:#FFFFFF; font-size:20px }`,
    },
  ));
  const el = slide.elements.find((e) => e.id === 'ghost');
  assert.ok(Math.abs(el.effective_opacity - 0.12) < 1e-6, `effective opacity was ${el.effective_opacity}`);

  const f = run(slide).filter((x) => x.element === 'ghost');
  assert.equal(f.length, 1, 'text faded to near-invisible must not pass');
  assert.ok(f[0].measured.ratio < 1.6, `ratio was ${f[0].measured.ratio}`);
});

test('NESTED opacity multiplies', async () => {
  const slide = await measure(page(
    '<div class="a"><div class="b"><span data-deck-id="x">文字</span></div></div>',
    { extraCss: '.a { opacity:0.5 } .b { opacity:0.5 } span { color:#000; font-size:20px }' },
  ));
  const el = slide.elements.find((e) => e.id === 'x');
  assert.ok(Math.abs(el.effective_opacity - 0.25) < 1e-6, `got ${el.effective_opacity}`);
});

test('LAYERED translucent backgrounds composite in order', async () => {
  // Two half-transparent black layers over white make a mid grey; black text
  // on it still passes, white text on it does not.
  const slide = await measure(page(
    '<div class="l1"><div class="l2"><span data-deck-id="dark">文字</span><span data-deck-id="light">文字</span></div></div>',
    {
      extraCss: `
        .l1 { position:absolute; left:100px; top:100px; background:rgba(0,0,0,0.5); padding:10px }
        .l2 { background:rgba(0,0,0,0.5); padding:10px }
        #dark { color:#000000; font-size:20px }
        #light { color:#9a9a9a; font-size:20px }`,
    },
  ));
  const el = slide.elements.find((e) => e.id === 'dark');
  // white -> 50% black -> 50% black again is 63.75. Chrome quantises an alpha
  // to 8 bits (0.5 comes back as 127/255), so the exact integer is 63 or 64
  // depending on rounding; what matters is that BOTH layers were applied and
  // the result is mid-grey rather than white.
  for (const ch of ['r', 'g', 'b']) {
    assert.ok(Math.abs(el.backing.composited[ch] - 64) <= 1,
      `${ch} composited to ${el.backing.composited[ch]}, expected about 64`);
  }
  assert.equal(el.backing.layers.filter((l) => l.kind === 'colour').length >= 2, true,
    'both translucent layers must be recorded');
  const f = run(slide);
  assert.ok(f.some((x) => x.element === 'light'), 'mid grey on dark grey must fail');
});

test('fully transparent text is not reported as a contrast problem', async () => {
  // opacity 0 paints nothing; it is not a contrast question.
  const slide = await measure(page(
    '<div class="hidden"><span data-deck-id="gone">文字</span></div>',
    { extraCss: '.hidden { opacity:0 } span { color:#fff; font-size:20px }' },
  ));
  assert.deepEqual(run(slide).filter((x) => x.element === 'gone'), []);
});

test('text over a BACKGROUND IMAGE is unsupported, never a silent pass', async () => {
  const slide = await measure(page(
    '<div class="hero"><span data-deck-id="over">文字</span></div>',
    {
      extraCss: `
        .hero { position:absolute; left:100px; top:100px; width:300px; height:100px;
                background-image:linear-gradient(90deg,#fff,#000) }
        .hero span { color:#808080; font-size:20px }`,
    },
  ));
  const f = run(slide).filter((x) => x.element === 'over');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'unsupported');
  assert.match(f[0].message, /will not guess/);
});

/**
 * AN OPAQUE BACKGROUND UNDER A TRANSLUCENT ANCESTOR (T21).
 *
 * The collector used to stop walking the moment it found an opaque background
 * colour, on the reasoning that nothing behind it can show through. That is
 * true of the COLOURS behind it and false of the OPACITIES around it: CSS
 * opacity on an ancestor composites the whole subtree, opaque backgrounds
 * included. Stopping early reported white-on-black at 21:1 for text that a
 * reader sees at under 3:1.
 */

/** @param {string} id @param {string} extraCss @param {string} body */
async function backedBy(id, body, extraCss) {
  const slide = await measure(page(body, { extraCss }));
  const el = slide.elements.find((e) => e.id === id);
  assert.ok(el, `fixture did not produce element ${id}`);
  const f = run(slide).filter((x) => x.element === id);
  return { el, findings: f, ratio: f[0]?.measured?.ratio };
}

const CARD = `
  .wrap { position:absolute; left:100px; top:100px }
  .card { background:#000000; padding:20px }
  .card span { color:#FFFFFF; font-size:30px; font-weight:700 }`;
const CARD_HTML = '<div class="wrap"><div class="card"><span data-deck-id="on-card">文字</span></div></div>';

test('the CONTROL: an opaque card with no ancestor opacity still reads 21:1', async () => {
  // Stated first, because the fix had to raise the translucent cases without
  // lowering this one. White on black is the maximum; if this moves, the
  // compositing walk has started subtracting something it should not.
  const { el, findings } = await backedBy('on-card', CARD_HTML, CARD);
  assert.deepEqual(el.backing.composited, { r: 0, g: 0, b: 0 }, 'the card paints real black');
  assert.deepEqual(findings, [], 'white on black must pass');
});

test('an OPAQUE card inside an opacity:0.4 ancestor is measured as composited', async () => {
  // Reproduced on real Chrome before the fix: backing {0,0,0}, ratio 21:1,
  // zero findings. The reader sees mid grey.
  const { el, findings, ratio } = await backedBy('on-card', CARD_HTML,
    `${CARD} .wrap { opacity:0.4 }`);
  for (const ch of ['r', 'g', 'b']) {
    assert.ok(Math.abs(el.backing.composited[ch] - 152) <= 3,
      `${ch} composited to ${el.backing.composited[ch]}, expected about 152 (40% black over the page)`);
  }
  assert.equal(findings.length, 1, 'white text at under 3:1 must be reported');
  assert.ok(ratio > 2.6 && ratio < 3.1, `ratio was ${ratio}, expected about 2.85`);
});

test('NESTED opacities multiply, and a deeper stack reads lighter', async () => {
  const outer = await backedBy('on-card', CARD_HTML, `${CARD} .wrap { opacity:0.4 }`);
  const nested = await backedBy('on-card',
    '<div class="wrap"><div class="mid"><div class="card"><span data-deck-id="on-card">文字</span></div></div></div>',
    `${CARD} .wrap { opacity:0.6 } .mid { opacity:0.6 }`);
  // 0.6 x 0.6 = 0.36 is LESS ink than 0.4, so the composite is lighter and
  // the white text contrasts even less. Asserted as an ordering as well as a
  // number: a walk that took only the nearest opacity would invert this.
  assert.ok(nested.el.backing.composited.r > outer.el.backing.composited.r,
    `nested 0.36 should composite lighter than 0.40: ${nested.el.backing.composited.r} vs ${outer.el.backing.composited.r}`);
  assert.equal(nested.findings.length, 1);
  assert.ok(nested.ratio < outer.ratio, `nested ratio ${nested.ratio} should be below ${outer.ratio}`);
  assert.ok(nested.ratio > 2.3 && nested.ratio < 2.8, `nested ratio was ${nested.ratio}, expected about 2.52`);
});

test('the text element\'s OWN opacity composites its own background too', async () => {
  // The walk starts at the element, so the element's own opacity applies to
  // the background it itself paints. Nothing else in the suite covers the
  // first iteration of the loop.
  const { el, findings } = await backedBy('on-card', CARD_HTML,
    `${CARD} .card { opacity:0.4 }`);
  assert.ok(Math.abs(el.backing.composited.r - 152) <= 3,
    `composited to ${el.backing.composited.r}, expected about 152`);
  assert.equal(findings.length, 1);
});

test('opacity:1 ancestors change NOTHING (no false failure)', async () => {
  // The fix made the walk continue past an opaque background. This is the
  // case that proves continuing is harmless when there is no transparency to
  // find: every ancestor is opaque, so the answer must still be exactly black.
  const { el, findings } = await backedBy('on-card', CARD_HTML,
    `${CARD} .wrap { opacity:1 } .card { opacity:1 }`);
  assert.deepEqual(el.backing.composited, { r: 0, g: 0, b: 0 });
  assert.deepEqual(findings, []);
});

test('an opaque background still HIDES the colours behind it', async () => {
  // The other half of the same rule: continuing the walk must not start
  // blending in colours the opaque card covers. A red page behind a black
  // card is not visible, so it must not tint the backing.
  const { el, findings } = await backedBy('on-card', CARD_HTML,
    `${CARD} .wrap { background:#FF0000; padding:30px }`);
  assert.deepEqual(el.backing.composited, { r: 0, g: 0, b: 0 }, 'the red is behind an opaque card');
  assert.deepEqual(findings, []);
});

test('a translucent card over a coloured band composites BOTH', async () => {
  const { el, ratio, findings } = await backedBy('on-card', CARD_HTML,
    `${CARD} .card { background:rgba(0,0,0,0.5) } .wrap { background:#FF0000; padding:30px; opacity:0.5 }`);
  // half black over red, the pair then at 50% over the near-white page.
  assert.ok(el.backing.layers.filter((l) => l.kind === 'colour').length >= 2,
    'both the card and the band must be recorded as layers');
  assert.ok(el.backing.composited.r > el.backing.composited.g,
    `the red must survive into the composite: ${JSON.stringify(el.backing.composited)}`);
  assert.ok(findings.length === 0 || ratio > 1, `ratio ${ratio}`);
});
