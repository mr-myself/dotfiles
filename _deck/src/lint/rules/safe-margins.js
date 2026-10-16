import { box, finding } from '../finding.js';

/**
 * SAFE MARGINS: body content against the theme's margins.
 *
 * Not every element is body content, so the theme declares permitted zones and
 * an element opts into one with data-deck-zone:
 *
 *   body        (the default) must stay inside the safe content rectangle
 *   footer      the footer banner legitimately runs to the bottom margin band
 *   pagination  the page number sits in the margin by design - that is where
 *               the reference deck puts it
 *   decorative  washes and rules that bleed to the canvas edge on purpose
 *   bleed       full-bleed imagery
 *
 * An undeclared zone is treated as body, so forgetting the attribute makes the
 * check STRICTER rather than weaker. That direction is deliberate: a missing
 * annotation must never buy an exemption.
 *
 * WHAT IS MEASURED, AND WHY IT IS THE LAYOUT BOX.
 *
 * The element's layout box fails the rule. A text line's FONT box, which can
 * be larger, is reported as a suggestion instead. The reason is a measured
 * property of the pinned font: Noto Sans JP's natural line box is 1.44 em
 * (ascent 1.16 + descent 0.288), while its ink is roughly 0.88 em. At a
 * heading's designed line-height of 1.24 the text's client rect therefore
 * sticks 2.5 px out of its own line box at top and bottom - on text that is
 * sitting exactly where the designer put it, with white space either side.
 *
 * Failing on that would reject correct layouts. It would also contradict the
 * reference deck this theme was measured from: there the eyebrow rule sits at
 * y 42 and the glyph ink at y 45, so the first line's font box begins ABOVE
 * the margin by construction. The margin is a statement about ink, and the
 * closest thing to ink a rectangle check has is the box the designer
 * positioned.
 *
 * The remaining honest limit is narrower: this measures rectangles, so it
 * cannot see that a glyph's ink sits inside its own advance width. A
 * character whose painted ink stops a pixel short of the margin and whose
 * line box crosses it is reported.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function safeMarginsRule({ slides, theme }) {
  const findings = [];
  const slack = theme?.lint?.margin_slack_px ?? 0.5;
  const permitted = new Set(['footer', 'pagination', 'decorative', 'bleed']);

  for (const slide of slides) {
    const safe = slide.regions['content-region'];
    if (!safe) {
      findings.push(finding({
        rule: 'safe-margins',
        severity: 'unsupported',
        slide: slide.slide_id,
        message: 'this slide declares no "content-region", so body content cannot be checked against the theme margins',
      }));
      continue;
    }
    /** @type {{el: any, breaches: [string, number][], rect: any}[]} */
    const crossings = [];
    for (const el of slide.elements) {
      if (!el.visible) continue;
      if (el.decorative) continue;
      if (el.zone && permitted.has(el.zone)) continue;
      // THE LAYOUT BOX **AND** THE PAINTED INK.
      //
      // The box alone missed text that overflows it: `overflow: visible` text
      // running past its container breaches the margin while its box does
      // not, and no other rule caught it either. The ink union is now
      // leading-free (collect.js subtracts half-leading rather than clipping),
      // so including it no longer produces the font-metric false failures
      // that made this rule measure the box alone in the first place.
      const r = unionOf(el.rect, el.content_union);
      if (!r || r.w <= 0 || r.h <= 0) continue;

      const breaches = breachesOf(r, safe, slack);
      if (breaches.length > 0) {
        // COLLECTED, NOT EMITTED. Whether this crossing is explained by one
        // INSIDE it cannot be known until every element has been measured,
        // and DOM order hands over the ancestor first. See
        // explainedByDescendant below.
        crossings.push({ el, breaches, rect: r });
        continue;
      }

      // The element is inside the margins. Report, as a SUGGESTION, a text
      // line whose font box reaches past them anyway - which on this font is
      // ordinary and expected, and is still worth seeing once rather than
      // never.
      for (const line of el.text_lines) {
        const lineBreaches = breachesOf(line, safe, slack);
        if (lineBreaches.length === 0) continue;
        findings.push(finding({
          rule: 'safe-margins',
          severity: 'suggestion',
          slide: slide.slide_id,
          element: el.id,
          reference: 'content-region',
          message: `${el.id} sits inside the margins, but its text's FONT box reaches ${lineBreaches.map(([side, by]) => `${by.toFixed(2)} px past the ${side}`).join(', ')}. That is the font's reserved vertical space, not ink - ${el.style.font_family.split(',')[0]} reserves well over its glyph height - so this is not a failure. Widen the margin or loosen the line-height only if the page looks tight.`,
          expected: { within: 'content-region', content_region: round(safe), measured_on: 'text font box' },
          measured: {
            element_box: round(r),
            text_font_box: round(line),
            font_size_px: el.style.font_size_px,
            font_box_ratio: Math.round((line.h / el.style.font_size_px) * 1000) / 1000,
            text: line.text,
            breaches: lineBreaches.map(([s, b]) => ({ side: s, by_px: Math.round(b * 100) / 100 })),
          },
          boxes: [box(safe, 'content-region', 'reference'), box(line, `${el.id} font box`)].filter(Boolean),
        }));
        break;
      }
    }

    // EMIT, now that every element on the slide has been measured.
    for (const c of crossings) {
      if (explainedByDescendant(c, crossings)) continue;
      findings.push(finding({
        rule: 'safe-margins',
        slide: slide.slide_id,
        element: c.el.id,
        reference: 'content-region',
        message: `${c.el.id} crosses the safe content margin: ${c.breaches.map(([side, by]) => `${by.toFixed(2)} px past the ${side}`).join(', ')}${c.el.zone ? ` (zone "${c.el.zone}" is not a permitted margin zone)` : ' (no zone declared, so it is treated as body content)'}`,
        expected: { within: 'content-region', content_region: round(safe), permitted_zones: [...permitted] },
        measured: {
          rect: round(c.rect),
          zone: c.el.zone || null,
          breaches: c.breaches.map(([sd, b]) => ({ side: sd, by_px: Math.round(b * 100) / 100 })),
        },
        boxes: [box(safe, 'content-region', 'reference'), box(c.rect, c.el.id)].filter(Boolean),
      }));
    }
  }
  return findings;
}

/** The smallest rect containing both, skipping empties. */
function unionOf(a, b) {
  const live = [a, b].filter((r) => r && r.w > 0 && r.h > 0);
  if (live.length === 0) return null;
  const x = Math.min(...live.map((r) => r.x));
  const y = Math.min(...live.map((r) => r.y));
  const right = Math.max(...live.map((r) => r.x + r.w));
  const bottom = Math.max(...live.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** @returns {[string, number][]} */
function breachesOf(r, safe, slack) {
  /** @type {[string, number][]} */
  const out = [];
  if (r.x < safe.x - slack) out.push(['left', safe.x - r.x]);
  if (r.y < safe.y - slack) out.push(['top', safe.y - r.y]);
  if (r.x + r.w > safe.x + safe.w + slack) out.push(['right', (r.x + r.w) - (safe.x + safe.w)]);
  if (r.y + r.h > safe.y + safe.h + slack) out.push(['bottom', (r.y + r.h) - (safe.y + safe.h)]);
  return out;
}

function round(r) {
  const n = (v) => Math.round(v * 100) / 100;
  return r ? { x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) } : null;
}

/** @see geometry-check.js - the fields this rule requires to be well formed. */
/**
 * A CONTAINER THAT CROSSES THE MARGIN ONLY BECAUSE ITS CONTENT DOES IS NOT A
 * SECOND DEFECT.
 *
 * A table whose last rows run past the bottom drags its <tbody>, its <table>
 * and every wrapper above it past the same edge, and each one used to be
 * reported. On a heavy stress page 29 of 126 findings were ancestors
 * repeating a descendant's breach, and the element an author can actually
 * move is the innermost one. Same reasoning as the overflow rule attributing
 * a clipped line to the element that owns the text.
 *
 * "ONLY BECAUSE" is the load-bearing phrase. The ancestor is dropped only when
 * a reported descendant breaches the SAME SIDE by AT LEAST as much. A
 * container that sticks out further than anything inside it is sticking out on
 * its own account, and is still reported.
 *
 * @param {{el: any, breaches: [string, number][]}} c
 * @param {{el: any, breaches: [string, number][]}[]} all
 */
function explainedByDescendant(c, all) {
  const inside = all.filter((o) => o !== c
    && Array.isArray(o.el.ancestry) && o.el.ancestry.includes(c.el.id));
  if (inside.length === 0) return false;
  return c.breaches.every(([side, by]) => inside.some(
    (o) => o.breaches.some(([side2, by2]) => side2 === side && by2 >= by - 0.5),
  ));
}

export const READS = {
  rects: ['rect', 'content_union?'],
  nested: { style: ['font_size_px'] },
  textLines: true,
};
