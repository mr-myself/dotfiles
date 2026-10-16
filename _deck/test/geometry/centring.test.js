import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DECK_HOME, theme } from '../helpers.js';
import { CANVAS, closeBrowser, contract, measure, page } from './fixture.js';

process.env.DECK_HOME = DECK_HOME;
const T = await theme();
const { centringRule } = await import('../../src/lint/rules/centring.js');
const { overflowRule } = await import('../../src/lint/rules/overflow.js');
const { runLint } = await import('../../src/lint/engine.js');

after(closeBrowser);

/** A centred stack, optionally nudged by CSS, measured in real Chrome. */
async function stack({ nudge = '', inner = '<h1 class="title" data-deck-id="title">中央</h1>', place = contract(), extraCss = '' } = {}) {
  const html = page(
    `<div class="stack" data-deck-id="stack" data-deck-role="statement-title" data-deck-placement="${place}" style="${nudge}">${inner}</div>`,
    { extraCss },
  );
  return measure(html);
}

test('a genuinely centred element passes in real Chrome', async () => {
  const slide = await stack();
  assert.deepEqual(centringRule({ slides: [slide], theme: T }), []);
});

test('A HORIZONTAL-ONLY CSS ERROR fails x and only x', async () => {
  // `padding-left` on a centring flex container shifts its content right by
  // half the padding - a 20 px padding is a 10 px horizontal displacement and
  // exactly zero vertical change.
  const slide = await stack({ nudge: 'padding-left:20px' });
  const f = centringRule({ slides: [slide], theme: T });
  assert.equal(f.length, 1, JSON.stringify(f.map((x) => x.message)));
  assert.equal(f[0].axis, 'x');
  assert.equal(f[0].element, 'stack');
  assert.equal(f[0].reference, 'content-region');
  assert.ok(Math.abs(f[0].measured.dx - 10) < 0.6, `dx was ${f[0].measured.dx}`);
  assert.match(f[0].message, /too far right/);
  assert.ok(f[0].boxes.some((b) => b.kind === 'reference'));
  assert.ok(f[0].boxes.some((b) => b.kind === 'offender'));
});

test('A VERTICAL-ONLY CSS ERROR fails y and only y', async () => {
  const slide = await stack({ nudge: 'padding-top:30px' });
  const f = centringRule({ slides: [slide], theme: T });
  assert.equal(f.length, 1, JSON.stringify(f.map((x) => x.message)));
  assert.equal(f[0].axis, 'y');
  assert.ok(Math.abs(f[0].measured.dy - 15) < 0.6, `dy was ${f[0].measured.dy}`);
  assert.match(f[0].message, /too far down/);
});

test('THE WRONG REFERENCE REGION is caught on both axes', async () => {
  // Centred on the CANVAS while declaring content-region. The theme's margins
  // are asymmetric on both axes (left 60 / right 50, top 42 / bottom 35), so
  // the canvas centre is 5 px left and 3.5 px above the safe centre.
  const slide = await stack({
    extraCss: `.stack { left: 0 !important; top: 0 !important; width: ${CANVAS.w}px !important; height: ${CANVAS.h}px !important }`,
  });
  const f = centringRule({ slides: [slide], theme: T });
  assert.deepEqual(f.map((x) => x.axis).sort(), ['x', 'y']);
  assert.ok(Math.abs(f.find((x) => x.axis === 'x').measured.dx + 5) < 0.6);
  assert.ok(Math.abs(f.find((x) => x.axis === 'y').measured.dy + 3.5) < 0.6);
});

test('A CENTRED WRAPPER WHOSE INNER CONTENT IS DISPLACED IS CAUGHT', async () => {
  // The wrapper is centred by construction - it IS the content region. Its
  // ink is pushed right and down. Measuring the wrapper would pass this; the
  // contract says `measure: content-union`, so it does not.
  const slide = await stack({
    extraCss: '.stack { display:block !important } .title { position:relative; left:240px; top:120px }',
  });
  const f = centringRule({ slides: [slide], theme: T });
  assert.deepEqual(f.map((x) => x.axis).sort(), ['x', 'y']);
  assert.ok(f[0].expected.measure === 'content-union');

  // ...and the wrapper's own box really is dead centre, proving the rule
  // would have passed it had it measured the box.
  const el = slide.elements.find((e) => e.id === 'stack');
  assert.equal(el.rect.cx, slide.regions['content-region'].cx);
  assert.equal(el.rect.cy, slide.regions['content-region'].cy);
});

test('TOLERANCE BOUNDARY on BOTH SIGNS of BOTH AXES', async () => {
  // The original boundary test covered positive x only. A sign error in the
  // comparison, or an axis handled asymmetrically, would have survived it.
  // Padding shifts the centred content by HALF the padding, so 4.5 px of
  // padding is 2.25 px of displacement - over the 2 px tolerance.
  //
  // Measured, and the reason this is 4.5 rather than something tighter:
  // Chrome snaps layout to 1/64 px and rounds direction-dependently.
  // `padding-left:4.02px` lands on exactly 2.0000 px of displacement while
  // `padding-right:4.02px` lands on 2.0156 - so a fixture that only just
  // clears the tolerance tests Chrome's rounding, not deck's comparison.
  const cases = [
    { axis: 'x', sign: +1, css: 'padding-left:4.5px' },
    { axis: 'x', sign: -1, css: 'padding-right:4.5px' },
    { axis: 'y', sign: +1, css: 'padding-top:4.5px' },
    { axis: 'y', sign: -1, css: 'padding-bottom:4.5px' },
  ];
  for (const c of cases) {
    const label = `${c.axis}${c.sign > 0 ? '+' : '-'}`;
    const over = await stack({ nudge: c.css });
    const f = centringRule({ slides: [over], theme: T });
    assert.equal(f.length, 1, `${label}: expected exactly one finding, got ${JSON.stringify(f.map((x) => x.message))}`);
    assert.equal(f[0].axis, c.axis, `${label} must fail on the ${c.axis} axis ONLY`);
    const delta = c.axis === 'x' ? f[0].measured.dx : f[0].measured.dy;
    assert.equal(Math.sign(delta), c.sign, `${label}: expected a ${c.sign > 0 ? 'positive' : 'negative'} displacement, got ${delta}`);
    assert.ok(Math.abs(Math.abs(delta) - 2.25) < 0.05, `${label}: displacement was ${delta}`);
    // The direction is in the message, which is what the author reads.
    const word = { 'x+': 'right', 'x-': 'left', 'y+': 'down', 'y-': 'up' }[label];
    assert.match(f[0].message, new RegExp(`too far ${word}`), f[0].message);
  }

  // ...and exactly at tolerance passes on every one of them.
  for (const c of [
    { css: 'padding-left:4px' }, { css: 'padding-right:4px' },
    { css: 'padding-top:4px' }, { css: 'padding-bottom:4px' },
  ]) {
    const at = await stack({ nudge: c.css });
    assert.deepEqual(centringRule({ slides: [at], theme: T }), [],
      `${c.css}: exactly 2 px of displacement must pass`);
  }
});

test('A CENTRED CHILD WRAPPER WHOSE INTERNAL TEXT IS DISPLACED IS CAUGHT', async () => {
  // Two levels of wrapper. The outer stack is centred, the inner wrapper is
  // centred inside it and full width, and the TEXT within the inner wrapper
  // is left-aligned. Measuring immediate children found a centred inner box
  // and passed; the recursion has to reach the ink.
  const slide = await stack({
    inner: '<div class="inner" data-deck-id="inner"><h1 class="title" data-deck-id="title">内側のテキスト</h1></div>',
    extraCss: '.stack { display:block !important } .inner { width:100%; text-align:left } .title { display:inline-block }',
  });
  const inner = slide.elements.find((e) => e.id === 'inner');
  assert.equal(inner.rect.cx, slide.regions['content-region'].cx,
    'the inner wrapper box really is centred, which is what made this a false pass');

  const f = centringRule({ slides: [slide], theme: T });
  assert.ok(f.some((x) => x.axis === 'x'), `expected a horizontal failure, got ${JSON.stringify(f.map((x) => x.message))}`);
});

test('TOLERANCE BOUNDARY: exactly 2 px passes, just over fails', async () => {
  // 4 px of padding-left is a 2.0 px displacement - exactly at tolerance.
  const at = await stack({ nudge: 'padding-left:4px' });
  const atF = centringRule({ slides: [at], theme: T });
  const el = at.elements.find((e) => e.id === 'stack');
  assert.ok(Math.abs((el.content_union.cx - at.regions['content-region'].cx) - 2) < 0.01,
    'the fixture must displace by exactly 2 px for this boundary to mean anything');
  assert.deepEqual(atF, [], 'exactly at tolerance is not a failure');

  // 5 px of padding is 2.5 px - just over.
  const over = await stack({ nudge: 'padding-left:5px' });
  const overF = centringRule({ slides: [over], theme: T });
  assert.equal(overF.length, 1);
  assert.equal(overF[0].axis, 'x');
  assert.ok(Math.abs(overF[0].measured.dx - 2.5) < 0.01);
});

test('WRAPPED JAPANESE TEXT stays centred, and is measured as its line union', async () => {
  const long = '温泉街の滞在体験を、まち全体でひとつの宿として組み立て直す取り組みについてのご提案';
  const slide = await stack({
    inner: `<h1 class="title" data-deck-id="title">${long}</h1>`,
    extraCss: '.title { font-size: 56px; max-width: 900px }',
  });
  const el = slide.elements.find((e) => e.id === 'stack');
  const title = slide.elements.find((e) => e.id === 'title');
  assert.ok(title.text_lines.length >= 2, `expected the text to wrap, got ${title.text_lines.length} line(s)`);
  assert.ok(el.content_union.h > 100, 'a wrapped block is taller than one line');
  assert.deepEqual(centringRule({ slides: [slide], theme: T }), [],
    'wrapping must not move the centre');
  // The content survives the wrap character for character.
  assert.equal(title.text, long);
});

test('wrapped text displaced on one axis still fails only that axis', async () => {
  const long = '温泉街の滞在体験を、まち全体でひとつの宿として組み立て直す取り組み';
  const slide = await stack({
    inner: `<h1 class="title" data-deck-id="title">${long}</h1>`,
    nudge: 'padding-top:40px',
    extraCss: '.title { font-size: 56px; max-width: 900px }',
  });
  const f = centringRule({ slides: [slide], theme: T });
  assert.equal(f.length, 1);
  assert.equal(f[0].axis, 'y');
});

test('A CLIPPING ANCESTOR is detected and its clipped line reported', async () => {
  const slide = await measure(page(`
    <div class="clip" data-deck-id="card">
      <p data-deck-id="body">この行は親のoverflow:hiddenで切り取られている長い日本語のテキストです</p>
    </div>`, {
    extraCss: `
      .clip { position:absolute; left:200px; top:300px; width:300px; height:60px; overflow:hidden }
      .clip p { font-size:32px; white-space:nowrap }`,
  }));

  const body = slide.elements.find((e) => e.id === 'body');
  // The whole chain is recorded, not just the nearest: the canvas and the page
  // clip too, and a line can escape an inner box while staying inside an outer
  // one. The named card must be among them.
  const card = body.clipping_ancestors.find((c) => c.deck_id === 'card');
  assert.ok(card, JSON.stringify(body.clipping_ancestors.map((c) => c.element)));
  assert.equal(card.overflow_x, 'hidden');
  assert.ok(body.clipping_ancestors.length >= 1);

  const f = overflowRule({ slides: [slide], theme: T });
  assert.ok(f.some((x) => /clipped by card/.test(x.message)),
    JSON.stringify(f.map((x) => x.message)));
});

test('A LARGE INTENTIONALLY BLANK AREA PASSES EVERY RULE', async () => {
  // Two short words on an otherwise empty page. Intentional whitespace is
  // good design, and no rule here may punish it.
  // The ROLE goes on the element that draws the text, as the real templates
  // put it - not on the centring wrapper, which paints nothing.
  const slide = await stack({
    inner: '<h1 class="title" data-deck-id="title" data-deck-role="statement-title">余白</h1>',
    place: contract(),
  });
  const result = runLint({ slides: [slide], theme: T });
  assert.equal(result.summary.blocking, 0,
    `a nearly empty page must pass: ${JSON.stringify(result.findings.map((x) => `${x.rule}: ${x.message}`))}`);

  // ...and the page really is almost entirely empty, so the test means
  // something.
  const el = slide.elements.find((e) => e.id === 'stack');
  const inkArea = el.content_union.w * el.content_union.h;
  const pageArea = CANVAS.w * CANVAS.h;
  assert.ok(inkArea / pageArea < 0.02, `expected under 2% ink, got ${(100 * inkArea / pageArea).toFixed(1)}%`);
});

test('text whose font box exceeds its line box does not fail the margin rule', async () => {
  // Noto Sans JP reserves 1.44 em against roughly 0.88 em of ink, so a line
  // sitting exactly on the top margin always has a font box above it. This is
  // measured here against the real font rather than asserted from a constant.
  const slide = await measure(page(
    '<div class="eyebrow" data-deck-id="section-label" data-deck-role="section-label">本日の流れ</div>', {
      extraCss: `.eyebrow {
        position:absolute; left:60px; top:42px; height:31px;
        display:flex; align-items:center; font-size:25px; font-weight:700; line-height:1.24 }`,
    },
  ));
  const el = slide.elements.find((e) => e.id === 'section-label');
  const ratio = el.text_lines[0].h / el.style.font_size_px;
  assert.ok(ratio > 1.3, `expected the font box to exceed its line box, ratio was ${ratio}`);
  assert.ok(el.text_lines[0].y < 42, 'the font box should reach above the margin');
  assert.equal(el.rect.y, 42, 'while the layout box sits exactly on it');

  const result = runLint({ slides: [slide], theme: T });
  const margins = result.findings.filter((f) => f.rule === 'safe-margins');
  assert.equal(margins.filter((f) => f.severity === 'fail').length, 0);
  assert.equal(margins.filter((f) => f.severity === 'suggestion').length, 1);
});


// ---------------------------------------------------------------------------
// T13: the ink union against genuinely painted content.
//
// The previous implementation clipped text rects to their element box, which
// removed the font's leading AND removed real ink. These exercise the cases
// where those two are told apart.
// ---------------------------------------------------------------------------

test('VISIBLE HORIZONTAL OVERFLOW IS MEASURED, not clipped away', async () => {
  // Reproduced: a centred 200 px box holding left-aligned text that paints
  // out to 624 px reported its ink centre AS the box centre, so text 212 px
  // off-centre produced zero findings from every rule.
  const slide = await stack({
    inner: '<h1 class="narrow" data-deck-id="title">はみ出す長い見出しの文字列</h1>',
    extraCss: '.narrow { width:200px; white-space:nowrap; overflow:visible; text-align:left; font-size:48px }',
  });
  const el = slide.elements.find((e) => e.id === 'stack');
  const title = slide.elements.find((e) => e.id === 'title');
  const line = title.text_lines[0];

  assert.ok(line.w > 500, `the text really does overflow: ${line.w} px in a 200 px box`);
  assert.ok(Math.abs(el.content_union.w - line.w) < 2,
    `the ink union must be the painted width (${line.w}), got ${el.content_union.w}`);
  assert.ok(Math.abs(el.content_union.cx - line.cx) < 2,
    'and its centre must be the painted centre, not the box centre');

  const f = centringRule({ slides: [slide], theme: T });
  assert.ok(f.some((x) => x.axis === 'x'), 'text painted off-centre must fail the x axis');
});

test('FIXED-HEIGHT MULTILINE OVERFLOW IS MEASURED, not clipped to the box', async () => {
  const slide = await stack({
    inner: '<div class="fixed" data-deck-id="title">一行目<br>二行目<br>三行目<br>四行目<br>五行目</div>',
    extraCss: '.stack { display:block !important } .fixed { height:60px; overflow:visible; font-size:40px; line-height:1.5 }',
  });
  const el = slide.elements.find((e) => e.id === 'title');
  assert.ok(Math.abs(el.rect.h - 60) < 2, `the box is 60 px, got ${el.rect.h}`);
  assert.ok(el.content_union.h > 250,
    `five 60 px lines paint about 300 px; the ink union reported ${el.content_union.h}`);
});

test('MIXED FONT SIZES in one centred stack still centre exactly', async () => {
  // Different children reserve different leading, which is what made a
  // symmetric subtraction wrong. The per-side trim must leave the centre
  // exact whatever the mixture.
  const slide = await stack({
    inner: `
      <div data-deck-id="a" style="font-size:72px;line-height:1.2">大きい</div>
      <div data-deck-id="b" style="font-size:20px;line-height:1.6">ちいさい</div>
      <div data-deck-id="c" style="font-size:40px;line-height:1.35">ふつう</div>`,
  });
  const el = slide.elements.find((e) => e.id === 'stack');
  const region = slide.regions['content-region'];
  assert.ok(Math.abs(el.content_union.cy - region.cy) < 0.5,
    `mixed sizes must still centre: dy ${(el.content_union.cy - region.cy).toFixed(3)}`);
  assert.deepEqual(centringRule({ slides: [slide], theme: T }), []);
});

test('WRAPPED INLINE ELEMENTS contribute every line box', async () => {
  const slide = await stack({
    inner: '<p data-deck-id="title" style="width:600px;font-size:32px;line-height:1.5">これは<span>強調された語</span>を含む段落であり、折り返して複数行になります。確実に折り返すだけの長さがあります。</p>',
    extraCss: '.stack { display:block !important }',
  });
  const el = slide.elements.find((e) => e.id === 'title');
  // `text_lines` counts RECTS, and an inline <span> splits one visual line
  // into several, so the count is not the number of visual lines. The
  // element's own box height is: it is exactly N line-heights.
  assert.ok(el.text_lines.length >= 3, `expected several rects, got ${el.text_lines.length}`);
  assert.ok(el.rect.h > 100, `the paragraph wraps to several lines: box ${el.rect.h} px`);
  // Within a few pixels of the laid-out line boxes. Not exactly equal: at
  // this size the font box (46 px) is SMALLER than the line box (48 px), so
  // there is no leading to remove and the ink is legitimately a pixel short
  // at each end. What matters is that all three visual lines are counted.
  assert.ok(Math.abs(el.content_union.h - el.rect.h) <= 4,
    `wrapped ink must track the laid-out line boxes: box ${el.rect.h}, ink ${el.content_union.h}`);
  assert.ok(el.content_union.h > el.rect.h * 0.9, 'every wrapped line must be counted');
  assert.ok(el.content_union.w <= 601, 'and the width stays within the wrapping width');
});

// ---------------------------------------------------------------------------
// T14 / C15: required text hidden by CSS.
// ---------------------------------------------------------------------------

test('REQUIRED TEXT HIDDEN BY CSS FAILS, where every other rule is silent', async () => {
  const slide = await measure(page(
    `<div class="region region--content" data-deck-ignore></div>
     <h1 data-deck-id="title" data-deck-role="title" class="gone">本当は必要な見出し</h1>
     <p data-deck-id="subtitle" data-deck-role="subtitle">見える副題</p>`,
    {
      extraCss: '.gone { display:none } p { position:absolute; left:60px; top:300px; font-size:28px }',
      slideId: 'fx',
    },
  ));
  const storyboard = {
    slides: [{
      id: 'fx', page_type: 'cover', purpose: 'p',
      title: '本当は必要な見出し', subtitle: '見える副題',
    }],
  };
  const result = runLint({ slides: [slide], theme: T, storyboard });
  const content = result.findings.filter((f) => f.rule === 'content-integrity');
  assert.equal(content.length, 1, JSON.stringify(result.findings.map((f) => `${f.rule}: ${f.message}`)));
  assert.match(content[0].message, /NOT VISIBLE/);
  assert.equal(content[0].element, 'title');

  // Every OTHER rule is silent about it, which is exactly why this one exists.
  const others = result.findings.filter((f) => f.rule !== 'content-integrity');
  assert.ok(!others.some((f) => f.element === 'title'),
    `no other rule should mention a hidden element: ${JSON.stringify(others.map((f) => f.rule))}`);
});

test('required text at zero opacity fails too', async () => {
  const slide = await measure(page(
    `<div class="region region--content" data-deck-ignore></div>
     <h1 data-deck-id="title" data-deck-role="title" class="ghost">消えた見出し</h1>`,
    { extraCss: '.ghost { position:absolute; left:60px; top:200px; font-size:40px; opacity:0 }', slideId: 'fx' },
  ));
  const storyboard = { slides: [{ id: 'fx', page_type: 'cover', purpose: 'p', title: '消えた見出し', subtitle: null }] };
  const content = runLint({ slides: [slide], theme: T, storyboard }).findings
    .filter((f) => f.rule === 'content-integrity');
  assert.equal(content.length, 1);
  assert.match(content[0].message, /opacity|NOT VISIBLE/);
});

test('a slide whose required text IS painted produces no content finding', async () => {
  const slide = await measure(page(
    `<div class="region region--content" data-deck-ignore></div>
     <h1 data-deck-id="title" data-deck-role="title">見える見出し</h1>`,
    { extraCss: 'h1 { position:absolute; left:60px; top:200px; font-size:40px }', slideId: 'fx' },
  ));
  const storyboard = { slides: [{ id: 'fx', page_type: 'cover', purpose: 'p', title: '見える見出し', subtitle: null }] };
  assert.deepEqual(
    runLint({ slides: [slide], theme: T, storyboard }).findings.filter((f) => f.rule === 'content-integrity'),
    [],
  );
});


// ---------------------------------------------------------------------------
// T20: BOUNDARY FIXTURES for the line-box model.
//
// The ink union removes the font's leading by snapping each text rect onto
// the line box slot its element lays out, rather than by allowing an
// overhang. These exercise the cases where a font-metric model and a
// geometry model disagree, at both sides of the tolerance.
// ---------------------------------------------------------------------------

/** Measure the reported vertical displacement of a centred stack. */
async function reportedDy(extraCss, inner = '<h1 class="fx" data-deck-id="title">見出し</h1>') {
  const slide = await measure(page(
    `<div class="stack" data-deck-id="stack" data-deck-placement="${contract()}">${inner}</div>`,
    { extraCss },
  ));
  const el = slide.elements.find((e) => e.id === 'stack');
  return {
    dy: el.content_union.cy - slide.regions['content-region'].cy,
    dx: el.content_union.cx - slide.regions['content-region'].cx,
    findings: centringRule({ slides: [slide], theme: T }),
    slide,
  };
}

test('A FIXED-HEIGHT HEADING PUSHED BY padding-top IS MEASURED EXACTLY', async () => {
  // THE F1 CASE. A heading whose border-box height equals its line-height
  // keeps its box centred while padding pushes the TEXT down. The font box
  // overhangs its line box asymmetrically - measured on Noto Sans JP at
  // 56 px: 1.0 px above and 5.28 px below - so a per-side allowance against
  // the total leading let the push hide inside it, and a 3 px padding moved
  // the painted text 2.14 px while the rule reported 0.00 and passed.
  const BOX = 'box-sizing:border-box;height:80px;line-height:80px;font-size:56px';
  for (const pad of [0, 1, 1.9, 2, 2.1, 3, 4, 8]) {
    const { dy, findings } = await reportedDy(`.fx{${BOX};${pad ? `padding-top:${pad}px` : ''}}`);
    // The reported displacement must BE the push, to within a layout unit.
    assert.ok(Math.abs(dy - pad) < 0.05,
      `padding-top:${pad}px should report dy ${pad}, reported ${dy.toFixed(4)}`);
    const fired = findings.filter((f) => f.axis === 'y').length;
    if (pad > 2) {
      assert.equal(fired, 1, `padding-top:${pad}px is over tolerance and must fail`);
    } else {
      assert.equal(fired, 0, `padding-top:${pad}px is within tolerance and must pass (dy ${dy.toFixed(4)})`);
    }
  }
});

test('padding-BOTTOM does not move the text, and is reported as not moving it', async () => {
  // Chrome confirms the text does NOT move: with a fixed border-box height,
  // padding-bottom shrinks the content box BELOW the single line box, which
  // still starts at the content top. Asserted because the obvious guess -
  // that it mirrors padding-top - is wrong, and a model that "fixed" this
  // into a displacement would be inventing one.
  const BOX = 'box-sizing:border-box;height:80px;line-height:80px;font-size:56px';
  for (const pad of [2, 3, 8]) {
    const { dy, findings } = await reportedDy(`.fx{${BOX};padding-bottom:${pad}px}`);
    assert.ok(Math.abs(dy) < 0.05,
      `padding-bottom:${pad}px does not move the text, so dy must be 0; got ${dy.toFixed(4)}`);
    assert.equal(findings.filter((f) => f.axis === 'y').length, 0);
  }
});

test('MIXED FONT SIZES in one stack centre exactly, at the boundary too', async () => {
  // Different sizes reserve different leading, which is what made a
  // symmetric subtraction wrong. Snapping to line boxes removes the font
  // metric from the answer entirely.
  const inner = `
    <div data-deck-id="a" style="font-size:72px;line-height:1.2">大</div>
    <div data-deck-id="b" style="font-size:20px;line-height:1.6">小</div>
    <div data-deck-id="c" style="font-size:40px;line-height:1.35">中</div>`;
  const clean = await reportedDy('', inner);
  assert.ok(Math.abs(clean.dy) < 0.05, `mixed sizes must centre: dy ${clean.dy.toFixed(4)}`);
  assert.deepEqual(clean.findings, []);

  const pushed = await reportedDy('.stack{padding-top:5px}', inner);
  assert.ok(Math.abs(pushed.dy - 2.5) < 0.05, `dy ${pushed.dy.toFixed(4)}`);
  assert.equal(pushed.findings.filter((f) => f.axis === 'y').length, 1);
});

test('an INLINE wrapper inside a block does not disturb the measurement', async () => {
  // An inline element's box is the union of the line boxes it spans, not a
  // container with a content edge, so it is left unsnapped and its block
  // parent supplies the slot.
  const inner = '<p data-deck-id="title" style="font-size:32px;line-height:1.5">これは<span style="font-size:48px">大きい語</span>を含む行</p>';
  const { dy, findings } = await reportedDy('', inner);
  assert.ok(Math.abs(dy) < 1.5, `an inline wrapper must not move the centre: dy ${dy.toFixed(4)}`);
  assert.deepEqual(findings, []);
});

test('SUPERSCRIPT does not move the measured centre', async () => {
  const inner = '<p data-deck-id="title" style="font-size:40px;line-height:1.4">注記<sup>1</sup>のある見出し</p>';
  const { dy, findings } = await reportedDy('', inner);
  assert.ok(Math.abs(dy) < 1.5, `a superscript must not move the centre: dy ${dy.toFixed(4)}`);
  assert.deepEqual(findings, []);
});

test('RUBY text does not move the measured centre', async () => {
  const inner = '<p data-deck-id="title" style="font-size:40px;line-height:1.6"><ruby>漢字<rt>かんじ</rt></ruby>のある見出し</p>';
  const { dy } = await reportedDy('', inner);
  assert.ok(Math.abs(dy) < 2, `ruby must not move the centre beyond tolerance: dy ${dy.toFixed(4)}`);
});

test('A TRANSFORMED element falls back to the font box rather than mis-snapping', async () => {
  // The slot arithmetic is in untransformed coordinates and the rects are
  // not, so a transformed element is left alone. Stated as a known limit:
  // its measurement carries the font's asymmetry.
  const { slide } = await reportedDy(
    '.fx{font-size:56px;line-height:1.37;transform:translateY(0px)}',
  );
  const el = slide.elements.find((e) => e.id === 'title');
  // The ink is still measured - it is simply the font box, which is taller
  // than the line box.
  assert.ok(el.content_union.h > 0, 'a transformed element must still be measured');
  assert.ok(el.content_union.h >= el.rect.h - 1,
    'and its unsnapped font box is at least as tall as its line box');
});

test('A REAL TRANSLATION is still caught on a transformed element', async () => {
  const { dy, findings } = await reportedDy(
    '.fx{font-size:56px;line-height:1.37;transform:translateY(20px)}',
  );
  assert.ok(dy > 15, `a 20 px translate must show up: dy ${dy.toFixed(2)}`);
  assert.equal(findings.filter((f) => f.axis === 'y').length, 1);
});

test('line-height:normal falls back to the font box and still centres', async () => {
  const { dy, findings } = await reportedDy('.fx{font-size:48px;line-height:normal}');
  // No slot height to snap to, so the font box is used; its asymmetry is
  // small enough at this size to stay inside tolerance.
  assert.ok(Math.abs(dy) <= 2, `line-height:normal should stay within tolerance: dy ${dy.toFixed(4)}`);
  assert.equal(findings.filter((f) => f.axis === 'y').length, 0);
});
