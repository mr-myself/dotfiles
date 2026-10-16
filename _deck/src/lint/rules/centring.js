import { box, finding } from '../finding.js';

/**
 * TWO-AXIS CENTRING - the rule the whole design exists to make possible.
 *
 * An element declares its contract in the DOM:
 *
 *   placement: {reference: "content-region", align_x: "center",
 *               align_y: "center", measure: "content-union",
 *               tolerance_px: 2}
 *
 * Three decisions in that contract matter, and all three come from real bugs:
 *
 * 1. `reference` is DECLARED, never guessed. The design kit's margins are
 *    vertically asymmetric - top 60, bottom 65 - so the canvas centre and the
 *    safe-content centre are 2.5 px apart on the y axis. A rule that guessed
 *    would pass a title centred against the wrong one.
 *
 * 2. The axes are checked INDEPENDENTLY. An element nudged 9 px right and
 *    perfectly centred vertically must fail on x and only on x, because
 *    "centring is off" sends the author hunting in two dimensions.
 *
 * 3. `measure: content-union` measures the inner text/child union rather than
 *    the element's own box. A full-width wrapper is centred in its parent by
 *    definition, so measuring the wrapper proves nothing; "the box is centred
 *    but its contents are not" is the exact defect this catches.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function centringRule({ slides, theme }) {
  const findings = [];
  const defaultTolerance = theme?.lint?.centring_tolerance_px ?? 2;

  for (const slide of slides) {
    for (const el of slide.elements) {
      const p = el.placement;
      if (!p) continue;
      if (p.__parse_error) {
        findings.push(finding({
          rule: 'centring',
          severity: 'unsupported',
          slide: slide.slide_id,
          element: el.id,
          message: `the placement contract on ${el.id} is not valid JSON, so its centring cannot be checked: ${p.__parse_error}`,
          measured: { raw: p.__raw },
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
        continue;
      }
      const wantsX = p.align_x === 'center';
      const wantsY = p.align_y === 'center';
      if (!wantsX && !wantsY) continue;

      if (!el.visible) {
        findings.push(finding({
          rule: 'centring',
          slide: slide.slide_id,
          element: el.id,
          message: `${el.id} declares a centring contract but is not visible, so the contract is unverifiable`,
          severity: 'unsupported',
        }));
        continue;
      }

      const refName = p.reference;
      if (!refName) {
        findings.push(finding({
          rule: 'centring',
          severity: 'unsupported',
          slide: slide.slide_id,
          element: el.id,
          message: `${el.id} declares centring without a reference region; deck refuses to guess one`,
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
        continue;
      }
      const ref = slide.regions[refName];
      if (!ref) {
        findings.push(finding({
          rule: 'centring',
          severity: 'unsupported',
          slide: slide.slide_id,
          element: el.id,
          reference: refName,
          message: `${el.id} is centred against reference region "${refName}", which does not exist on this slide (known: ${Object.keys(slide.regions).join(', ')})`,
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
        continue;
      }

      const measureMode = p.measure || 'content-union';
      const measured = measureMode === 'box' ? el.rect : el.content_union;
      if (!measured) {
        findings.push(finding({
          rule: 'centring',
          severity: 'unsupported',
          slide: slide.slide_id,
          element: el.id,
          reference: refName,
          message: `${el.id} declares measure "${measureMode}" but has no measurable ${measureMode === 'box' ? 'box' : 'content'}; an empty centred element cannot be verified`,
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
        continue;
      }

      const tolerance = p.tolerance_px ?? defaultTolerance;
      const dx = measured.cx - ref.cx;
      const dy = measured.cy - ref.cy;

      // Each axis is its own finding. Independent failure is the feature.
      if (wantsX && Math.abs(dx) > tolerance) {
        findings.push(axisFinding(slide, el, refName, ref, measured, measureMode, 'x', dx, tolerance));
      }
      if (wantsY && Math.abs(dy) > tolerance) {
        findings.push(axisFinding(slide, el, refName, ref, measured, measureMode, 'y', dy, tolerance));
      }
    }
  }
  return findings;
}

function axisFinding(slide, el, refName, ref, measured, measureMode, axis, delta, tolerance) {
  const dir = axis === 'x'
    ? (delta > 0 ? 'right' : 'left')
    : (delta > 0 ? 'down' : 'up');
  const refCentre = axis === 'x' ? ref.cx : ref.cy;
  const gotCentre = axis === 'x' ? measured.cx : measured.cy;
  return finding({
    rule: 'centring',
    slide: slide.slide_id,
    element: el.id,
    axis,
    reference: refName,
    message: `${el.id} is ${Math.abs(delta).toFixed(2)} px too far ${dir} of the ${axis === 'x' ? 'horizontal' : 'vertical'} centre of "${refName}" (tolerance ${tolerance} px, measured on ${measureMode})`,
    expected: {
      [`${axis === 'x' ? 'cx' : 'cy'}`]: round2(refCentre),
      tolerance_px: tolerance,
      reference_region: refName,
      reference_rect: roundRect(ref),
      measure: measureMode,
    },
    measured: {
      [`${axis === 'x' ? 'cx' : 'cy'}`]: round2(gotCentre),
      [`d${axis}`]: round2(delta),
      measured_rect: roundRect(measured),
      element_box: roundRect(el.rect),
    },
    boxes: [
      box(ref, `reference ${refName}`, 'reference'),
      box(measured, `${el.id} (${measureMode})`, 'offender'),
    ].filter(Boolean),
  });
}

function round2(n) { return Math.round(n * 100) / 100; }
function roundRect(r) {
  if (!r) return null;
  return { x: round2(r.x), y: round2(r.y), w: round2(r.w), h: round2(r.h), cx: round2(r.cx), cy: round2(r.cy) };
}

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect', 'content_union?'],
  // Every region a placement contract NAMES, not just the two standard ones.
  // A custom reference region missing cx/cy made every comparison NaN, and
  // `NaN > tolerance` is false, so the rule reported nothing.
  referencedRegions: true,
};
