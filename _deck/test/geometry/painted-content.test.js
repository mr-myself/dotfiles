import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DECK_HOME, theme } from '../helpers.js';
import { closeBrowser, measure, page } from './fixture.js';

process.env.DECK_HOME = DECK_HOME;
const T = await theme();
const { runLint } = await import('../../src/lint/engine.js');
const { requiredText } = await import('../../src/lint/rules/content-integrity.js');
const { TEMPLATES } = await import('../../src/render/templates.js');
const { themeVariables, fontFaces } = await import('../../src/theme/css.js');
const { fileUrl } = await import('../../src/render/html.js');
const path = (await import('node:path')).default;

after(closeBrowser);

/**
 * T19: PAINTED-CONTENT COVERAGE, field by field.
 *
 * The generated content tests assert that the rendered MARKUP contains each
 * string. That is not the same question: markup containing text says nothing
 * about whether the delivered page paints it, and it is exactly why the
 * requiredText() omissions went unnoticed - paragraph text, body bullets and
 * card bullets were in the HTML and outside every rule's coverage.
 *
 * These render a real slide through the real template in real Chrome, hide
 * one field at a time, and require content-integrity to fail for it.
 */

/** Render a slide through its real template and measure it. */
async function renderSlide(slide, extraCss = '') {
  const inner = TEMPLATES[slide.page_type]({
    theme: T, slide, index: 0, total: 1, assets: {}, pageNumbers: true,
  });
  const toUrl = (rel) => fileUrl(path.join(T.__dir, rel));
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>
${fontFaces(T, toUrl)}
${themeVariables(T)}
${(await import('node:fs')).default.readFileSync(T.__css, 'utf8')}
${extraCss}
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

/** A standard-3col slide exercising every text field that page type renders. */
function richSlide() {
  return {
    id: 'rich',
    page_type: 'standard-3col',
    purpose: '全フィールドを描画する',
    section_label: 'セクション',
    title: 'タイトル',
    subtitle: 'サブタイトル',
    body: [
      { kind: 'paragraph', text: '段落のテキスト' },
      { kind: 'bullets', items: ['本文の箇条書き一', '本文の箇条書き二'] },
      {
        kind: 'cards',
        cards: [{ heading: 'カード見出し', body: 'カード本文', items: ['カードの箇条書き'] }],
      },
    ],
    footer: { label: 'ラベル', text: 'フッターの文' },
  };
}

test('requiredText covers EVERY field the template renders', async () => {
  const slide = richSlide();
  const covered = requiredText(slide);
  const html = TEMPLATES[slide.page_type]({ theme: T, slide, index: 0, total: 1, assets: {}, pageNumbers: true });

  // Each covered field must be in the markup under the id it claims...
  for (const { field, elementId, text } of covered) {
    assert.ok(html.includes(`data-deck-id="${elementId}"`),
      `${field} claims element "${elementId}", which the template does not emit`);
  }
  // ...and every text the template renders must be covered by SOME field.
  const everyString = [
    'セクション', 'タイトル', 'サブタイトル', '段落のテキスト',
    '本文の箇条書き一', '本文の箇条書き二',
    'カード見出し', 'カード本文', 'カードの箇条書き',
    'ラベル', 'フッターの文',
  ];
  for (const s of everyString) {
    assert.ok(html.includes(s), `the fixture must actually render ${s}`);
    assert.ok(covered.some((c) => c.text === s),
      `"${s}" is rendered but requiredText does not cover it, so hiding it would fail nothing`);
  }
});

test('a fully rendered slide produces NO content-integrity finding', async () => {
  const slide = richSlide();
  const measured = await renderSlide(slide);
  const findings = runLint({ slides: [measured], theme: T, storyboard: { slides: [slide] } })
    .findings.filter((f) => f.rule === 'content-integrity');
  assert.deepEqual(findings, [], JSON.stringify(findings.map((f) => f.message)));
});

// Hiding each field in turn. The element ids come from requiredText itself,
// so a field added to the template and to requiredText is covered here
// automatically.
for (const { field, elementId, text } of requiredText(richSlide())) {
  test(`HIDDEN: ${field} ("${text}") fails content-integrity`, async () => {
    const measured = await renderSlide(richSlide(), `[data-deck-id="${elementId}"] { display: none }`);
    const result = runLint({ slides: [measured], theme: T, storyboard: { slides: [richSlide()] } });
    const content = result.findings.filter((f) => f.rule === 'content-integrity');
    assert.equal(content.length, 1,
      `expected exactly one content finding for ${field}, got ${JSON.stringify(content.map((f) => f.message))}`);
    assert.equal(content[0].element, elementId);
    assert.match(content[0].message, /NOT VISIBLE|was not rendered at all/);
  });

  test(`TRANSPARENT: ${field} ("${text}") fails content-integrity`, async () => {
    const measured = await renderSlide(richSlide(), `[data-deck-id="${elementId}"] { color: transparent }`);
    const result = runLint({ slides: [measured], theme: T, storyboard: { slides: [richSlide()] } });
    const content = result.findings.filter((f) => f.rule === 'content-integrity');
    assert.ok(content.some((f) => f.element === elementId),
      `transparent ${field} produced no finding: ${JSON.stringify(result.findings.map((f) => `${f.rule}:${f.element}`))}`);
    const mine = content.find((f) => f.element === elementId);
    assert.match(mine.message, /paints nothing/);
    assert.equal(mine.measured.colour_alpha, 0);
  });
}

test('an ancestor at opacity 0 fails content-integrity for the text inside it', async () => {
  const slide = richSlide();
  const measured = await renderSlide(slide, '.headline { opacity: 0 }');
  const content = runLint({ slides: [measured], theme: T, storyboard: { slides: [slide] } })
    .findings.filter((f) => f.rule === 'content-integrity');
  // The headline holds the section label, the title and the subtitle.
  assert.ok(content.length >= 3, JSON.stringify(content.map((f) => f.element)));
  for (const f of content) assert.match(f.message, /paints nothing/);
});

test('NEARLY transparent text is the CONTRAST rule\'s, not content-integrity\'s', async () => {
  // The division between the two rules, asserted so neither can drift into
  // assuming the other covers this band.
  const slide = richSlide();
  const measured = await renderSlide(slide, '[data-deck-id="title"] { color: rgba(0,0,0,0.02) }');
  const result = runLint({ slides: [measured], theme: T, storyboard: { slides: [slide] } });
  const content = result.findings.filter((f) => f.rule === 'content-integrity' && f.element === 'title');
  const contrast = result.findings.filter((f) => f.rule === 'contrast' && f.element === 'title');
  assert.deepEqual(content, [], 'alpha 0.02 IS painted, so content-integrity must not claim it is absent');
  assert.equal(contrast.length, 1, 'and contrast must fail it on the ratio');
  assert.ok(contrast[0].measured.ratio < 1.2, `ratio was ${contrast[0].measured.ratio}`);
});

test('text rendered into the WRONG element is caught', async () => {
  const slide = richSlide();
  const broken = { ...slide, title: 'この文字列は描画されない' };
  const measured = await renderSlide(slide);   // rendered from the ORIGINAL
  const content = runLint({ slides: [measured], theme: T, storyboard: { slides: [broken] } })
    .findings.filter((f) => f.rule === 'content-integrity');
  assert.ok(content.some((f) => f.element === 'title' && /not the text that was rendered/.test(f.message)),
    JSON.stringify(content.map((f) => f.message)));
});
