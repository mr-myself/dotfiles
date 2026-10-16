import { box, finding } from '../finding.js';

/**
 * OCCUPANCY: how much of the content region the page actually uses.
 *
 * `standard-3col` pages on a real deck had their bottom four tenths blank and
 * every gate passed. Nothing in the linter measured how much of the page had
 * anything on it, so a column that collapsed to three lines of text under a
 * missing illustration looked, to every rule here, exactly like a column that
 * was meant to be short.
 *
 * THE EXEMPTION WAS WRITTEN BEFORE THE RULE WAS. themes/watercolor/theme.yaml
 * has said, since the theme was first measured, that `statement` has
 * "generous whitespace that is intentional and must not be treated as an
 * error by any occupancy heuristic". The rule it exempts did not exist. This
 * file is the implementation catching up, so the first thing it does is
 * honour that sentence - and the measurements below say it was right: the
 * fixture's statement page leaves 54% of its height empty under the words.
 *
 * TWO MEASUREMENTS, BECAUSE ONE IS NOT ENOUGH.
 *
 *   coverage      what fraction of the region has any content ink on it, on a
 *                 coarse grid. A bounding box would call the PO's page full -
 *                 headline at the top, footer banner at the bottom, nothing
 *                 in between - and summed rectangle areas would double-count
 *                 every nested box.
 *   trailing gap  how much of the region's HEIGHT, measured up from the
 *                 bottom, has no content in it at all. This is the one that
 *                 matches what the PO actually described: 下半分が完全な空白.
 *
 * They disagree usefully. A three-item agenda is only a third covered and has
 * its emptiness on the RIGHT, under the theme's watercolour, which is the
 * design working. A two-row table under a headline has similar coverage and
 * half its height dead at the bottom, which is not.
 *
 * WHY THERE IS NO BLOCKING TIER, which is a deliberate departure.
 *
 * The brief asked for this rule to be "blocking only where a page is
 * genuinely unfinished". It was built that way first, with per-page-type
 * floors derived from the fixture deck, and it then BLOCKED deck's own
 * `deck init` scaffold - a perfectly composed three-item agenda - at 33.6%
 * against a floor of 37%. Measured on real renders:
 *
 *                            coverage   trailing gap
 *   scaffold agenda   (good)    33.6%          37.4%
 *   fixture agenda    (good)    82.6%           0.0%
 *   fixture process   (good)    41.1%           0.0%
 *   sparse 3col        (bad)    53.5%          29.0%
 *   sparse table       (bad)    31.9%          51.7%
 *   sparse comparison  (bad)    22.4%          61.2%
 *
 * The good pages and the bad pages OVERLAP on both metrics. There is no line
 * through that data that separates them, and a blocking threshold placed
 * anywhere in the overlap fails correct work - which is the exact complaint
 * this whole round of changes is answering. Shipping a blocking floor chosen
 * by feel because the brief asked for one would be picking a threshold by
 * feel, which the brief also forbade; the measurements won.
 *
 * So both tiers report as SUGGESTIONS, and the thing that genuinely does mean
 * "unfinished" blocks in the rule that can state it without a threshold: an
 * illustration slot with no picture in it, which is what was actually wrong
 * with the page the PO was looking at. See rules/slot-fill.js.
 *
 * WHAT IS NOT COUNTED as content, each for a stated reason:
 *
 *   decorative    the theme's watercolour fills a corner of every page. It is
 *                 scenery, and counting it would mean the decoration could
 *                 hide an empty page - the precise failure this rule exists
 *                 to catch, since those pages WERE decorated.
 *   pagination    a folio in the corner is on every page and says nothing
 *                 about whether the page has content.
 *   backgrounds   a card background is a painted box the size of the card. It
 *                 is a surface for content, not content.
 *   empty slots   a page reserving half its area for an illustration that
 *                 never arrived reads as empty here, as it does to a reader.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function occupancyRule({ slides, theme }) {
  const findings = [];
  const config = theme?.lint?.occupancy;
  // NO CONFIGURATION, NO RULE. A theme that has not been measured has no
  // business being held to another theme's numbers, and inventing a default
  // here is exactly how a threshold gets picked by feel.
  if (!config) return findings;

  for (const slide of slides) {
    if (isExempt(config, slide.page_type)) continue;
    const region = slide.regions?.['content-region'];
    if (!region || !(region.w > 0) || !(region.h > 0)) continue;

    const measurement = occupancyOf(slide, config.grid);
    if (measurement === null) continue;
    const { ratio, used, cells } = measurement;
    const gap = trailingGapOf(slide);

    if (Number.isFinite(config.advise_below) && ratio < config.advise_below) {
      findings.push(finding({
        rule: 'occupancy',
        severity: 'suggestion',
        slide: slide.slide_id,
        message: `this ${slide.page_type} page has content on ${pct(ratio)} of its content region, under the ${pct(config.advise_below)} every page of the reference deck reaches. If the whitespace is deliberate it is fine - this never fails the gate. If it is not, the usual causes are an illustration slot nobody filled and a column with less in it than the others.`,
        expected: { page_type: slide.page_type, advise_below: config.advise_below },
        measured: {
          coverage: round3(ratio),
          cells_used: used,
          cells_total: cells,
          region: { w: round2(region.w), h: round2(region.h) },
        },
        boxes: [box(region, 'content-region', 'reference')].filter(Boolean),
      }));
    }

    if (gap !== null && Number.isFinite(config.trailing_gap_above) && gap > config.trailing_gap_above) {
      findings.push(finding({
        rule: 'occupancy',
        severity: 'suggestion',
        slide: slide.slide_id,
        axis: 'y',
        message: `the bottom ${pct(gap)} of this ${slide.page_type} page's content region has nothing in it. A band of dead space under the content is what made a real deck unreadable before anyone could judge its wording. Deliberate? Then leave it - this is a suggestion. Otherwise the content stops short of where this layout expects it to reach.`,
        expected: { page_type: slide.page_type, trailing_gap_above: config.trailing_gap_above },
        measured: {
          trailing_gap: round3(gap),
          empty_px: round2(gap * region.h),
          region: { w: round2(region.w), h: round2(region.h) },
        },
        boxes: [box({
          x: region.x, y: region.y + region.h * (1 - gap), w: region.w, h: region.h * gap,
        }, 'empty', 'offender')].filter(Boolean),
      }));
    }
  }
  return findings;
}

/**
 * Is this page type's emptiness the design?
 *
 * Declared in the theme rather than hard-coded here, because which pages are
 * deliberately sparse is a property of the design and not of the linter.
 *
 * @param {any} config theme.lint.occupancy
 * @param {string} pageType
 */
export function isExempt(config, pageType) {
  return (config.exempt || []).includes(pageType);
}

/**
 * The fraction of the content region that has content ink on it.
 *
 * Exported because test/geometry/fixture-deck.test.js measures the fixture
 * deck with this exact function, and the thresholds in theme.yaml come from
 * those measurements. The number that sets a threshold and the number a
 * threshold is compared against have to be produced by one piece of code.
 *
 * @param {any} slide a measured slide
 * @param {number} [gridCells] cells across the region's width
 * @returns {{ratio: number, used: number, cells: number} | null}
 */
export function occupancyOf(slide, gridCells = 48) {
  const region = slide.regions?.['content-region'];
  if (!region || !(region.w > 0) || !(region.h > 0)) return null;
  const cols = Math.max(1, Math.round(gridCells));
  const cellW = region.w / cols;
  const rows = Math.max(1, Math.round(region.h / cellW));
  const cellH = region.h / rows;
  const grid = new Uint8Array(cols * rows);

  for (const r of contentInk(slide, region)) {
    const c0 = clamp(Math.floor((r.x - region.x) / cellW), 0, cols - 1);
    const c1 = clamp(Math.ceil((r.x + r.w - region.x) / cellW) - 1, 0, cols - 1);
    const r0 = clamp(Math.floor((r.y - region.y) / cellH), 0, rows - 1);
    const r1 = clamp(Math.ceil((r.y + r.h - region.y) / cellH) - 1, 0, rows - 1);
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) grid[row * cols + col] = 1;
    }
  }

  let used = 0;
  for (const cell of grid) used += cell;
  return { ratio: used / grid.length, used, cells: grid.length };
}

/**
 * How much of the region's height, from the bottom up, holds no content.
 *
 * The measurement that matches what the PO saw: not "this page is sparse" but
 * "the bottom of this page is dead". A page whose emptiness is at the side -
 * an agenda list with the theme's landscape to the right of it - scores zero
 * here, correctly.
 *
 * @param {any} slide
 * @returns {number | null} 0..1, or null when there is nothing to measure
 */
export function trailingGapOf(slide) {
  const region = slide.regions?.['content-region'];
  if (!region || !(region.h > 0)) return null;
  let lowest = region.y;
  let any = false;
  for (const r of contentInk(slide, region)) {
    any = true;
    lowest = Math.max(lowest, Math.min(r.y + r.h, region.y + region.h));
  }
  if (!any) return 1;
  return (region.y + region.h - lowest) / region.h;
}

/**
 * Every rectangle of CONTENT ink that falls inside the region.
 *
 * One definition, used by both measurements, so they cannot disagree about
 * what counts as something being on the page.
 *
 * @param {any} slide
 * @param {any} region
 */
function contentInk(slide, region) {
  const out = [];
  for (const el of slide.elements) {
    if (!counts(el)) continue;
    const r = el.content_union || el.rect;
    if (!r || !(r.w > 0) || !(r.h > 0)) continue;
    // Entirely outside the region - a bleed slot, a folio below it - marks
    // nothing. Clamping alone would smear it onto the nearest edge.
    if (r.x + r.w <= region.x || r.x >= region.x + region.w) continue;
    if (r.y + r.h <= region.y || r.y >= region.y + region.h) continue;
    out.push(r);
  }
  return out;
}

/** Zones that are on every page and say nothing about whether it has content. */
const UNCOUNTED_ZONES = new Set(['pagination', 'decorative']);

/** @param {any} el */
function counts(el) {
  if (!el.visible) return false;
  if (el.decorative) return false;
  if (UNCOUNTED_ZONES.has(el.zone)) return false;
  if (el.background_of) return false;
  if (el.slot && el.slot_state !== 'filled') return false;
  // A WRAPPER IS NOT INK. An element with no own content union contributes
  // nothing its children do not already contribute, and counting it would
  // mark the whole region used on any page with one full-width container -
  // which every page has.
  if (!el.content_union && !isAtomic(el)) return false;
  return true;
}

/**
 * Elements that mark the page themselves rather than through children: an
 * image, a drawn diagram, a canvas.
 * @param {any} el
 */
function isAtomic(el) {
  return el.tag === 'img' || el.tag === 'svg' || el.tag === 'canvas';
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function pct(n) { return `${Math.round(n * 100)}%`; }

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect', 'content_union?'],
  slotState: true,
};
