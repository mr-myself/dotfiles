import { box, finding } from '../finding.js';

/**
 * ALIGNMENT GRID.
 *
 * Two different severities, and the split is the point:
 *
 *   FAIL        a DECLARED shared anchor is violated. Elements carrying
 *               data-deck-anchor="left:title" promise to share an edge, and a
 *               1 px drift there is a defect in the component.
 *   SUGGESTION  an UNDECLARED near-miss: two edges 1.4 px apart that were
 *               probably meant to line up. Reported, never failed, because the
 *               author may well have meant it - and a linter that fails on
 *               guesses gets switched off.
 *
 * The anchor name encodes the edge: "left:xxx", "right:xxx", "top:xxx",
 * "bottom:xxx". Multiple anchors are comma-separated.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function alignmentRule({ slides, theme }) {
  const findings = [];
  const tolerance = theme?.lint?.anchor_tolerance_px ?? 0.5;
  const nearMissWindow = theme?.lint?.alignment_near_miss_px ?? 3;

  for (const slide of slides) {
    // --- declared anchors -------------------------------------------------
    /** @type {Map<string, {el: any, edge: string, value: number}[]>} */
    const groups = new Map();
    for (const el of slide.elements) {
      if (!el.visible || !el.anchor || !el.rect) continue;
      for (const raw of String(el.anchor).split(',')) {
        const spec = raw.trim();
        if (!spec) continue;
        const [edge, ...rest] = spec.split(':');
        const name = rest.join(':');
        if (!name || !['left', 'right', 'top', 'bottom'].includes(edge)) {
          findings.push(finding({
            rule: 'alignment',
            severity: 'unsupported',
            slide: slide.slide_id,
            element: el.id,
            message: `${el.id} declares anchor "${spec}", which is not of the form left|right|top|bottom:<name>, so the shared edge cannot be checked`,
          }));
          continue;
        }
        const value = edgeValue(el.rect, edge);
        if (!groups.has(spec)) groups.set(spec, []);
        groups.get(spec).push({ el, edge, value });
      }
    }
    for (const [spec, members] of groups) {
      if (members.length < 2) continue;
      const values = members.map((m) => m.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (max - min <= tolerance) continue;
      // Report against the modal value so the ONE displaced element is named,
      // not all of them.
      const reference = mode(values);
      for (const m of members) {
        if (Math.abs(m.value - reference) <= tolerance) continue;
        findings.push(finding({
          rule: 'alignment',
          slide: slide.slide_id,
          element: m.el.id,
          axis: m.edge === 'left' || m.edge === 'right' ? 'x' : 'y',
          reference: spec,
          message: `${m.el.id} declares the shared anchor "${spec}" but its ${m.edge} edge is at ${round2(m.value)} while the anchor group sits at ${round2(reference)} (${round2(Math.abs(m.value - reference))} px off)`,
          expected: { [`${m.edge}_edge`]: round2(reference), tolerance_px: tolerance, anchor: spec, members: members.map((x) => x.el.id) },
          measured: { [`${m.edge}_edge`]: round2(m.value), off_by_px: round2(m.value - reference) },
          boxes: members.map((x) => box(x.el.rect, x.el.id, x.el === m.el ? 'offender' : 'context')).filter(Boolean),
        }));
      }
    }

    // --- undeclared near misses ------------------------------------------
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const live = slide.elements.filter((e) => e.visible && e.rect && !e.decorative && e.zone !== 'decorative');
      for (let i = 0; i < live.length; i += 1) {
        for (let j = i + 1; j < live.length; j += 1) {
          const a = live[i];
          const b = live[j];
          if (sharesAnchor(a, b, edge)) continue;
          // A table and its own last row share a bottom edge by construction,
          // as does any box and its padding-less child. Reporting those as
          // near misses produced four suggestions for one table and buried
          // the findings that were about genuinely unrelated elements.
          if (nested(a.rect, b.rect) || nested(b.rect, a.rect)) continue;
          const d = Math.abs(edgeValue(a.rect, edge) - edgeValue(b.rect, edge));
          if (d <= tolerance || d > nearMissWindow) continue;
          findings.push(finding({
            rule: 'alignment',
            severity: 'suggestion',
            slide: slide.slide_id,
            element: a.id,
            axis: edge === 'left' || edge === 'right' ? 'x' : 'y',
            message: `${a.id} and ${b.id} have ${edge} edges ${round2(d)} px apart - near enough to look like a mistake, far enough to see. Declare a shared anchor if they should line up, or move them further apart if they should not.`,
            expected: { note: 'either exactly equal, or visibly different' },
            measured: { [`a_${edge}`]: round2(edgeValue(a.rect, edge)), [`b_${edge}`]: round2(edgeValue(b.rect, edge)), other_element: b.id, delta_px: round2(d) },
            boxes: [box(a.rect, a.id), box(b.rect, b.id, 'context')].filter(Boolean),
          }));
        }
      }
    }
  }
  return findings;
}

/** Is `inner` contained in `outer`, give or take the near-miss window? */
function nested(outer, inner) {
  const slack = 3;
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack
    && inner.x + inner.w <= outer.x + outer.w + slack
    && inner.y + inner.h <= outer.y + outer.h + slack;
}

function sharesAnchor(a, b, edge) {
  if (!a.anchor || !b.anchor) return false;
  const sa = new Set(String(a.anchor).split(',').map((s) => s.trim()));
  const sb = new Set(String(b.anchor).split(',').map((s) => s.trim()));
  for (const s of sa) if (sb.has(s) && s.startsWith(`${edge}:`)) return true;
  return false;
}

function edgeValue(r, edge) {
  if (edge === 'left') return r.x;
  if (edge === 'right') return r.x + r.w;
  if (edge === 'top') return r.y;
  return r.y + r.h;
}

function mode(values) {
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const v of values) {
    const k = Math.round(v * 2) / 2;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = values[0];
  let bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount) { bestCount = c; best = k; }
  }
  return best;
}

function round2(n) { return Math.round(n * 100) / 100; }

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect'],
};
