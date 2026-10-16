import { box, finding } from '../finding.js';

/**
 * PROXIMITY: declared semantic groups, and the gaps between them.
 *
 * Gestalt proximity is the one typographic principle a rectangle check CAN
 * verify: if a label belongs to the field below it, the label-to-field gap
 * must be smaller than the gap to the next unrelated thing. When it is not,
 * readers group the wrong items, and that is a measurable relationship rather
 * than a matter of taste.
 *
 * A group declares its contract on its container:
 *
 *   data-deck-group="card-1"
 *   data-deck-proximity='{"max_internal_gap_px": 18, "min_external_gap_px": 32}'
 *
 * Only DECLARED groups are checked. An undeclared cluster is not guessed at:
 * inferring semantic grouping from geometry is exactly the kind of opinion
 * this linter has no business having.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function proximityRule({ slides }) {
  const findings = [];

  for (const slide of slides) {
    /** @type {Map<string, {contract: any, container: any, members: any[]}>} */
    const groups = new Map();
    for (const el of slide.elements) {
      if (!el.visible || !el.group) continue;
      if (!groups.has(el.group)) groups.set(el.group, { contract: null, container: null, members: [] });
      const g = groups.get(el.group);
      if (el.proximity) {
        if (el.proximity.__parse_error) {
          findings.push(finding({
            rule: 'proximity',
            severity: 'unsupported',
            slide: slide.slide_id,
            element: el.id,
            message: `the proximity contract on ${el.id} is not valid JSON, so group "${el.group}" cannot be checked: ${el.proximity.__parse_error}`,
          }));
        } else {
          g.contract = el.proximity;
          g.container = el;
        }
      }
      g.members.push(el);
    }

    for (const [name, g] of groups) {
      if (!g.contract) continue;
      // The container itself is not a member for spacing purposes - it
      // contains them.
      const members = g.members.filter((m) => m !== g.container && !m.decorative);
      const maxInternal = g.contract.max_internal_gap_px;
      const minExternal = g.contract.min_external_gap_px;

      // A group with fewer than two members has no internal gap. That is
      // VACUOUS, not unsupported: a statement slide with only a title is a
      // perfectly good slide, and reporting its single-member group as
      // unmeasurable would fail a correct page. The external contract below
      // still applies.

      // --- internal cohesion ---------------------------------------------
      if (maxInternal !== undefined && members.length >= 2) {
        const sorted = [...members].sort((a, b) => a.rect.y - b.rect.y);
        for (let i = 1; i < sorted.length; i += 1) {
          const prev = sorted[i - 1];
          const cur = sorted[i];
          const gap = cur.rect.y - (prev.rect.y + prev.rect.h);
          if (gap <= maxInternal + 0.5) continue;
          findings.push(finding({
            rule: 'proximity',
            slide: slide.slide_id,
            element: cur.id,
            axis: 'y',
            reference: name,
            message: `inside group "${name}", ${prev.id} and ${cur.id} are ${gap.toFixed(2)} px apart, more than the group's declared internal maximum of ${maxInternal} px - they will not read as one unit`,
            expected: { group: name, max_internal_gap_px: maxInternal },
            measured: { gap_px: round2(gap), between: [prev.id, cur.id] },
            boxes: [box(prev.rect, prev.id, 'context'), box(cur.rect, cur.id)].filter(Boolean),
          }));
        }
      }

      // --- external separation -------------------------------------------
      if (minExternal !== undefined) {
        const groupRect = union(members.length ? members.map((m) => m.rect) : [g.container.rect]);
        if (!groupRect) continue;
        for (const other of slide.elements) {
          if (!other.visible || other.decorative) continue;
          if (other.group === name) continue;
          if (!other.rect) continue;
          // Skip ancestors/descendants: a containing region is not a
          // neighbouring group.
          if (containsRect(other.rect, groupRect) || containsRect(groupRect, other.rect)) continue;
          if (other.background_of === name) continue;
          // Only compare against things that declare a group of their own:
          // a lone decorative rule or a page number is not a competing unit.
          if (!other.group) continue;
          const gap = rectGap(groupRect, other.rect);
          if (gap === null || gap >= minExternal - 0.5) continue;
          findings.push(finding({
            rule: 'proximity',
            slide: slide.slide_id,
            element: g.container ? g.container.id : members[0].id,
            reference: name,
            message: `group "${name}" is only ${gap.toFixed(2)} px from group "${other.group}" (${other.id}), closer than its declared minimum separation of ${minExternal} px - the two will read as one unit`,
            expected: { group: name, min_external_gap_px: minExternal },
            measured: { gap_px: round2(gap), other_group: other.group, other_element: other.id },
            boxes: [box(groupRect, `group ${name}`), box(other.rect, other.id, 'context')].filter(Boolean),
          }));
        }
      }
    }
  }
  return findings;
}

function union(rects) {
  const live = rects.filter(Boolean);
  if (live.length === 0) return null;
  const x = Math.min(...live.map((r) => r.x));
  const y = Math.min(...live.map((r) => r.y));
  const r2 = Math.max(...live.map((r) => r.x + r.w));
  const b2 = Math.max(...live.map((r) => r.y + r.h));
  return { x, y, w: r2 - x, h: b2 - y, cx: (x + r2) / 2, cy: (y + b2) / 2 };
}

function containsRect(outer, inner) {
  return inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5
    && inner.x + inner.w <= outer.x + outer.w + 0.5
    && inner.y + inner.h <= outer.y + outer.h + 0.5;
}

/** Shortest edge-to-edge distance; 0 when they touch or overlap. */
function rectGap(a, b) {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  if (dx === 0 && dy === 0) return 0;
  if (dx === 0) return dy;
  if (dy === 0) return dx;
  return Math.hypot(dx, dy);
}

function round2(n) { return Math.round(n * 100) / 100; }

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect'],
};
