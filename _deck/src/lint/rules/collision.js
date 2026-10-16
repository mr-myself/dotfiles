import { box, finding } from '../finding.js';

/**
 * COLLISION: unrelated foreground boxes that intersect.
 *
 * INKED CONTENT IS COMPARED, NOT LAYOUT BOXES. An element's measured rect and
 * the area it actually marks are different things: a flex wrapper that centres
 * a title is the full size of the content region by construction, so comparing
 * rects reported it as colliding with the page number in the far corner -
 * geometrically true, visually nothing. The content union is the ink, and the
 * ink is what can collide.
 *
 * Most overlap in a well-built slide is legitimate, so the exceptions carry
 * the weight here. Allowed, and each for a stated reason:
 *
 *   DOM nesting          a title inside its card is not a collision. This is
 *                        checked against real ancestry recorded by the
 *                        collector, NOT against rectangles. Treating geometric
 *                        containment as nesting exempted the two worst cases
 *                        there are: two unrelated elements occupying the same
 *                        rectangle, and one unrelated element completely
 *                        covering another. Total overlap is maximal collision,
 *                        and it used to score zero findings.
 *   card backgrounds     an element marked data-deck-background-of="card-1"
 *                        is the backing for that card and must sit under it
 *   same group           members of a declared semantic group are composed on
 *                        purpose; PROXIMITY governs their spacing instead
 *   decorative           data-deck-decorative declares overlap as intended -
 *                        a watercolour wash bleeding under a heading is the
 *                        theme working, not a defect
 *   pagination / bleed   the theme positions these against the canvas edge by
 *                        design. Where they may sit is a SAFE MARGINS question
 *                        - it has a permitted-zones list for exactly this -
 *                        and asking it twice would just produce a finding the
 *                        author cannot act on.
 *
 * NOT exempt, deliberately: the footer zone. Body content running down into
 * the footer band is a real defect, the footer band sits INSIDE the safe
 * region so the margin rule cannot see it, and this is the only rule that can.
 *
 * A tiny intersection is ignored: adjacent boxes that share an edge round to
 * a fraction of a pixel apart, and firing on that would bury the real finding.
 *
 * A PAINTING ELEMENT COLLIDES WITH ITS WHOLE PAINTED BOX.
 *
 * Ink-against-ink was right for two pieces of text and wrong for a painted
 * band. A table's note ran down under the footer banner on a real deck and was
 * completely unreadable; `collision` reported zero. The banner is 1672x92 px
 * of painted wash, its text ink is 722x62, and the hidden row was under the
 * part of the band that has no ink in it - so there was nothing to intersect.
 * Reproduced here before this was changed: a cell plainly washed out in the
 * PNG, 2418 px2 inside the band, not reported by any rule.
 *
 * So an element that paints a background of its own - a colour OR a gradient,
 * and the banner's wash is a gradient - is compared at its full rect, because
 * that is the area it actually covers. An element that paints nothing is still
 * compared at its ink. Both halves matter: widening everything would report
 * every flex wrapper against everything it contains.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function collisionRule({ slides, theme }) {
  const findings = [];
  const minArea = theme?.lint?.collision_min_area_px2 ?? 4;

  for (const slide of slides) {
    const live = slide.elements
      .map((e) => ({ el: e, ink: extent(e) }))
      .filter(({ el, ink: r }) => el.visible && r && r.w > 0 && r.h > 0);
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i];
        const b = live[j];
        if (exempt(a.el, b.el)) continue;
        const ov = intersect(a.ink, b.ink);
        if (!ov || ov.w * ov.h <= minArea) continue;
        const painted = Boolean(a.el.paints_background || b.el.paints_background);
        findings.push(finding({
          rule: 'collision',
          slide: slide.slide_id,
          element: a.el.id,
          message: painted
            ? `${a.el.id} and ${b.el.id} overlap by ${Math.round(ov.w)}x${Math.round(ov.h)} px, and one of them paints a surface over that area - whatever is underneath is hidden, not merely close. Neither declares the overlap (not nested, not a declared background, not in the same group, not decorative, not in a bleed or pagination zone).`
            : `${a.el.id} and ${b.el.id} have content overlapping by ${Math.round(ov.w)}x${Math.round(ov.h)} px, and neither declares the overlap (not nested, not a declared background, not in the same group, not decorative, not in a bleed or pagination zone)`,
          expected: { overlap_area_px2: `<= ${minArea}` },
          measured: {
            other_element: b.el.id,
            overlap: { x: round2(ov.x), y: round2(ov.y), w: round2(ov.w), h: round2(ov.h) },
            a_content: round2Rect(a.ink),
            b_content: round2Rect(b.ink),
            a_box: round2Rect(a.el.rect),
            b_box: round2Rect(b.el.rect),
            a_paints: Boolean(a.el.paints_background),
            b_paints: Boolean(b.el.paints_background),
          },
          boxes: [
            box(a.ink, a.el.id),
            box(b.ink, b.el.id),
            box(ov, 'overlap'),
          ].filter(Boolean),
        }));
      }
    }
  }
  return findings;
}

/**
 * The area an element actually marks.
 *
 * A PAINTING element covers its whole rect, so that is its extent: a band of
 * colour hides what is under all of it, not only under its words. Everything
 * else is its content union - the ink - because a flex wrapper that centres a
 * title is the full size of the content region by construction and comparing
 * rects reported it as colliding with the page number in the far corner.
 *
 * An empty element that paints nothing - a hairline rule, an icon circle -
 * has no content union and IS its box either way.
 *
 * @param {any} el
 */
function extent(el) {
  if (el.paints_background) return el.rect;
  return el.content_union || el.rect;
}

/** Zones the theme positions against the canvas edge on purpose. */
const OUT_OF_FLOW_ZONES = new Set(['pagination', 'bleed', 'decorative']);

function exempt(a, b) {
  // REAL ANCESTRY, not geometry. `ancestry` is the list of deck ids between
  // an element and the canvas, recorded in the DOM where the answer actually
  // lives.
  if (isAncestorOf(a, b) || isAncestorOf(b, a)) return true;
  if (a.decorative || b.decorative) return true;
  if (OUT_OF_FLOW_ZONES.has(a.zone) || OUT_OF_FLOW_ZONES.has(b.zone)) return true;
  if (backs(a, b) || backs(b, a)) return true;
  if (a.group && a.group === b.group) return true;
  return false;
}

/**
 * Does `bg` declare itself the backing for `el`?
 *
 * `data-deck-background-of="card-1"` backs the element with that id AND
 * everything inside it: a card's background sits under the card's heading and
 * its body, which is the entire reason it exists. It also backs a declared
 * GROUP of that name.
 */
function backs(bg, el) {
  if (!bg.background_of) return false;
  if (bg.background_of === el.id) return true;
  if (bg.background_of === el.group) return true;
  return Array.isArray(el.ancestry) && el.ancestry.includes(bg.background_of);
}

/**
 * Is `ancestor` a DOM ancestor of `descendant`?
 *
 * Falls back to `false` when ancestry was not recorded - geometry from an
 * older render, say. Failing CLOSED is deliberate: the worst outcome of a
 * missing exemption is a reported collision the author dismisses, while the
 * worst outcome of a wrong exemption is two headings printed on top of each
 * other and nobody told.
 */
function isAncestorOf(ancestor, descendant) {
  if (!Array.isArray(descendant.ancestry)) return false;
  return descendant.ancestry.includes(ancestor.id);
}

function intersect(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bo = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bo <= y) return null;
  return { x, y, w: r - x, h: bo - y };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round2Rect(r) {
  return r ? { x: round2(r.x), y: round2(r.y), w: round2(r.w), h: round2(r.h) } : null;
}

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect', 'content_union?'],
};
