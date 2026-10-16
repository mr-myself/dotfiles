import { cssNumber } from '../theme/css-safe.js';
import {
  cardIconGlyph, columnWash, footerMark, heroRight, leavesBottomLeft, mountainsTopRight,
} from './decor.js';
import {
  comparisonChevron, hubConnectors, ringPositions, stepArrow, timelineAxis,
} from './diagrams.js';
import { DeckError, EXIT } from '../util/fail.js';
import { slotKey } from '../deck.js';

/**
 * Component templates.
 *
 * Every centred role declares its placement contract HERE, in the template,
 * rather than leaving it to the storyboard. That is the point made in the
 * task: if the contract were optional per-slide metadata, omitting it would
 * quietly exempt the element from the centring check, and the one rule the
 * whole architecture exists to support would be evadable by forgetting an
 * attribute. A component that centres something always says so.
 *
 * The seam is strict. Everything below renders as DOM: section label, title,
 * subtitle, body, cards, tables, rules, arrows, icon circles, footer banner,
 * page number. Illustrations arrive as images in declared SLOTS and must
 * contain no text.
 */

/**
 * Column alignment, from a CLOSED SET.
 *
 * The schema already constrains `align` to three values, but this lands in a
 * style attribute, so it is re-checked here against a literal set rather than
 * interpolated on trust.
 * @param {any} col @param {number} i
 */
function alignOf(col, i) {
  const a = col?.align ?? 'start';
  if (a !== 'start' && a !== 'center' && a !== 'end') {
    throw new DeckError(`table column ${i + 1} has align "${a}"`, EXIT.VERDICT_FAILED, ['Allowed: start, center, end.']);
  }
  return a;
}


/**
 * ELEMENT IDS, IN ONE PLACE.
 *
 * The templates below build these ids and the content-integrity rule looks
 * elements up BY them, so the two have to agree exactly. They did not: the
 * rule carried a hand-written list that omitted paragraph text, body bullet
 * items and card bullet items, all of which standard3col renders. Hiding any
 * of them left them outside every rule's coverage, because every other rule
 * skips an invisible element.
 *
 * Both sides now call these, so an id can only change in one place.
 */
export const ELEMENT_IDS = {
  title: () => 'title',
  subtitle: () => 'subtitle',
  sectionLabel: () => 'section-label',
  footerText: () => 'footer-text',
  footerLabel: () => 'footer-label',
  statementBody: () => 'statement-body',
  agendaText: (n) => `agenda-text-${n}`,
  lead: (i) => `lead-${i + 1}`,
  leadItem: (i, j) => `lead-${i + 1}-item-${j + 1}`,
  cardHeading: (n) => `card-heading-${n}`,
  cardBody: (n) => `card-body-${n}`,
  cardItem: (n, j) => `card-${n}-item-${j + 1}`,
  tableHeading: (i) => `th-${i + 1}`,
  tableCell: (r, c) => `td-${r + 1}-${c + 1}`,
  tableNote: () => 'table-note',
};

/**
 * The body blocks standard3col draws above its cards, in render order.
 *
 * `lead-N` is indexed over THIS filtered list, not over `body`, so anything
 * that needs to predict a lead id has to filter identically. Exported so it
 * is filtered in one place rather than two.
 *
 * @param {any} slide
 */
export function leadBlocksOf(slide) {
  return (slide.body || []).filter((b) => b.kind === 'paragraph' || b.kind === 'bullets');
}

/** @param {string} s */
export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Apply the storyboard's layout line breaks to a verbatim string.
 *
 * The breaks live in `line_breaks_after` as character offsets, never inside
 * the text, so the words stay ONE verbatim string that a digest can sign and
 * a test can compare byte-for-byte. The rendered DOM's textContent still
 * returns the original characters: <br> contributes nothing to it.
 *
 * @param {string} text
 * @param {number[]} [breaks] character offsets after which to break
 * @returns {string} HTML
 */
export function withBreaks(text, breaks) {
  if (!breaks || breaks.length === 0) return esc(text);
  const chars = Array.from(text);
  const sorted = [...new Set(breaks)].sort((a, b) => a - b);
  for (const at of sorted) {
    if (at < 1 || at >= chars.length) {
      throw new DeckError(
        `a layout line break at offset ${at} is outside the text (length ${chars.length}): "${text.slice(0, 40)}..."`,
        EXIT.VERDICT_FAILED,
        ['Line breaks are character offsets into the field, counted in code points.'],
      );
    }
  }
  let out = '';
  chars.forEach((c, i) => {
    out += esc(c);
    if (sorted.includes(i + 1)) out += '<br>';
  });
  return out;
}

/** The contract string for a two-axis centred element. */
function centred(reference, tolerance, extra = {}) {
  return esc(JSON.stringify({
    reference,
    align_x: 'center',
    align_y: 'center',
    measure: 'content-union',
    tolerance_px: tolerance,
    ...extra,
  }));
}

/**
 * @typedef {object} RenderCtx
 * @property {any} theme
 * @property {any} slide
 * @property {number} index     0-based
 * @property {number} total
 * @property {Record<string, {src: string, sha256: string, width: number | null, height: number | null}>} assets
 */

/** @param {RenderCtx} ctx */
function sectionLabel({ slide }) {
  if (slide.section_label === null || slide.section_label === undefined) return '';
  return `
      <div class="eyebrow" data-deck-id="section-label" data-deck-role="section-label" data-deck-group="headline" data-deck-anchor="left:headline">${esc(slide.section_label)}</div>
      <div class="eyebrow-rule" data-deck-id="section-rule" data-deck-role="section-rule" data-deck-group="headline" data-deck-anchor="left:headline" data-deck-decorative></div>`;
}

/** @param {RenderCtx} ctx */
function headline({ slide, theme }) {
  const breaks = slide.line_breaks_after || {};
  const headlineGap = theme.spacing.headline_internal_max;
  const title = slide.title === null || slide.title === undefined ? '' : `
      <h1 class="title" data-deck-id="title" data-deck-role="title" data-deck-group="headline" data-deck-anchor="left:headline">${withBreaks(slide.title, breaks.title)}</h1>`;
  // `subtitle: null` is an INTENTIONALLY ABSENT subtitle. Nothing is emitted,
  // not even an empty element: an empty box would still occupy space and
  // would shift the title baseline relative to a slide that never had one,
  // which the repetition rule would then report.
  const subtitle = slide.subtitle === null || slide.subtitle === undefined ? '' : `
      <p class="subtitle" data-deck-id="subtitle" data-deck-role="subtitle" data-deck-group="headline" data-deck-anchor="left:headline">${withBreaks(slide.subtitle, breaks.subtitle)}</p>`;
  return `
    <header class="headline" data-deck-id="headline" data-deck-role="headline" data-deck-group="headline"
            data-deck-proximity='{"max_internal_gap_px": ${headlineGap}}'>${sectionLabel({ slide })}${title}${subtitle}
    </header>`;
}

/** @param {RenderCtx} ctx */
function footerBanner({ slide, theme }) {
  if (!slide.footer) return '';
  // The reference sets a tall teal rule, a lamp mark, a hairline divider and
  // then the line of text, over a pale wash that bleeds off the right edge.
  // The rule and the mark are decorative; the words are the content.
  return `
    <aside class="footer-banner" data-deck-id="footer-banner" data-deck-role="footer-banner" data-deck-zone="footer" data-deck-group="footer">
      <span class="footer-bar" data-deck-id="footer-bar" data-deck-role="footer-bar" data-deck-group="footer" data-deck-decorative></span>
      ${footerMark(theme.colors.footer_text_teal.hex)}
      <span class="footer-divider" data-deck-decorative data-deck-ignore></span>
      ${slide.footer.label ? `<span class="footer-label" data-deck-id="footer-label" data-deck-role="footer-label" data-deck-group="footer"
            data-deck-placement='${esc(JSON.stringify({ contrast_backing: theme.colors.footer_banner_bg.hex }))}'>${esc(slide.footer.label)}</span>` : ''}
      <span class="footer-text" data-deck-id="footer-text" data-deck-role="footer-text" data-deck-group="footer"
            data-deck-placement='${esc(JSON.stringify({ contrast_backing: theme.colors.footer_banner_bg.hex }))}'>${esc(slide.footer.text)}</span>
    </aside>`;
}

/** @param {RenderCtx} ctx */
function pageNumber(ctx) {
  const { theme, slide, index, total, pageNumbers } = ctx;
  // `output.page_numbers: false` in deck.yaml. It was accepted by the schema
  // and then never consulted, so folios rendered anyway - an option that
  // silently does nothing is worse than no option.
  if (pageNumbers === false) return '';
  if (theme.pagination.omit_for.includes(slide.page_type)) return '';
  const n = index + 1;
  const text = theme.pagination.format
    .replace('{nn}', String(n).padStart(String(total).length, '0'))
    .replace('{n}', String(n))
    .replace('{total}', String(total));
  // The folio is the reason this tool exists. In the reference deck it was
  // baked into every raster, the deck grew from 22 slides to 23, and all 23
  // page numbers became wrong at once; the author's fix was to paint a white
  // rectangle over the raster and overlay real text. Here it is DOM, derived
  // from the slide's index, so adding a slide re-numbers the deck and nothing
  // is re-rendered.
  const rule = theme.pagination.rule
    ? `
    <div class="folio-rule" data-deck-id="page-number-rule" data-deck-role="page-number-rule" data-deck-zone="pagination" data-deck-decorative></div>`
    : '';
  return `${rule}
    <div class="folio" data-deck-id="page-number" data-deck-role="page-number" data-deck-zone="pagination">${esc(text)}</div>`;
}

/**
 * THE ABSOLUTELY POSITIONED SLOTS, which is not all of them.
 *
 * A slot whose theme geometry declares `flow` is laid out by the TEMPLATE -
 * inside the card frame, say - and must not also be drawn here. The skip used
 * to be a list the calling template passed in, derived from its card count,
 * which meant a storyboard declaring three column slots against two cards got
 * the third one drawn absolutely at the theme coordinates, floating over
 * nothing with no card beneath it. Reading the declaration instead means
 * there is ONE place that decides whether a slot is absolute, and it is the
 * same place the geometry comes from.
 *
 * @param {RenderCtx} ctx
 */
function slots(ctx) {
  const { slide, assets, theme } = ctx;
  return (slide.slots || []).filter((slot) => !isFlowSlot(theme, slide, slot.id)).map((slot) => {
    const asset = assets[slotKey(slide.id, slot.id)];
    const geometry = (theme.page_types[slide.page_type]?.slots || {})[slot.id]
      || { left: null, top: null };
    // EVERY LENGTH IS PARSED AS A NUMBER. These values come from theme.yaml,
    // which deck.yaml can override, and they land inside a style attribute: a
    // geometry.left of `0px"><img src=x onerror=...><div z="` escaped the
    // attribute and injected a tag. cssNumber refuses anything that is not
    // exactly a number, so no string reaches the attribute at all.
    const where = `page_types.${slide.page_type}.slots.${slot.id}`;
    const len = (v, side) => (v === null || v === undefined
      ? ''
      : `${side}:${cssNumber(v, `${where}.${side}`)}px`);
    const style = [
      `width:${cssNumber(slot.width_px, `slot ${slot.id} width_px`)}px`,
      `height:${cssNumber(slot.height_px, `slot ${slot.id} height_px`)}px`,
      len(geometry.left, 'left'),
      len(geometry.top, 'top'),
      len(geometry.right, 'right'),
      len(geometry.bottom, 'bottom'),
    ].filter(Boolean).join(';');
    // AN EMPTY BLEED SLOT RENDERS NOTHING.
    //
    // A bleed slot is the full-height hero panel on a cover, divider or
    // agenda page, and the theme's own watercolour already occupies exactly
    // that area. Drawing a reserved frame on top of it put a bordered box
    // over the artwork - two decorations fighting for the same corner. An
    // in-page slot still shows its frame, because there the reserved space is
    // genuinely information the author needs.
    const zoneForPlaceholder = slot.decorative ? 'decorative' : (geometry.zone || 'body');
    if (!asset && zoneForPlaceholder === 'bleed') return '';
    const inner = asset
      // object-fit: contain is aspect-preserving CONTAINMENT. The PO's file is
      // never cropped, scaled non-uniformly or rewritten; only the box around
      // it changes, which is what lets a slot move without re-requesting the
      // illustration.
      ? `<img src="${esc(asset.src)}" alt="" data-deck-id="slot-img-${esc(slot.id)}" data-deck-sha256="${esc(asset.sha256)}" style="width:100%;height:100%;object-fit:contain;object-position:center">`
      : `<div class="slot-empty" data-deck-ignore></div>`;
    // The zone is the THEME's call, not the storyboard's: whether a slot
    // bleeds off the canvas is a property of the layout, and the storyboard
    // should not have to know. A slot the storyboard marks `decorative`
    // declares overlap as intended, which is a separate statement.
    const zone = slot.decorative ? 'decorative' : (geometry.zone || 'body');
    // WHETHER THE PICTURE ARRIVED IS RECORDED IN THE DOM.
    //
    // Fourteen of fifteen slots on a real deck were empty, lint passed, and
    // `render --release` produced a finished PDF with no pictures in it. The
    // slot-fill rule needs to know which slots are empty, and the honest
    // place for that is the rendered page: the renderer is the only thing
    // that knows whether it put an image there. `reuse` is a slot the PO
    // supplies themselves - a logo, a photo, a QR code - which deck never
    // generates and must not demand before a preview.
    const state = asset ? 'filled' : (slot.reuse_unchanged === true ? 'reuse' : 'empty');
    return `
    <div class="slot${asset ? '' : ' slot--empty'}" style="${style}"
         data-deck-slot="${esc(slot.id)}" data-deck-id="slot-${esc(slot.id)}" data-deck-role="slot"
         data-deck-slot-state="${state}"
         data-deck-zone="${esc(zone)}"${slot.decorative ? ' data-deck-decorative' : ''}>${inner}
    </div>`;
  }).join('');
}

/**
 * THE DECORATION LAYER.
 *
 * Emitted FIRST in every page type, so it sits under the content in paint
 * order without anything needing a z-index fight. All of it is decorative and
 * carries no words; see decor.js for why it is drawn rather than shipped.
 *
 * @param {RenderCtx} ctx
 * @param {'content' | 'hero'} kind
 */
function decoration({ theme, slide }, kind) {
  if (theme.decoration === false) return '';
  const hero = kind === 'hero';
  const seed = slide?.id || 'default';
  return `
    <div class="decor-layer" data-deck-ignore>
      ${hero ? heroRight(theme, { seed }) : mountainsTopRight(theme, { seed })}
      ${leavesBottomLeft(theme, { seed })}
    </div>`;
}

// --- page types ---------------------------------------------------------

/** @param {RenderCtx} ctx */
function cover(ctx) {
  const { slide } = ctx;
  const breaks = slide.line_breaks_after || {};
  return `
    ${decoration(ctx, 'hero')}
    ${slots(ctx)}
    <div class="region region--cover-text" data-deck-region="cover-text-region" data-deck-ignore></div>
    <div class="cover-text">
      ${slide.section_label ? `<div class="eyebrow eyebrow--cover" data-deck-id="section-label" data-deck-role="section-label" data-deck-group="headline" data-deck-anchor="left:headline">${esc(slide.section_label)}<span class="eyebrow-rule" data-deck-id="section-rule" data-deck-role="section-rule" data-deck-group="headline" data-deck-decorative></span></div>` : ''}
      <h1 class="cover-title" data-deck-id="title" data-deck-role="cover-title" data-deck-group="headline" data-deck-anchor="left:headline">${withBreaks(slide.title ?? '', breaks.title)}</h1>
      ${slide.subtitle === null || slide.subtitle === undefined ? '' : `<p class="cover-subtitle" data-deck-id="subtitle" data-deck-role="subtitle" data-deck-group="headline" data-deck-anchor="left:headline">${withBreaks(slide.subtitle, breaks.subtitle)}</p>`}
    </div>
    ${pageNumber(ctx)}`;
}

/** @param {RenderCtx} ctx */
function sectionDivider(ctx) {
  const { slide, theme } = ctx;
  const breaks = slide.line_breaks_after || {};
  // Two-axis centred against the SAFE CONTENT region, not the canvas. The
  // theme's top and bottom margins differ, so those two references have
  // different vertical centres; naming it is what makes the check meaningful.
  // THE CHAPTER NUMERAL, as the reference sets it: very large, very pale, in
  // the left margin beside the title. The digits come from the section label
  // the author already wrote - 「第01章」 - because a chapter page that has to
  // be told its own number twice is a worse contract than reading the one it
  // has. No digits in the label simply means no numeral.
  const numeral = (slide.section_label || '').match(/\d+/);
  return `
    ${decoration(ctx, 'hero')}
    ${slots(ctx)}
    ${slide.section_label ? `<div class="content content--eyebrow-only"><div class="eyebrow" data-deck-id="section-label" data-deck-role="section-label" data-deck-group="headline">${esc(slide.section_label)}<span class="eyebrow-rule" data-deck-id="section-rule" data-deck-role="section-rule" data-deck-group="headline" data-deck-decorative></span></div></div>` : ''}
    <div class="divider-stack" data-deck-id="divider-stack" data-deck-role="divider-stack"
         data-deck-group="divider"
         data-deck-proximity='{"max_internal_gap_px": ${theme.spacing.divider_internal_max}}'>
      <div class="divider-body">
        ${numeral ? `<div class="divider-numeral" data-deck-id="divider-numeral" data-deck-role="divider-numeral" data-deck-decorative data-deck-ignore>${esc(numeral[0])}</div>` : ''}
        <div class="divider-text">
          <h1 class="divider-title" data-deck-id="title" data-deck-role="divider-title" data-deck-group="divider">${withBreaks(slide.title ?? '', breaks.title)}</h1>
          ${slide.subtitle === null || slide.subtitle === undefined ? '' : `<p class="divider-subtitle" data-deck-id="subtitle" data-deck-role="subtitle" data-deck-group="divider">${withBreaks(slide.subtitle, breaks.subtitle)}</p>`}
        </div>
      </div>
    </div>
    ${pageNumber(ctx)}`;
}

/** @param {RenderCtx} ctx */
function statement(ctx) {
  const { slide, theme } = ctx;
  const breaks = slide.line_breaks_after || {};
  const text = (slide.body || []).find((b) => b.kind === 'statement');
  return `
    ${decoration(ctx, 'content')}
    ${slots(ctx)}
    <div class="statement-stack${slide.footer ? ' statement-stack--with-footer' : ''}" data-deck-id="statement-stack" data-deck-role="statement-stack"
         data-deck-group="statement"
         data-deck-proximity='{"max_internal_gap_px": ${theme.spacing.statement_internal_max}}'>
      ${slide.section_label ? `<div class="eyebrow" data-deck-id="section-label" data-deck-role="section-label" data-deck-group="statement">${esc(slide.section_label)}<span class="eyebrow-rule" data-deck-id="section-rule" data-deck-role="section-rule" data-deck-group="statement" data-deck-decorative></span></div>` : ''}
      <h1 class="statement-title" data-deck-id="title" data-deck-role="statement-title" data-deck-group="statement">${withBreaks(slide.title ?? '', breaks.title)}</h1>
      ${text ? `<p class="statement-body" data-deck-id="statement-body" data-deck-role="body" data-deck-group="statement">${withBreaks(text.text, breaks.statement)}</p>` : ''}
      ${slide.subtitle === null || slide.subtitle === undefined ? '' : `<p class="statement-subtitle" data-deck-id="subtitle" data-deck-role="subtitle" data-deck-group="statement">${withBreaks(slide.subtitle, breaks.subtitle)}</p>`}
    </div>
    ${footerBanner(ctx)}
    ${pageNumber(ctx)}`;
}

/** @param {RenderCtx} ctx */
function agenda(ctx) {
  const { slide, theme } = ctx;
  const items = slide.agenda?.items || [];
  const active = slide.agenda?.active ?? null;
  const tol = theme.lint.centring_tolerance_px;
  const rows = items.map((item, i) => {
    const n = i + 1;
    const isActive = active === n;
    const state = isActive ? 'active' : 'inactive';
    // The badge is a NAMED REGION and the numeral declares its centring
    // against it. A numeral centred in its own badge is a contract the
    // template owns, so it is stated here rather than left to the storyboard,
    // where forgetting it would exempt it from the check.
    return `
      <li class="agenda-row agenda-row--${state}" data-deck-id="agenda-row-${n}" data-deck-role="agenda-row" data-deck-group="agenda-${n}"
          data-deck-proximity='{"max_internal_gap_px": ${theme.spacing.agenda_internal_max}}'>
        <span class="agenda-badge agenda-badge--${state}" data-deck-region="agenda-badge-${n}" data-deck-id="agenda-badge-${n}" data-deck-role="agenda-badge" data-deck-group="agenda-${n}"
          ><span class="agenda-num agenda-num--${state}" data-deck-id="agenda-num-${n}" data-deck-role="agenda-num" data-deck-group="agenda-${n}"
              data-deck-placement='${centred(`agenda-badge-${n}`, tol)}'>${String(n).padStart(2, '0')}</span></span>
        <span class="agenda-rule" data-deck-id="agenda-rule-${n}" data-deck-role="agenda-rule" data-deck-group="agenda-${n}" data-deck-decorative></span>
        <span class="agenda-text agenda-text--${state}" data-deck-id="${ELEMENT_IDS.agendaText(n)}" data-deck-role="agenda-text" data-deck-group="agenda-${n}" data-deck-anchor="left:agenda">${esc(item)}</span>
      </li>`;
  }).join('');
  // Flow content goes inside .content, which IS the theme's safe content
  // rectangle. Emitting it as a direct child of the canvas would start it at
  // 0,0 and put every element outside the margins - which is exactly what the
  // safe-margins rule reported the first time this was built that way.
  return `
    ${decoration(ctx, 'hero')}
    ${slots(ctx)}
    <div class="content${slide.footer ? ' content--with-footer' : ''}">
      ${headline(ctx)}
      <ol class="agenda" data-deck-id="agenda" data-deck-role="agenda">${rows}
      </ol>
    </div>
    ${footerBanner(ctx)}
    ${pageNumber(ctx)}`;
}

/**
 * The fill state of a card's in-flow art slot, in the same vocabulary the
 * absolutely positioned slots use.
 *
 * @param {any} slide
 * @param {string} slotId
 * @param {boolean} filled
 */
function cardArtState(slide, slotId, filled) {
  if (filled) return 'filled';
  const declared = (slide.slots || []).find((sl) => sl.id === slotId);
  return declared && declared.reuse_unchanged === true ? 'reuse' : 'empty';
}

/**
 * THE RESERVED ILLUSTRATION BAND on a diagram page.
 *
 * WHAT THIS IS FOR, in the PO's words: 絵も入れる前提にしたほうがよい（生成は
 * しなくていいので、挿入することをchatgptに伝えることが大事）. deck generates
 * nothing. It does two things, and both have to happen or neither is worth
 * anything:
 *
 *   1. RESERVE THE SPACE, so the page is composed whether or not a picture
 *      has arrived. The band is `flex: 1 1 auto`, so it absorbs exactly the
 *      room the figure above it did not use - which means the hole IS the
 *      band, by construction, and a page type cannot leave a third of the
 *      canvas empty any more.
 *   2. REACH THE BRIEF. Because it is a declared slot, `deck gate prompts
 *      --single` emits an entry for it naming the slide, the size and what to
 *      depict, and `slot-fill` blocks a release while it is empty. A reserved
 *      frame that never reaches the brief is useless - that combination is
 *      what left fourteen slots empty on the PO's real deck.
 *
 * Empty, it draws the same soft wash a column frame does. That buys time on a
 * deck with no pictures in it yet and NOT on one where some pages are
 * illustrated and some are not - see the note on standard-3col in theme.yaml,
 * where the PO disproved the stronger version of this claim. The
 * box carries its slot state either way, which is what lets the occupancy
 * measurement count a real picture as content and an empty frame as the hole
 * it still is.
 *
 * @param {RenderCtx} ctx
 */
function diagramArt(ctx) {
  const { slide, theme, assets } = ctx;
  const id = flowSlotOf(theme, slide, 'diagram-art');
  if (!id) return '';
  const declared = (slide.slots || []).find((sl) => sl.id === id);
  if (!declared) {
    // NOT DECLARED: still reserve the space, exactly as a three-column page
    // reserves its frames. The page stays composed and the author sees the
    // shape of what is missing.
    return `
      <div class="diagram-art diagram-art--empty" data-deck-id="diagram-art" data-deck-role="diagram-art"
           data-deck-decorative>${columnWash(theme, 1, `${slide.id}:art`)}</div>`;
  }
  const asset = assets[slotKey(slide.id, id)];
  const state = asset ? 'filled' : (declared.reuse_unchanged === true ? 'reuse' : 'empty');
  const inner = asset
    ? `<img src="${esc(asset.src)}" alt="" data-deck-id="diagram-art-img" data-deck-sha256="${esc(asset.sha256)}">`
    : columnWash(theme, 1, `${slide.id}:art`);
  return `
      <div class="diagram-art${asset ? '' : ' diagram-art--empty'}" data-deck-id="diagram-art"
           data-deck-role="diagram-art" data-deck-slot="${esc(id)}" data-deck-slot-state="${state}"${asset ? '' : ' data-deck-decorative'}>${inner}</div>`;
}

/**
 * The note that belongs to the figure directly above it.
 *
 * WHY IT MOVED. The design kit orders a page タイトル / 副題 / 図解 / 必要な
 * 注記 / ページ番号, and this was rendering in that order but with the figure
 * pinned to the top by `margin-bottom: auto` - so the note fell all the way to
 * the foot of the page, landing where the footer banner sits on every other
 * page and separated from its figure by the whole empty band. The PO's
 * question was exactly right: P7-P11までの左下のなぞのテキストはなに？
 *
 * It is NOT the footer banner and must not borrow its treatment. A `footer` is
 * the page's conclusion and carries a label the author wrote; a `note` is a
 * qualifier on one figure. The kit gives the note its own type size band -
 * 20-24 px against the body's 30-38 - and the thing that was missing was not
 * ornament but ATTACHMENT. It now sits directly under its figure at the
 * figure's left edge, close enough to read as part of it.
 *
 * @param {string} id
 * @param {string} [text]
 */
function figureNote(id, text) {
  if (!text) return '';
  return `
      <p class="figure-note" data-deck-id="${id}" data-deck-role="note" data-deck-anchor="left:headline">${esc(text)}</p>`;
}

/**
 * The slot a page type lays out itself, by the KIND of flow it declares.
 *
 * @param {any} theme
 * @param {string} pageType
 * @param {string} kind
 * @returns {string | null}
 */
function flowSlotOf(theme, slide, kind) {
  const declared = theme.page_types?.[slide.page_type]?.slots || {};
  // THE SLIDE'S OWN SLOTS FIRST, for the same reason flowSlotForCard does it:
  // scanning the theme and taking the first match is only correct while one
  // slide in the whole deck can declare that id, and that is no longer true.
  for (const slot of slide.slots || []) {
    const g = declared[slot.id];
    if (g && g.flow === kind) return slot.id;
  }
  for (const [id, g] of Object.entries(declared)) {
    if (g && g.flow === kind) return id;
  }
  return null;
}

/**
 * Is this slot positioned by the template rather than by coordinates?
 *
 * @param {any} theme
 * @param {any} slide
 * @param {string} slotId
 */
function isFlowSlot(theme, slide, slotId) {
  const g = (theme.page_types[slide.page_type]?.slots || {})[slotId];
  return Boolean(g && g.flow);
}

/**
 * Which card a flow slot belongs to, as the theme declares it.
 *
 * @param {any} theme
 * @param {string} pageType
 * @param {number} n  1-based card index
 * @returns {string | null} the slot id, or null when the theme declares none
 */
function flowSlotForCard(theme, slide, n) {
  const declared = theme.page_types[slide.page_type]?.slots || {};
  // THE SLIDE'S OWN SLOTS FIRST. Scanning the theme and returning the first
  // match made every standard-3col slide in a deck resolve to the same id -
  // which was harmless while only one slide could declare it, and became a
  // silent blank page the moment a second one could. Asking which of THIS
  // slide's slots sits in column n cannot do that.
  for (const slot of slide.slots || []) {
    const g = declared[slot.id];
    if (g && g.flow === 'card-art' && Number(g.card) === n) return slot.id;
  }
  // Nothing declared: fall back to the theme's own name for the position, so
  // the reserved frame still renders and `prompts` still has an id to ask for.
  for (const [id, g] of Object.entries(declared)) {
    if (g && g.flow === 'card-art' && Number(g.card) === n) return id;
  }
  return null;
}

/** @param {RenderCtx} ctx */
function standard3col(ctx) {
  const { slide, theme, assets } = ctx;
  const block = (slide.body || []).find((b) => b.kind === 'cards');
  const paragraphs = leadBlocksOf(slide);
  const lead = paragraphs.map((b, i) => (b.kind === 'paragraph'
    ? `<p class="lead" data-deck-id="${ELEMENT_IDS.lead(i)}" data-deck-role="body" data-deck-anchor="left:headline">${esc(b.text)}</p>`
    : `<ul class="lead-bullets" data-deck-id="${ELEMENT_IDS.lead(i)}" data-deck-role="body" data-deck-anchor="left:headline">${(b.items || []).map((it, j) => `<li data-deck-id="${ELEMENT_IDS.leadItem(i, j)}" data-deck-role="bullet">${esc(it)}</li>`).join('')}</ul>`)).join('');
  // THE COLUMN ART FRAME.
  //
  // Reserved for every column, whether or not an illustration exists for it.
  // The reference's three-column pages are roughly two thirds picture by
  // area; a column that is text alone leaves the bottom half of the page
  // empty, which is exactly what the first real deck looked like. When the
  // storyboard declares a slot for the column AND an asset has been imported,
  // the image fills the frame; otherwise the frame is a soft wash. That reads
  // as deliberate only while the whole deck is unillustrated - mixed with real
  // pictures it reads as a failed load, which the PO measured on a real deck.
  // slot-fill is what actually holds the line; see theme.yaml.
  const slotIds = new Set((slide.slots || []).map((sl) => sl.id));
  // WHICH SLOT FEEDS WHICH CARD IS THE THEME'S STATEMENT, not a name this
  // template builds by string concatenation. A theme that renames or drops a
  // column slot moves the picture with it instead of silently losing it.
  const artSlotFor = (n) => flowSlotForCard(theme, slide, n);
  const artFor = (n) => {
    const id = artSlotFor(n);
    const asset = id && slotIds.has(id) ? assets[slotKey(slide.id, id)] : null;
    if (asset) {
      return `<img src="${esc(asset.src)}" alt="" data-deck-id="card-art-img-${n}" data-deck-sha256="${esc(asset.sha256)}">`;
    }
    return columnWash(theme, n, slide.id);
  };
  const cards = (block?.cards || []).map((card, i) => {
    const n = i + 1;
    const artSlot = artSlotFor(n);
    const filled = Boolean(artSlot && slotIds.has(artSlot) && assets[slotKey(slide.id, artSlot)]);
    return `
      <article class="card" data-deck-id="card-${n}" data-deck-role="card" data-deck-group="card-${n}"
               data-deck-proximity='{"max_internal_gap_px": ${theme.spacing.card_internal_max}, "min_external_gap_px": ${theme.spacing.card_external_min}}'>
        <div class="card-bg" data-deck-id="card-bg-${n}" data-deck-role="card-bg" data-deck-background-of="card-${n}" data-deck-ignore></div>
        <div class="card-art${filled ? '' : ' card-art--empty'}" data-deck-id="card-art-${n}" data-deck-role="card-art"
             data-deck-group="card-${n}" data-deck-decorative${artSlot && slotIds.has(artSlot) ? ` data-deck-slot="${esc(artSlot)}" data-deck-slot-state="${cardArtState(slide, artSlot, filled)}"` : ''}>${artFor(n)}</div>
        <div class="card-lead" data-deck-id="card-lead-${n}" data-deck-role="card-lead" data-deck-group="card-${n}">
          ${card.icon ? `<span class="icon-circle icon-circle--${esc(card.icon)}" data-deck-id="icon-${n}" data-deck-role="icon-circle" data-deck-group="card-${n}" data-deck-decorative>${cardIconGlyph(n)}</span>` : ''}
          <h2 class="card-heading" data-deck-id="${ELEMENT_IDS.cardHeading(n)}" data-deck-role="card-heading" data-deck-group="card-${n}">${esc(card.heading)}</h2>
        </div>
        <div class="card-rule" data-deck-id="card-rule-${n}" data-deck-role="card-rule" data-deck-group="card-${n}" data-deck-decorative></div>
        ${card.body ? `<p class="card-body" data-deck-id="${ELEMENT_IDS.cardBody(n)}" data-deck-role="card-body" data-deck-group="card-${n}">${esc(card.body)}</p>` : ''}
        ${(card.items || []).length ? `<ul class="card-list" data-deck-id="card-list-${n}" data-deck-role="card-body" data-deck-group="card-${n}">${card.items.map((it, j) => `<li data-deck-id="${ELEMENT_IDS.cardItem(n, j)}" data-deck-role="bullet">${esc(it)}</li>`).join('')}</ul>` : ''}
      </article>`;
  }).join('');
  return `
    ${decoration(ctx, 'content')}
    ${slots(ctx)}
    <div class="content${slide.footer ? ' content--with-footer' : ''}">
      ${headline(ctx)}
      ${lead}
      <div class="cards" style="--deck-cards-count:${(block?.cards || []).length || 3}" data-deck-id="cards" data-deck-role="card-row">${cards}
      </div>
    </div>
    ${footerBanner(ctx)}
    ${pageNumber(ctx)}`;
}

/** @param {RenderCtx} ctx */
function table(ctx) {
  const { slide } = ctx;
  const t = slide.table;
  if (!t) {
    throw new DeckError(`slide ${slide.id} is page_type "table" but has no table`, EXIT.VERDICT_FAILED);
  }
  const cols = t.columns;
  // width_fr was emitted into a custom property the stylesheet never read, so
  // every table came out equal-width whatever the storyboard asked for. These
  // are now real per-column widths, as percentages of the table.
  const fractions = cols.map((c, i) => cssNumber(c.width_fr ?? 1, `table column ${i + 1} width_fr`));
  const totalFr = fractions.reduce((a, b) => a + b, 0);
  if (!(totalFr > 0)) {
    throw new DeckError(`slide ${slide.id}: the table's column widths sum to ${totalFr}`, EXIT.VERDICT_FAILED);
  }
  const widths = fractions.map((f) => `${Math.round((f / totalFr) * 10000) / 100}%`);
  const head = cols.map((c, i) => `<th data-deck-id="${ELEMENT_IDS.tableHeading(i)}" data-deck-role="table-header" style="width:${widths[i]};text-align:${alignOf(c, i)}">${esc(c.heading)}</th>`).join('');
  const rows = t.rows.map((row, r) => {
    if (row.length !== cols.length) {
      throw new DeckError(
        `slide ${slide.id}: table row ${r + 1} has ${row.length} cells but there are ${cols.length} columns`,
        EXIT.VERDICT_FAILED,
        ['deck will not pad or drop cells: a table whose shape is wrong is a content error, not a layout one.'],
      );
    }
    return `
        <tr class="${r % 2 === 1 ? 'alt' : ''}" data-deck-id="tr-${r + 1}" data-deck-role="table-row">${row.map((cell, c) => `<td data-deck-id="${ELEMENT_IDS.tableCell(r, c)}" data-deck-role="table-cell" style="text-align:${alignOf(cols[c], c)}">${esc(cell)}</td>`).join('')}</tr>`;
  }).join('');
  return `
    ${decoration(ctx, 'content')}
    ${slots(ctx)}
    <div class="content${slide.footer ? ' content--with-footer' : ''}">
      ${headline(ctx)}
      <table class="data-table" data-deck-id="table" data-deck-role="table">
        <thead><tr data-deck-id="thead-row" data-deck-role="table-head-row">${head}</tr></thead>
        <tbody>${rows}
        </tbody>
      </table>
      ${figureNote('table-note', t.note)}
    </div>
    ${footerBanner(ctx)}
    ${pageNumber(ctx)}`;
}

/**
 * `comparison` - two to four options on shared axes.
 *
 * A GRID, not a set of columns. The axes are grid ROWS spanning every column,
 * so corresponding cells sit at the same height by construction rather than
 * by anyone lining them up - which is the design kit's 左右で項目・尺度・
 * ラベル位置を対応させる, enforced by the layout rather than asked for.
 *
 * @param {RenderCtx} ctx
 */
function comparison(ctx) {
  const { slide, theme } = ctx;
  const c = slide.comparison;
  if (!c) {
    throw new DeckError(`slide ${slide.id} is page_type "comparison" but has no comparison`, EXIT.VERDICT_FAILED);
  }
  const cols = c.columns;
  const n = cols.length;
  const head = cols.map((col, i) => `
        <div class="cmp-col-head${col.emphasis ? ' cmp-col-head--pick' : ''}" data-deck-id="cmp-head-${i + 1}" data-deck-role="comparison-head" data-deck-group="cmp-col-${i + 1}">
          <span class="cmp-label" data-deck-id="cmp-label-${i + 1}" data-deck-role="comparison-label">${esc(col.label)}</span>
          ${col.caption ? `<span class="cmp-caption" data-deck-id="cmp-caption-${i + 1}" data-deck-role="comparison-caption">${esc(col.caption)}</span>` : ''}
        </div>`).join('');
  // One ROW per axis: the axis name, then that axis's cell from every column.
  const rows = (c.axes || []).map((axis, r) => `
        <div class="cmp-axis" data-deck-id="cmp-axis-${r + 1}" data-deck-role="comparison-axis">${esc(axis)}</div>
        ${cols.map((col, i) => `<div class="cmp-cell${col.emphasis ? ' cmp-cell--pick' : ''}" data-deck-id="cmp-cell-${r + 1}-${i + 1}" data-deck-role="comparison-cell" data-deck-group="cmp-col-${i + 1}" data-deck-anchor="top:cmp-row-${r + 1}">${esc(col.cells[r] ?? '')}</div>`).join('')}`).join('');
  return `
    ${decoration(ctx, 'content')}
    ${slots(ctx)}
    <div class="content${slide.footer ? ' content--with-footer' : ''}">
      ${headline(ctx)}
      <div class="cmp" style="--deck-cmp-cols:${n}" data-deck-id="comparison" data-deck-role="comparison">
        <div class="cmp-axis cmp-axis--corner" data-deck-ignore></div>${head}${rows}
      </div>
      ${n === 2 ? comparisonChevron(theme) : ''}
      ${figureNote('comparison-note', c.note)}
      ${diagramArt(ctx)}
    </div>
    ${footerBanner(ctx)}
    ${pageNumber(ctx)}`;
}

/**
 * `process` - ordered steps with forward arrows.
 *
 * The number is drawn from the array position, never read out of the text, so
 * a renumbered storyboard cannot disagree with its own picture. The arrows sit
 * BETWEEN the step boxes as their own elements: the DOM says "this leads to
 * that" in the same way the page does.
 *
 * @param {RenderCtx} ctx
 */
function processFlow(ctx) {
  const { slide, theme } = ctx;
  const pr = slide.process;
  if (!pr) {
    throw new DeckError(`slide ${slide.id} is page_type "process" but has no process`, EXIT.VERDICT_FAILED);
  }
  const direction = pr.direction === 'vertical' ? 'vertical' : 'horizontal';
  const steps = pr.steps;
  const parts = steps.map((step, i) => {
    const n = i + 1;
    const box = `
        <article class="step" data-deck-id="step-${n}" data-deck-role="step" data-deck-group="step-${n}"
                 data-deck-proximity='{"max_internal_gap_px": ${theme.spacing.card_internal_max}}'>
          <div class="step-head">
            <span class="step-num" data-deck-id="step-num-${n}" data-deck-role="step-num" data-deck-decorative>${String(n).padStart(2, '0')}</span>
            ${step.label ? `<span class="step-label" data-deck-id="step-label-${n}" data-deck-role="step-label" data-deck-group="step-${n}">${esc(step.label)}</span>` : ''}
          </div>
          <h2 class="step-heading" data-deck-id="step-heading-${n}" data-deck-role="step-heading" data-deck-group="step-${n}">${esc(step.heading)}</h2>
          ${(step.items || []).length ? `<ul class="step-items" data-deck-id="step-items-${n}" data-deck-role="step-items" data-deck-group="step-${n}">${step.items.map((it, j) => `<li data-deck-id="step-${n}-item-${j + 1}" data-deck-role="bullet">${esc(it)}</li>`).join('')}</ul>` : ''}
        </article>`;
    // The arrow belongs to the GAP, so the last step has none: an arrow out of
    // the final step would point at nothing.
    return i < steps.length - 1 ? `${box}${stepArrow(theme, direction, n)}` : box;
  }).join('');
  return `
    ${decoration(ctx, 'content')}
    ${slots(ctx)}
    <div class="content${slide.footer ? ' content--with-footer' : ''}">
      ${headline(ctx)}
      <div class="process process--${direction}" data-deck-id="process" data-deck-role="process">${parts}
      </div>
      ${figureNote('process-note', pr.note)}
      ${diagramArt(ctx)}
    </div>
    ${footerBanner(ctx)}
    ${pageNumber(ctx)}`;
}

/**
 * `ecosystem` - a hub with its periphery, or functions over a shared base.
 *
 * HUB: the node boxes are placed on a ring computed once, and the connector
 * layer is drawn from the SAME positions, so a line always starts at the
 * centre's edge and ends at a node's edge. Every label is inside its box;
 * nothing is ever written on a connector, which is the kit's
 * 交差とラベルへの重なりを避け.
 *
 * LAYERS: the last layer is the shared base and is drawn as the band beneath
 * the others, because 共通基盤 is a containment statement and losing it would
 * make the picture say something else.
 *
 * @param {RenderCtx} ctx
 */
function ecosystem(ctx) {
  const { slide, theme } = ctx;
  const e = slide.ecosystem;
  if (!e) {
    throw new DeckError(`slide ${slide.id} is page_type "ecosystem" but has no ecosystem`, EXIT.VERDICT_FAILED);
  }
  const body = e.layout === 'hub' ? hubBody(e, theme) : layersBody(e);
  return `
    ${decoration(ctx, 'content')}
    ${slots(ctx)}
    <div class="content${slide.footer ? ' content--with-footer' : ''}">
      ${headline(ctx)}
      ${body}
      ${figureNote('ecosystem-note', e.note)}
      ${e.layout === 'layers' ? diagramArt(ctx) : ''}
    </div>
    ${footerBanner(ctx)}
    ${pageNumber(ctx)}`;
}

/** @param {any} e @param {any} theme */
function hubBody(e, theme) {
  const W = 1562;
  // Tall enough that the vertical connectors read as connectors. At 436 the
  // top and bottom nodes sat 31 px from the hub and the arrows between them
  // were shorter than the arrowheads.
  const H = 500;
  const NODE_W = 304;
  const NODE_H = 104;
  const CENTRE_W = 392;
  const CENTRE_H = 128;
  const nodes = e.nodes || [];
  const ring = ringPositions(nodes.length, W, H, NODE_W, NODE_H);
  const centre = { cx: W / 2, cy: H / 2, w: CENTRE_W, h: CENTRE_H };
  const placed = ring.map((pos, i) => ({ ...pos, direction: nodes[i].direction || 'to' }));
  const nodeBoxes = nodes.map((node, i) => {
    const pos = ring[i];
    return `
        <div class="eco-node" data-deck-id="eco-node-${i + 1}" data-deck-role="ecosystem-node" data-deck-group="eco-node-${i + 1}"
             style="left:${Math.round(pos.cx - NODE_W / 2)}px;top:${Math.round(pos.cy - NODE_H / 2)}px;width:${NODE_W}px;min-height:${NODE_H}px">
          <span class="eco-node-label" data-deck-id="eco-node-label-${i + 1}" data-deck-role="ecosystem-label">${esc(node.label)}</span>
          ${node.caption ? `<span class="eco-node-caption" data-deck-id="eco-node-caption-${i + 1}" data-deck-role="ecosystem-caption">${esc(node.caption)}</span>` : ''}
        </div>`;
  }).join('');
  return `
      <div class="eco eco--hub" style="height:${H}px" data-deck-id="ecosystem" data-deck-role="ecosystem">
        ${hubConnectors(theme, placed, centre, W, H)}
        <div class="eco-centre" data-deck-id="eco-centre" data-deck-role="ecosystem-centre" data-deck-group="eco-centre"
             style="left:${Math.round(centre.cx - CENTRE_W / 2)}px;top:${Math.round(centre.cy - CENTRE_H / 2)}px;width:${CENTRE_W}px;min-height:${CENTRE_H}px">
          <span class="eco-centre-label" data-deck-id="eco-centre-label" data-deck-role="ecosystem-label">${esc(e.centre.label)}</span>
          ${e.centre.caption ? `<span class="eco-centre-caption" data-deck-id="eco-centre-caption" data-deck-role="ecosystem-caption">${esc(e.centre.caption)}</span>` : ''}
        </div>${nodeBoxes}
      </div>`;
}

/** @param {any} e */
function layersBody(e) {
  const layers = e.layers || [];
  const last = layers.length - 1;
  const bands = layers.map((layer, i) => `
        <div class="eco-layer${i === last ? ' eco-layer--base' : ''}" data-deck-id="eco-layer-${i + 1}" data-deck-role="ecosystem-layer" data-deck-group="eco-layer-${i + 1}">
          <div class="eco-layer-head">
            <span class="eco-layer-label" data-deck-id="eco-layer-label-${i + 1}" data-deck-role="ecosystem-label">${esc(layer.label)}</span>
            ${layer.caption ? `<span class="eco-layer-caption" data-deck-id="eco-layer-caption-${i + 1}" data-deck-role="ecosystem-caption">${esc(layer.caption)}</span>` : ''}
          </div>
          ${(layer.items || []).length ? `<div class="eco-layer-items">${layer.items.map((it, j) => `<span class="eco-chip" data-deck-id="eco-layer-${i + 1}-item-${j + 1}" data-deck-role="ecosystem-item">${esc(it)}</span>`).join('')}</div>` : ''}
        </div>`).join('');
  return `
      <div class="eco eco--layers" data-deck-id="ecosystem" data-deck-role="ecosystem">${bands}
      </div>`;
}

/**
 * `timeline` - dated entries along an axis, in the author's order.
 *
 * NOTHING IS SORTED. `when` is free text the source wrote - 来週火曜 is a
 * legitimate value - and sorting it would reorder the facts. The array order
 * is the time order, and several things at one time stay inside one entry,
 * which is what keeps 同じ時期の出来事はまとめても、時間関係を変えない true.
 *
 * @param {RenderCtx} ctx
 */
function timeline(ctx) {
  const { slide, theme } = ctx;
  const t = slide.timeline;
  if (!t) {
    throw new DeckError(`slide ${slide.id} is page_type "timeline" but has no timeline`, EXIT.VERDICT_FAILED);
  }
  const entries = t.entries;
  const cells = entries.map((entry, i) => {
    const n = i + 1;
    return `
        <div class="tl-entry${entry.emphasis ? ' tl-entry--pick' : ''}" data-deck-id="tl-entry-${n}" data-deck-role="timeline-entry" data-deck-group="tl-${n}"
             data-deck-proximity='{"max_internal_gap_px": ${theme.spacing.card_internal_max}}'>
          <span class="tl-when" data-deck-id="tl-when-${n}" data-deck-role="timeline-when" data-deck-group="tl-${n}">${esc(entry.when)}</span>
          <span class="tl-label" data-deck-id="tl-label-${n}" data-deck-role="timeline-label" data-deck-group="tl-${n}">${esc(entry.label)}</span>
          ${(entry.items || []).length ? `<ul class="tl-items" data-deck-id="tl-items-${n}" data-deck-role="timeline-items" data-deck-group="tl-${n}">${entry.items.map((it, j) => `<li data-deck-id="tl-${n}-item-${j + 1}" data-deck-role="bullet">${esc(it)}</li>`).join('')}</ul>` : ''}
        </div>`;
  }).join('');
  return `
    ${decoration(ctx, 'content')}
    ${slots(ctx)}
    <div class="content${slide.footer ? ' content--with-footer' : ''}">
      ${headline(ctx)}
      <div class="timeline" style="--deck-tl-count:${entries.length}" data-deck-id="timeline" data-deck-role="timeline">
        ${timelineAxis(theme, entries.length)}
        <div class="tl-entries">${cells}
        </div>
      </div>
      ${figureNote('timeline-note', t.note)}
      ${diagramArt(ctx)}
    </div>
    ${footerBanner(ctx)}
    ${pageNumber(ctx)}`;
}

/** @type {Record<string, (ctx: RenderCtx) => string>} */
export const TEMPLATES = {
  cover,
  agenda,
  'section-divider': sectionDivider,
  'standard-3col': standard3col,
  table,
  statement,
  comparison,
  process: processFlow,
  ecosystem,
  timeline,
};
