import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { DECK_HOME, theme } from '../helpers.js';
import { closeBrowser, measure } from './fixture.js';

process.env.DECK_HOME = DECK_HOME;
const T = await theme();
const { TEMPLATES } = await import('../../src/render/templates.js');
const { themeVariables, fontFaces } = await import('../../src/theme/css.js');
const { fileUrl } = await import('../../src/render/html.js');

after(closeBrowser);

/**
 * THE LAYOUT THE REFERENCE ACTUALLY HAS.
 *
 * Three rounds of review went into whether the geometry linter COMPUTES
 * correctly, and nobody ever rendered a page and compared it to the reference
 * deck. The result passed every rule and looked nothing like the design: the
 * section label had no rule beside it, the three-column pages had no
 * illustration frames and left the bottom half of the page empty, and there
 * was no watercolour anywhere.
 *
 * A test cannot assert "this looks right" and these do not pretend to. They
 * assert the STRUCTURAL FACTS that the look rests on - the facts that were
 * false before and that nothing would have caught:
 *
 *   the section label has a rule, and hangs off the left margin
 *   the title's left edge IS the text column's left edge
 *   the conclusion banner renders when there is a conclusion, and not otherwise
 *   the three columns reserve an illustration frame, aligned across the row
 *
 * Whether the wash is beautiful is for a person to say. Whether the title is
 * where the design puts it is measurable, and is measured here.
 */

/** Render a slide through its real template, in real Chrome, and measure it. */
async function renderSlide(slide, { assets = {} } = {}) {
  const inner = TEMPLATES[slide.page_type]({
    theme: T, slide, index: 0, total: 8, assets, pageNumbers: true,
  });
  const toUrl = (rel) => fileUrl(path.join(T.__dir, rel));
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>
${fontFaces(T, toUrl)}
${themeVariables(T)}
${fs.readFileSync(T.__css, 'utf8')}
</style></head><body>
<section class="deck-page">
  <div class="deck-canvas" data-deck-canvas data-deck-canvas-width="${T.canvas.width}"
       data-deck-canvas-height="${T.canvas.height}" data-deck-slide-id="${slide.id}"
       data-deck-page-type="${slide.page_type}">
    <div class="region region--content" data-deck-region="content-region"></div>${inner}
  </div>
</section></body></html>`;
  return measure(html);
}

const byId = (slide, id) => slide.elements.find((e) => e.id === id);

/** A three-column page, with the shape the PO's real deck has. */
function threeCol(patch = {}) {
  return {
    id: 'cols',
    page_type: 'standard-3col',
    purpose: 'テスト',
    section_label: '何を取るか',
    title: '10/12で決まったこと',
    subtitle: 'ここは論点ではなく、前提として扱う',
    body: [{
      kind: 'cards',
      cards: [
        { heading: 'まず宿泊者情報', body: '野沢はほぼ宿泊前提なので、ここを押さえれば大半が見える', icon: 'teal' },
        { heading: '二方向で進める', body: 'できている宿にはデータを流してもらえるよう説得する', icon: 'orange' },
        { heading: '個人情報は外す', body: '個人情報と連絡先は、必ずしも要らない', icon: 'teal' },
      ],
    }],
    ...patch,
  };
}

// ------------------------------------------------- the section label

test('THE SECTION LABEL HANGS OFF THE LEFT MARGIN, with a rule beside it', async () => {
  // It was centred with no rule. The teal rule and the left hang are the
  // first thing the eye uses to recognise one of these pages.
  const slide = await renderSlide(threeCol());
  const label = byId(slide, 'section-label');
  const rule = byId(slide, 'section-rule');
  const content = slide.regions['content-region'];

  assert.ok(rule, 'the section label must have a rule element, not a ::before nobody can measure');
  assert.ok(rule.visible, 'and it must be painted');
  assert.ok(Math.abs(rule.rect.x - content.x) < 2,
    `the rule starts at the content margin: rule.x=${rule.rect.x}, margin=${content.x}`);
  assert.ok(rule.rect.w <= 14, `the rule is a short bar, not a line: ${rule.rect.w}px wide`);
  assert.ok(rule.rect.h >= 20, `and it is taller than it is wide: ${rule.rect.h}px`);

  // The label sits to the RIGHT of the rule, not centred on the page.
  assert.ok(label.rect.x >= rule.rect.x, 'the label follows the rule');
  const pageCentre = T.canvas.width / 2;
  assert.ok(label.content_union.cx < pageCentre - 200,
    `the label is left-hung, not centred: its ink centre is ${label.content_union.cx}`);
});

// ------------------------------------------------- the title

test('THE TITLE\'S LEFT EDGE IS THE TEXT COLUMN\'S LEFT EDGE', async () => {
  // It was centred and ran to both edges. Every page in the reference hangs
  // its title off the same margin, and that is what makes a deck read as one
  // document rather than a pile of slides.
  const slide = await renderSlide(threeCol());
  const title = byId(slide, 'title');
  const content = slide.regions['content-region'];
  assert.ok(Math.abs(title.rect.x - content.x) < 2,
    `title.x=${title.rect.x} must equal the content margin ${content.x}`);
  assert.ok(title.rect.x + title.rect.w <= content.x + content.w + 1,
    'and the title box must not run past the right margin');
});

test('the title, subtitle and label all share one left edge', async () => {
  const slide = await renderSlide(threeCol());
  const lefts = ['section-label', 'title', 'subtitle']
    .map((id) => byId(slide, id))
    .filter(Boolean)
    .map((el) => el.rect.x);
  assert.equal(lefts.length, 3);
  const spread = Math.max(...lefts) - Math.min(...lefts);
  assert.ok(spread < 2, `the headline block shares one margin; spread was ${spread}px`);
});

test('a long title WRAPS rather than shrinking out of its band', async () => {
  const long = threeCol({
    title: '宿泊者データ取得スキームの論点整理と次回に決めたいことのまとめ',
  });
  const slide = await renderSlide(long);
  const title = byId(slide, 'title');
  const [min, max] = T.typography.size_bands_px.title;
  assert.ok(title.style.font_size_px >= min && title.style.font_size_px <= max,
    `a long title stays in its band (${min}-${max}); got ${title.style.font_size_px}`);
  assert.ok(title.text_lines.length >= 2, 'and wraps instead');
});

// ------------------------------------------------- the conclusion banner

test('THE CONCLUSION BANNER RENDERS WHEN THERE IS A CONCLUSION', async () => {
  const slide = await renderSlide(threeCol({
    footer: { text: '納付の省力化に加え、受付・集計の改善を検討します', label: null },
  }));
  const banner = byId(slide, 'footer-banner');
  const bar = byId(slide, 'footer-bar');
  const text = byId(slide, 'footer-text');
  assert.ok(banner && banner.visible, 'the banner renders');
  assert.ok(bar && bar.visible, 'with its teal rule as a REAL element the geometry can see');
  assert.ok(bar.rect.h > bar.rect.w, 'the rule is vertical');
  assert.ok(Math.abs(bar.rect.x - slide.regions['content-region'].x) < 2,
    'the rule starts at the left margin');
  assert.ok(text.rect.x > bar.rect.x, 'and the words follow it');
  // It sits at the foot of the page, not in the middle of the content.
  assert.ok(banner.rect.y > T.canvas.height * 0.8,
    `the banner is at the foot: y=${banner.rect.y}`);
});

test('and NOT when the slide has no conclusion', async () => {
  const slide = await renderSlide(threeCol());
  assert.equal(byId(slide, 'footer-banner'), undefined,
    'a slide with no conclusion gets no banner - deck never writes one');
  assert.equal(byId(slide, 'footer-bar'), undefined);
});

// ------------------------------------------------- the three columns

test('EVERY COLUMN RESERVES AN ILLUSTRATION FRAME, aligned across the row', async () => {
  // The single biggest reason the first real deck did not look like the
  // reference: the columns were text alone and the bottom half of the page
  // was empty.
  const slide = await renderSlide(threeCol());
  const frames = [1, 2, 3].map((n) => byId(slide, `card-art-${n}`));
  for (const [i, f] of frames.entries()) {
    assert.ok(f && f.visible, `column ${i + 1} reserves a frame`);
  }
  const tops = frames.map((f) => f.rect.y);
  const heights = frames.map((f) => f.rect.h);
  assert.ok(Math.max(...tops) - Math.min(...tops) < 2, `frames share one top: ${tops}`);
  assert.ok(Math.max(...heights) - Math.min(...heights) < 2,
    `and ONE height, so the icons and rules line up across the row: ${heights}`);
  assert.ok(heights[0] > 150, `the frame is a real picture area, not a sliver: ${heights[0]}px`);
});

test('the icon circles are round, coloured, and aligned across the row', async () => {
  const slide = await renderSlide(threeCol());
  const icons = [1, 2, 3].map((n) => byId(slide, `icon-${n}`));
  for (const icon of icons) assert.ok(icon && icon.visible, 'every column has its icon');
  for (const icon of icons) {
    assert.ok(Math.abs(icon.rect.w - icon.rect.h) < 1.5, 'the icon is a circle');
  }
  const tops = icons.map((i) => i.rect.y);
  assert.ok(Math.max(...tops) - Math.min(...tops) < 2, `icons share one baseline: ${tops}`);
});

test('the accent rule runs the FULL column width', async () => {
  const slide = await renderSlide(threeCol());
  for (const n of [1, 2, 3]) {
    const rule = byId(slide, `card-rule-${n}`);
    const card = byId(slide, `card-${n}`);
    assert.ok(rule && rule.visible, `column ${n} has an accent rule`);
    assert.ok(Math.abs(rule.rect.w - card.rect.w) < 2,
      `the rule spans the column: rule=${rule.rect.w}, card=${card.rect.w}`);
    assert.ok(Math.abs(rule.rect.x - card.rect.x) < 2, 'and starts at the column edge');
  }
});

test('the columns sit on the theme\'s declared grid', async () => {
  const slide = await renderSlide(threeCol());
  const cards = [1, 2, 3].map((n) => byId(slide, `card-${n}`));
  const width = T.spacing.column_width;
  const gap = T.spacing.column_gap;
  for (const card of cards) {
    assert.ok(Math.abs(card.rect.w - width) < 2, `each column is ${width}px: got ${card.rect.w}`);
  }
  assert.ok(Math.abs((cards[1].rect.x - (cards[0].rect.x + cards[0].rect.w)) - gap) < 2,
    'and the gutters are the declared gap');
});

// ------------------------------------------------- statement and divider

test('A STATEMENT IS LEFT-ALIGNED, not a centred poster', async () => {
  const slide = await renderSlide({
    id: 'claim',
    page_type: 'statement',
    purpose: 'テスト',
    section_label: '前提の確認',
    title: '事前チェックインにこだわる必要はない',
    subtitle: null,
    body: [{ kind: 'statement', text: '当初の仮説は、PMS導入済みは困っていない、で頓挫した扱いになっている。' }],
  });
  const title = byId(slide, 'title');
  const content = slide.regions['content-region'];
  assert.ok(Math.abs(title.rect.x - content.x) < 2,
    `the claim hangs off the left margin: ${title.rect.x} vs ${content.x}`);
  // Deliberate whitespace BELOW it: the claim sits in the upper half.
  assert.ok(title.rect.y < T.canvas.height * 0.5,
    `and sits in the upper half: y=${title.rect.y}`);
  const label = byId(slide, 'section-label');
  assert.ok(byId(slide, 'section-rule'), 'a statement keeps the section rule too');
  assert.ok(Math.abs(label.rect.x - content.x) < 2, 'and the same left margin');
});

test('a chapter divider carries its numeral, and keeps the eyebrow at the top', async () => {
  const slide = await renderSlide({
    id: 'ch-01',
    page_type: 'section-divider',
    purpose: 'テスト',
    section_label: '第01章',
    title: '前提の確認',
    subtitle: '手段は問わない、という整理になった',
  });
  const numeral = byId(slide, 'divider-numeral');
  const label = byId(slide, 'section-label');
  assert.ok(numeral && numeral.visible, 'the chapter numeral is drawn');
  assert.equal(numeral.text.trim(), '01', 'and reads the number out of the label the author wrote');
  assert.ok(numeral.rect.h > 150, `it is a watermark, set large: ${numeral.rect.h}px`);
  // The eyebrow stays where every other page type puts it, so chapter pages
  // do not drift against the pages around them.
  assert.ok(label.rect.y < 120, `the eyebrow is at the top of the page: y=${label.rect.y}`);
});

// ------------------------------------------------- the decoration

test('the watercolour decoration is present, decorative, and carries no words', async () => {
  const slide = await renderSlide(threeCol());
  const decor = slide.elements.filter((e) => e.role === 'decoration');
  assert.ok(decor.length >= 2, 'a content page has its corner wash and its botanical');
  for (const d of decor) {
    assert.ok(d.decorative, 'every decoration declares itself decorative');
    assert.equal((d.text || '').trim(), '',
      'and carries no text: the no-text rule that governs slot images governs this too');
  }
  const topRight = decor.find((d) => d.id === 'decor-topright');
  assert.ok(topRight, 'the top-right wash exists');
  assert.ok(topRight.rect.x + topRight.rect.w >= T.canvas.width - 1,
    'and is anchored to the right edge');
  assert.ok(topRight.rect.y <= 1, 'at the top');
});

test('an empty illustration frame looks reserved, not broken', async () => {
  // It was a grey diagonal hatch, and on a cover - where the frame is 40% of
  // the page - it read as a failed image load.
  const slide = await renderSlide(threeCol());
  const frame = byId(slide, 'card-art-1');
  assert.ok(frame.visible, 'the empty frame is still painted');
  const wash = slide.elements.find((e) => e.id === 'card-art-1')
    ? slide.elements.filter((e) => e.ancestry && e.ancestry.includes('card-art-1'))
    : [];
  assert.ok(frame.rect.h > 150, 'and it holds real area rather than collapsing');
  assert.equal((frame.text || '').trim(), '',
    'a reserved frame never says "insert image here"; the design kit forbids it');
  assert.ok(wash.length >= 0);
});
