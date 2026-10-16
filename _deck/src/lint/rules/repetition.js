import { box, finding } from '../finding.js';

/**
 * REPETITION across slides of the same page_type.
 *
 * The defect this catches is the one a human reviewer reliably misses: slide 7
 * is fine, slide 11 is fine, but their titles sit 3 px apart and flipping
 * between them in a presentation makes the deck twitch. Nobody spots that by
 * looking at one page at a time; comparing measured values across pages is
 * free.
 *
 * WHAT IS COMPARED, and what is deliberately not.
 *
 * Only values that are a DESIGN DECISION repeat: a baseline, a box top, a card
 * height, an icon diameter, the footer's position. The measured EXTENT of a
 * piece of variable-length text is not one of those - it is a function of the
 * string the author wrote.
 *
 * This rule used to compare `left` and `width` for every role, including
 * auto-width text. On a real deck that meant four chapter titles of different
 * lengths were each reported as an outlier against the others: the peers in
 * the finding disagreed among themselves (509.5, 577.86, 560.98) by more than
 * the slide being blamed (541.75) differed from any of them. Ten blocking
 * findings, every one of them wrong, on a deck whose chapter pages were
 * perfectly consistent.
 *
 * Three changes fix that, and all three are about not inventing an intended
 * value:
 *
 *   1. An element whose box is SIZED BY ITS CONTENT is exempt from `width`.
 *      That is measured, not declared: a content-sized box has a rect within a
 *      few px of its own ink union, where a full-width block is much wider
 *      than its text.
 *   2. A modal value that occurs ONCE is not a modal value. If no two slides
 *      agree there is no intended value to report against, and naming an
 *      arbitrary member of a scattered set as the offender is worse than
 *      saying nothing.
 *   3. For a content-sized box, THE CENTRE LINE is compared as well as the
 *      left edge, and the rule reports against whichever of the two the
 *      slides actually agree on. This is the part that restores coverage
 *      rather than just removing noise - see below.
 *
 * THE CENTRE LINE, AND WHY IT IS INFERRED RATHER THAN DECLARED.
 *
 * Exempting a centred role from `left` makes the false findings stop, and
 * also makes a genuinely mis-centred chapter subtitle invisible. The PO's own
 * measurements say what to do instead:
 *
 *   ch-01 left=509.50 width=662.98      cx = 840.99
 *   ch-02 left=541.75 width=598.50      cx = 841.00
 *   ch-03 left=577.86 width=526.28      cx = 841.00
 *   ch-04 left=560.98 width=560.03      cx = 841.00
 *
 * Four values 68 px apart in one column and four identical values in the
 * other. The left edge is a function of how many characters the author typed;
 * the centre line is where the designer put it, and it is pinned to the pixel.
 *
 * Which of the two is the design decision is not declared anywhere, so it is
 * INFERRED from the only evidence there is: whichever the slides agree on.
 * Both are sampled, the mode of each is taken, and the metric with the
 * stronger agreement is the one reported against - the other is discarded as
 * a function of the text. A centred role agrees on its centre; a left-aligned
 * one agrees on its left edge; neither has to be written down anywhere, and a
 * theme that changes its mind does not have to remember to update a list.
 *
 * The modal value is taken as the intended one, so the one odd slide is named
 * rather than all of them.
 *
 * A ROLE THAT APPEARS SEVERAL TIMES IS MEASURED AS A ROW.
 *
 * Three cards on a slide are one row, and the row's top and left edges are a
 * design decision while any single card's height is the length of the body
 * text in it. Comparing the first card alone made the rule's answer depend on
 * which card happened to be first; comparing the union makes it a statement
 * about the row, which is the thing the layout actually places.
 *
 * A legitimate exception is DECLARED as a variant - data-deck-variant on the
 * canvas - and slides are only compared within the same (page_type, variant)
 * bucket. So "this one page genuinely has taller cards" is expressible without
 * switching the rule off.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function repetitionRule({ slides, theme }) {
  const findings = [];
  const tolerance = theme?.lint?.repetition_tolerance_px ?? 1.5;
  const roles = theme?.lint?.repetition_roles
    || ['section-label', 'title', 'subtitle', 'card', 'icon-circle', 'footer-banner', 'page-number'];

  /** @type {Map<string, any[]>} */
  const buckets = new Map();
  for (const slide of slides) {
    const key = `${slide.page_type}::${slide.variant || 'default'}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(slide);
  }

  for (const [key, group] of buckets) {
    if (group.length < 2) continue;
    const [pageType, variant] = key.split('::');
    for (const role of roles) {
      // Measure each metric independently: a card can be the right height and
      // the wrong width. `centre-x` competes with `left` and is resolved
      // below rather than reported alongside it.
      /** @type {Map<string, {samples: any[], reference: number, agreement: number}>} */
      const measuredMetrics = new Map();
      for (const metric of ['top', 'left', 'centre-x', 'height', 'width']) {
        /** @type {{slide: any, el: any, value: number}[]} */
        const samples = [];
        for (const slide of group) {
          const el = rowOf(slide, role);
          if (!el) continue;
          // THE EXTENT OF VARIABLE-LENGTH TEXT IS NOT A DESIGN DECISION.
          // Where the box hugs its own ink, `width` says how long the string
          // is, not how wide the designer made the box.
          if (metric === 'width' && contentSizedOn(el, 'width')) continue;
          if (metric === 'height' && contentSizedOn(el, 'height')) continue;
          // A box that does NOT hug its ink is positioned by its left edge
          // and sized by the layout, so its centre carries no information its
          // left and width do not already carry.
          if (metric === 'centre-x' && !contentSizedOn(el, 'width')) continue;
          if (metric === 'top' && downstreamOfVariableText(slide, el)) continue;
          samples.push({ slide, el, value: metricValue(el.rect, metric) });
        }
        if (samples.length < 2) continue;
        const { value: reference, count: agreement } = mode(samples.map((s) => s.value));
        // NO TWO SLIDES AGREE, SO THERE IS NO INTENDED VALUE. Reporting the
        // member furthest from an arbitrary pick would be inventing one.
        if (agreement < 2) continue;
        measuredMetrics.set(metric, { samples, reference, agreement });
      }

      // THE HORIZONTAL DESIGN DECISION IS ONE OF THE TWO, NOT BOTH.
      //
      // A centred role agrees on its centre and scatters its left edge; a
      // left-aligned one does the reverse. Reporting both would mean every
      // centred role fails on `left` and every left-aligned one fails on
      // `centre-x` - the rule contradicting itself twice per slide. The
      // stronger agreement wins, and a tie goes to `left`, which is what the
      // overwhelming majority of this design's roles actually use.
      const byLeft = measuredMetrics.get('left');
      const byCentre = measuredMetrics.get('centre-x');
      if (byLeft && byCentre) {
        measuredMetrics.delete(byCentre.agreement > byLeft.agreement ? 'left' : 'centre-x');
      }

      for (const [metric, { samples, reference }] of measuredMetrics) {
        const outliers = samples.filter((s) => Math.abs(s.value - reference) > tolerance);
        if (outliers.length === 0) continue;
        // If everything disagrees there is no "intended" value to report
        // against; say that instead of naming every slide an outlier.
        if (outliers.length === samples.length) {
          findings.push(finding({
            rule: 'repetition',
            slide: samples[0].slide.slide_id,
            element: samples[0].el.id,
            message: `the ${METRIC_LABEL[metric]} of role "${role}" differs on every ${pageType} slide (${samples.map((s) => `${s.slide.slide_id}=${round2(s.value)}`).join(', ')}); there is no consistent value for this page type`,
            expected: { role, metric, note: 'one shared value across slides of a page type, or a declared variant' },
            measured: { page_type: pageType, variant, samples: samples.map((s) => ({ slide: s.slide.slide_id, value: round2(s.value) })) },
            boxes: [box(samples[0].el.rect, samples[0].el.id)].filter(Boolean),
          }));
          continue;
        }
        for (const o of outliers) {
          findings.push(finding({
            rule: 'repetition',
            slide: o.slide.slide_id,
            element: o.el.id,
            axis: metric === 'top' || metric === 'height' ? 'y' : 'x',
            message: `${o.el.id} (role "${role}") has ${METRIC_LABEL[metric]} ${round2(o.value)} on this ${pageType} slide, while the other ${pageType} slides use ${round2(reference)} (${round2(Math.abs(o.value - reference))} px off). Declare a variant if this page is meant to differ.`,
            expected: { role, metric, [metric]: round2(reference), tolerance_px: tolerance },
            measured: {
              page_type: pageType,
              variant,
              [metric]: round2(o.value),
              off_by_px: round2(o.value - reference),
              peers: samples.filter((s) => s !== o).map((s) => ({ slide: s.slide.slide_id, value: round2(s.value) })),
            },
            boxes: [box(o.el.rect, o.el.id)].filter(Boolean),
          }));
        }
      }
    }
  }
  return findings;
}

function metricValue(r, metric) {
  if (metric === 'top') return r.y;
  if (metric === 'left') return r.x;
  if (metric === 'centre-x') return r.cx;
  if (metric === 'height') return r.h;
  return r.w;
}

/** How a metric reads in a message. */
const METRIC_LABEL = {
  top: 'top',
  left: 'left edge',
  'centre-x': 'horizontal centre line',
  height: 'height',
  width: 'width',
};

/**
 * THE ROW a role occupies on one slide: one element, or the union of them all.
 *
 * Three cards are a row, and the row is what the layout places. Taking the
 * first card instead made the answer depend on card order, and made a slide
 * with its cards in a different order look like a slide with its cards in the
 * wrong place.
 *
 * The union carries a content_union too, so contentSizedOn works on a row
 * exactly as it works on a single box: a row of cards that hugs its own text
 * vertically is as tall as the longest body, which is content and not a
 * design decision.
 *
 * @param {any} slide
 * @param {string} role
 */
function rowOf(slide, role) {
  const els = slide.elements.filter((e) => e.visible && e.role === role && e.rect);
  if (els.length === 0) return null;
  if (els.length === 1) return els[0];
  return {
    id: `${els.length} x ${role}`,
    group: els[0].group,
    rect: unionRect(els.map((e) => e.rect)),
    content_union: unionRect(els.map((e) => e.content_union).filter(Boolean)),
  };
}

/** @param {any[]} rects */
function unionRect(rects) {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return {
    x, y, w: right - x, h: bottom - y, cx: (x + right) / 2, cy: (y + bottom) / 2,
  };
}

/**
 * How much wider than its own ink a box may be and still count as hugging it.
 *
 * A text box that is sized by its content sits within a few px of its ink: the
 * slack is the font's side bearings plus Chrome's sub-pixel rounding. A
 * full-width block is wider than its text by however much of the line is
 * empty, which on a slide is tens or hundreds of pixels.
 */
const CONTENT_SIZED_SLACK_PX = 8;

/**
 * Is this metric an EXTENT that the content decides, rather than a position
 * the designer decided?
 *
 * `left` and `width` on a box that hugs its own ink horizontally; `height` on
 * a box that hugs it vertically - a three-column card is as tall as its body
 * text ran, and comparing that across slides reports "this slide's second
 * bullet wrapped" as a layout defect.
 *
 * `top` is never exempt. A content-sized box still starts where it was put,
 * and that is exactly the drift this rule exists to catch. Nor is `left`
 * exempt any more: it is sampled, and so is the centre line, and the caller
 * keeps whichever of the two the slides agree on.
 *
 * @param {any} el
 * @param {'top' | 'left' | 'height' | 'width'} metric
 */
function contentSizedOn(el, metric) {
  if (metric === 'top') return false;
  if (!el.content_union || !el.rect) return false;
  if (metric === 'height') {
    return el.rect.h > 0 && (el.rect.h - el.content_union.h) <= CONTENT_SIZED_SLACK_PX;
  }
  return el.rect.w > 0 && (el.rect.w - el.content_union.w) <= CONTENT_SIZED_SLACK_PX;
}

/**
 * Does something content-sized sit ABOVE this element in its own group?
 *
 * A subtitle under a chapter title sits wherever the title's last line left
 * it, so on a two-line title it is 51 px lower - and that is the design
 * working, not drifting. Its top is downstream of a variable height, so it
 * carries no information about whether the page was laid out consistently.
 * The title's own top still does, and is still compared.
 *
 * @param {any} slide
 * @param {any} el
 */
function downstreamOfVariableText(slide, el) {
  if (!el.group || !el.rect) return false;
  return slide.elements.some((other) => other !== el
    && other.group === el.group
    && other.rect
    && other.rect.y < el.rect.y
    && contentSizedOn(other, 'height'));
}

/**
 * The most common value, AND how many samples agreed on it.
 *
 * The count is what the caller needs: a "mode" of one is not evidence of an
 * intended value, and treating it as one is how four different-length titles
 * became ten blocking findings.
 *
 * @param {number[]} values
 * @returns {{value: number, count: number}}
 */
function mode(values) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const v of values) {
    const k = Math.round(v * 2) / 2;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = values[0];
  let bestCount = 0;
  for (const [k, c] of counts) {
    if (c > bestCount) { bestCount = c; best = k; }
  }
  return { value: best, count: bestCount };
}

function round2(n) { return Math.round(n * 100) / 100; }

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect', 'content_union?'],
};
