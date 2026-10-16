import { box, finding } from '../finding.js';

/**
 * TYPE SIZE: role minimums and the theme's body band.
 *
 * Only elements that DRAW text are checked. A wrapper inherits a font size it
 * never paints with - a centring container around an 84 px heading computes to
 * the document's 16 px - so checking it would report a role as far out of band
 * while the text the reader actually sees is exactly right.
 *
 * The design kit states every size as a [min, max] RANGE rather than a scalar,
 * and the reason is in its own overflow rules: when content does not fit, the
 * author may re-wrap and re-compose but must not shrink the text to a size
 * nobody can read. So the band is the contract, and a role that falls out of
 * its band fails whichever side it falls out of - too large is a layout
 * mistake just as much as too small.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function typeSizeRule({ slides, theme }) {
  const findings = [];
  const bands = theme?.typography?.size_bands_px || {};
  const absoluteMin = theme?.lint?.absolute_min_font_px ?? 14;

  for (const slide of slides) {
    for (const el of slide.elements) {
      if (!el.visible) continue;
      if (!el.text || !el.own_text) continue;
      const size = el.style.font_size_px;
      if (!size) continue;

      // The floor applies to every piece of text, role or no role. Text with
      // no declared role is exactly where an unreadable size hides.
      if (size < absoluteMin) {
        findings.push(finding({
          rule: 'type-size',
          slide: slide.slide_id,
          element: el.id,
          message: `${el.id} renders text at ${size} px, below the theme's absolute readable floor of ${absoluteMin} px`,
          expected: { min_px: absoluteMin },
          measured: { font_size_px: size, role: el.role, text: el.text.slice(0, 60) },
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
        continue;
      }

      if (!el.role) continue;
      const band = bands[el.role];
      if (!band) continue;
      const [min, max] = band;
      if (size >= min - 0.5 && size <= max + 0.5) continue;
      findings.push(finding({
        rule: 'type-size',
        slide: slide.slide_id,
        element: el.id,
        message: `${el.id} has role "${el.role}" rendered at ${size} px, outside the theme band ${min}-${max} px`,
        expected: { role: el.role, band_px: [min, max] },
        measured: { font_size_px: size, text: el.text.slice(0, 60) },
        boxes: [box(el.rect, el.id)].filter(Boolean),
      }));
    }
  }
  return findings;
}

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect'],
  nested: { style: ['font_size_px'] },
};
