import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import YAML from 'yaml';
import { DECK_BIN, DECK_HOME, rm, tempDir } from '../helpers.js';
import { buildFixture } from '../fixtures/full-deck/build.mjs';

process.env.DECK_HOME = DECK_HOME;

/**
 * THE PO'S DESIGN REVIEW OF THE RENDERED FIXTURE, AS TESTS.
 *
 * Five notes, all reproduced by opening the PNGs. The ones that can be pinned
 * by measurement are pinned here; the ones that are a judgement about how a
 * page READS are pinned by their structural cause, which is the part a future
 * change can silently undo.
 *
 * The PO's verdict on the whole, for the record, because it is the bar these
 * have to not fall below again: 見た目がこのくらいのクオリティなら最初から
 * 中身の話できそう.
 */

let W = null;

before(() => {
  const root = tempDir('design-review');
  const state = tempDir('design-review-state');
  const dir = path.join(root, 'deck');
  buildFixture(dir, { deckBin: DECK_BIN });
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync(DECK_BIN, ['gate', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, DECK_STATE_ROOT: state } }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };
  assert.equal(run(['render']).code, 0);
  W = {
    dir,
    run,
    geometry: JSON.parse(fs.readFileSync(path.join(dir, 'out', 'geometry.json'), 'utf8')),
    theme: YAML.parse(fs.readFileSync(path.join(DECK_HOME, 'themes', 'watercolor', 'theme.yaml'), 'utf8')),
    cleanup: () => { rm(root); rm(state); },
  };
});

after(() => { if (W) W.cleanup(); });

/** @param {string} id */
function slide(id) {
  const s = W.geometry.slides.find((x) => x.slide_id === id);
  assert.ok(s, `no measured slide "${id}"`);
  return s;
}

/** Content ink, by the same definition the occupancy rule uses. */
function contentInk(s) {
  const r = s.regions['content-region'];
  return s.elements.filter((el) => el.visible && !el.decorative && !el.background_of
    && !['pagination', 'decorative'].includes(el.zone)
    && !(el.slot && el.slot_state !== 'filled')
    && (el.content_union || ['img', 'svg', 'canvas'].includes(el.tag)))
    .map((el) => el.content_union || el.rect)
    .filter((u) => u && u.y + u.h > r.y && u.y < r.y + r.h);
}

/**
 * THE LARGEST UNUSED BAND in a page's content region, as a fraction of it.
 *
 * This is the measurement the PO's eye performed and the occupancy rule did
 * not: a trailing-gap metric scored the process page 0.0% because its note sat
 * at the very bottom, while the band BETWEEN the figure and that note was 41%
 * of the page. A hole in the middle is still a hole.
 *
 * @param {any} s
 */
function largestGap(s) {
  const r = s.regions['content-region'];
  const bands = contentInk(s)
    .map((u) => [Math.max(u.y, r.y), Math.min(u.y + u.h, r.y + r.h)])
    .sort((a, b) => a[0] - b[0]);
  let cursor = r.y;
  let biggest = 0;
  for (const [top, bottom] of bands) {
    biggest = Math.max(biggest, top - cursor);
    cursor = Math.max(cursor, bottom);
  }
  return Math.max(biggest, r.y + r.h - cursor) / r.h;
}

// ---------------------------------------------------------------------------
// 1. The statement page reads as a title slide.
// ---------------------------------------------------------------------------

test('STATEMENT: the claim sits on the page centre, not where a cover title starts', () => {
  // PO: p5はだめ. なんで急にタイトルみたいなのが出てきてるのか謎.
  //
  // The structural cause: the stack was top-aligned with a 118 px lead-in,
  // which is exactly where a cover title begins. A title page starts at the
  // top; a deliberate pause sits in the middle. That is the one signal a
  // reader cannot miss and it costs nothing.
  const s = slide('the-point');
  const region = s.regions['content-region'];
  const stack = s.elements.find((el) => el.id === 'statement-stack');
  assert.ok(stack, 'the statement page must have its stack');

  const ink = stack.content_union;
  const regionCentre = region.y + region.h / 2;
  assert.ok(Math.abs(ink.y + ink.h / 2 - regionCentre) < region.h * 0.12,
    `the claim's ink is centred at ${(ink.y + ink.h / 2).toFixed(0)} and the content region's centre `
    + `is ${regionCentre.toFixed(0)}. A statement that starts at the top of the page reads as a title slide.`);

  // VERTICAL POSITION ALONE DOES NOT SEPARATE THEM on this theme - its cover
  // text is centred in the left panel too, at y=332 against the statement's
  // y=306. The separation is in the other two signals, and both are measured:
  // the claim is set well below cover size, and the cover carries bleeding
  // artwork down its whole right side while the statement carries none.
  const coverTitle = slide('cover').elements.find((el) => el.id === 'title');
  const claim = s.elements.find((el) => el.id === 'title');
  assert.ok(claim.style.font_size_px < coverTitle.style.font_size_px * 0.85,
    `the claim is ${claim.style.font_size_px} px against a cover title's ${coverTitle.style.font_size_px}; `
    + 'at cover size it reads as a cover');
  assert.equal(s.elements.filter((el) => el.zone === 'bleed' && el.visible).length, 0,
    'a statement page carries no bleeding artwork; the design kit forbids filling it (不要なイラストで埋めない)');
  assert.ok(slide('cover').elements.some((el) => el.zone === 'bleed' && el.visible),
    'the premise: a cover does carry it');
});

test('STATEMENT: the page carries the framing every other content page has', () => {
  // The eyebrow says where in the argument this is; the banner says what to
  // take from it. Without either, the page is a large sentence on white with
  // nothing saying why the deck stopped - which is what the PO was looking at.
  const s = slide('the-point');
  for (const id of ['section-label', 'footer-banner', 'footer-text']) {
    assert.ok(s.elements.some((el) => el.id === id && el.visible),
      `a statement page must render ${id}`);
  }
});

// ---------------------------------------------------------------------------
// 2 and 3. Pages that leave a third of the canvas empty.
// ---------------------------------------------------------------------------

test('NO PAGE TYPE LEAVES A THIRD OF THE CANVAS EMPTY', () => {
  // PO, on p7: 絵も入れる前提にしたほうがよい. On p9: a page type must compose
  // the whole canvas. Measured before the fix, as fractions of the content
  // region: process 41.0%, timeline 35.1%, ecosystem(layers) 30.2%,
  // comparison 21.2%.
  const exempt = new Set(W.theme.lint.occupancy.exempt);
  for (const s of W.geometry.slides) {
    if (exempt.has(s.page_type)) continue;
    const gap = largestGap(s);
    assert.ok(gap < 0.20,
      `${s.slide_id} (${s.page_type}) leaves ${(gap * 100).toFixed(1)}% of its content region as one `
      + 'unbroken empty band. A page type has to compose the whole canvas.');
  }
});

test('THE DIAGRAM PAGE TYPES RESERVE AN ILLUSTRATION BAND', () => {
  // Reserved whether or not a picture has arrived, exactly as a three-column
  // page reserves its frames.
  for (const id of ['options', 'how', 'foundation', 'when']) {
    const band = slide(id).elements.find((el) => el.id === 'diagram-art');
    assert.ok(band, `${id} must reserve an illustration band`);
    assert.ok(band.rect.h >= W.theme.spacing.diagram_art_min_height - 1,
      `${id}: the band is ${band.rect.h.toFixed(0)} px, under the theme's floor`);
  }
});

test('THE RESERVED BAND NEVER PUSHES ITSELF OFF THE PAGE', () => {
  // A fixed-height band fitted a process page and overflowed a comparison's
  // bottom margin by 61 px, because these figures grow with their content.
  // The band absorbs the slack instead, so it cannot overflow whatever the
  // figure above it does.
  for (const s of W.geometry.slides) {
    const band = s.elements.find((el) => el.id === 'diagram-art');
    if (!band) continue;
    const r = s.regions['content-region'];
    assert.ok(band.rect.y + band.rect.h <= r.y + r.h + 1,
      `${s.slide_id}: the reserved band runs ${(band.rect.y + band.rect.h - r.y - r.h).toFixed(0)} px past the bottom margin`);
  }
});

test('EVERY RESERVED BAND REACHES THE BRIEF, with its size and where it sits', () => {
  // THE WHOLE POINT, in the PO's words: 生成はしなくていいので、挿入すること
  // をchatgptに伝えることが大事. A reserved frame that never reaches the brief
  // is useless - that combination is what left fourteen slots empty.
  assert.equal(W.run(['prompts', '--single']).code, 0);
  const brief = fs.readFileSync(path.join(W.dir, 'out', 'prompts-single.md'), 'utf8');
  for (const [id, slideId] of [
    ['comparison-art', 'options'], ['process-art', 'how'],
    ['ecosystem-art', 'foundation'], ['timeline-art', 'when'],
  ]) {
    assert.match(brief, new RegExp(`file name: \\d+-${slideId}-${id}\\.png`),
      `${id} must appear in the single brief, named after its slide`);
    assert.ok(brief.includes(`slide "${slideId}"`), `${id}'s entry must name its slide`);
  }
  assert.match(brief, /a wide band across the FULL WIDTH of the page/,
    'the brief must say where on the slide the band sits');
  assert.match(brief, /keep the subject away from the top and bottom edges/,
    'and that it is cropped to the band, since the band takes its height from the figure above it');
});

// ---------------------------------------------------------------------------
// 4. The note rendered two different ways.
// ---------------------------------------------------------------------------

test('A FIGURE NOTE IS ATTACHED TO ITS FIGURE, not floating at the foot of the page', () => {
  // PO: P7-P11までの左下のなぞのテキストはなに？ The note was rendering at the
  // very bottom of the page - where the footer banner sits on every other page
  // - because the figure above it was pinned to the top with margin-bottom:
  // auto. It is a different field from `footer` with a different meaning, and
  // the design kit gives it its own size band; what it was missing was not
  // ornament but attachment.
  const cases = [
    ['options', 'comparison-note', 'comparison'],
    ['how', 'process-note', 'process'],
    ['foundation', 'ecosystem-note', 'ecosystem'],
    ['when', 'timeline-note', 'timeline'],
    ['costs', 'table-note', 'table'],
  ];
  const gap = W.theme.spacing.figure_to_note;
  for (const [slideId, noteId, figureRole] of cases) {
    const s = slide(slideId);
    const note = s.elements.find((el) => el.id === noteId);
    const figure = s.elements.find((el) => el.role === figureRole);
    assert.ok(note, `${slideId} must render ${noteId}`);
    assert.ok(figure, `${slideId} must render its ${figureRole}`);
    const distance = note.rect.y - (figure.rect.y + figure.rect.h);
    assert.ok(distance >= 0 && distance <= gap + 12,
      `${slideId}: the note sits ${distance.toFixed(0)} px below its figure (expected about ${gap}). `
      + 'A note that far from its figure reads as stray text.');
  }
});

test('THE FOOTER BANNER AND THE FIGURE NOTE STAY DIFFERENT THINGS', () => {
  // They are two fields with two meanings - a page's conclusion and a
  // qualifier on one figure - and the fix for the confusion was to attach the
  // note, not to give it the banner's clothes. The table page carries both, so
  // it is where that has to hold.
  const s = slide('costs');
  const note = s.elements.find((el) => el.id === 'table-note');
  const banner = s.elements.find((el) => el.id === 'footer-banner');
  assert.ok(note && banner);
  assert.ok(note.rect.y + note.rect.h < banner.rect.y,
    'the note belongs to the table above it and must sit clear of the banner');
  assert.ok(note.style.font_size_px < s.elements.find((el) => el.id === 'footer-text').style.font_size_px,
    'the note is the quieter register of the two');
});

// ---------------------------------------------------------------------------
// 5. Decorative lines that mean nothing.
// ---------------------------------------------------------------------------

test('NO RULE, BAR OR DIVIDER SURVIVES THAT CARRIES NO MEANING', () => {
  // PO: ボックスの上とか横になぞに線引きたがるのAIすぎるんですよね.
  //
  // The ones removed, each by the id or the border it drew:
  //   step top rule        a stroke along the top of a step box
  //   layer left bar       6 px of teal down the side of a panel
  //   folio rule           a 56 px dash beside the page number, on all 11
  //   divider rule         a 300 px rule under a chapter subtitle, separating
  //                        it from nothing
  //   footer divider       a hairline between the lamp and the label
  const gone = ['page-number-rule', 'divider-rule', 'footer-divider'];
  for (const s of W.geometry.slides) {
    for (const el of s.elements) {
      assert.ok(!gone.includes(el.id),
        `${s.slide_id} still draws "${el.id}", which separates nothing`);
    }
  }

  const css = fs.readFileSync(path.join(DECK_HOME, 'themes', 'watercolor', 'deck.css'), 'utf8');
  // The two the PO named by name, asserted on the declarations themselves:
  // their absence from the render would also be satisfied by the page type
  // not rendering at all.
  const block = (selector) => {
    const i = css.indexOf(`\n${selector} {`);
    assert.ok(i >= 0, `${selector} must still exist`);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.ok(!/border-top:/.test(block('.step')), '.step must not draw a rule along its top edge');
  assert.ok(!/border-left:/.test(block('.eco-layer')), '.eco-layer must not draw a bar down its side');
});

test('THE LINES THAT MEAN SOMETHING ARE STILL THERE', () => {
  // The half that matters: "remove every line" is as wrong as "draw lines
  // everywhere". Each of these marks a real boundary or is the design's
  // established motif, and each is checked against the reference deck.
  const kept = [
    ['cover', 'section-rule', 'the eyebrow bar - the motif that marks a labelled statement'],
    ['agenda', 'agenda-rule-1', 'the hairline between two agenda rows - a real separator'],
    ['three-points', 'card-rule-1', 'the accent rule between a card heading and its body'],
    ['three-points', 'footer-bar', 'the footer banner bar - the same motif as the eyebrow'],
    ['when', 'timeline-axis', 'the axis itself, which carries the order'],
    ['who', 'ecosystem-connectors', 'the connectors, which carry the relationships'],
    ['how', 'step-arrow-1', 'the arrows, which carry the order'],
  ];
  for (const [slideId, id, why] of kept) {
    assert.ok(slide(slideId).elements.some((el) => el.id === id && el.visible),
      `${slideId} must keep ${id}: ${why}`);
  }
});

test('THE TOP-RIGHT WASH REACHES THE PAGE EDGE AND DISSOLVES INWARD', () => {
  // PO: p7's wash ends in a hard straight rectangular edge rather than
  // dissolving - it reads as a misplaced image box.
  //
  // The cause was an ID COLLISION, not a gradient: every slide's wash declared
  // the same mask id in one shared document, so all eight used the FIRST
  // slide's mask. That mask is 701 px wide; the process page's wash is 865,
  // and it was cut dead at x=1508 with a vertical edge.
  const ids = new Set();
  for (const s of W.geometry.slides) {
    const wash = s.elements.find((el) => el.id === 'decor-topright');
    if (!wash) continue;
    // Flush with the top-right corner: those are canvas edges, and a wash that
    // runs off the paper there is correct.
    assert.equal(Math.round(wash.rect.y), 0, `${s.slide_id}: the wash must sit against the top edge`);
    assert.equal(Math.round(wash.rect.x + wash.rect.w), Math.round(s.regions.canvas.w),
      `${s.slide_id}: the wash must reach the right edge`);
  }
  // Every decoration instance must own its ids. This is the general form of
  // the bug, and the one a new decoration would otherwise reintroduce.
  const html = fs.readFileSync(path.join(W.dir, 'out', 'html', '_deck.html'), 'utf8');
  for (const m of html.matchAll(/<mask id="([^"]+)"/g)) {
    assert.ok(!ids.has(m[1]),
      `mask id "${m[1]}" is declared twice in one document; the second use silently resolves to the first`);
    ids.add(m[1]);
  }
  assert.ok(ids.size >= 8, `expected one mask per decorated slide, found ${ids.size}`);
});
