/**
 * DIAGRAMS, DRAWN RATHER THAN GENERATED.
 *
 * The deck turned every relationship into a table, because a table was the
 * only structure it had. Four options with verdicts, one thing splitting into
 * two, conditions gating an outcome, staged scope over time - all of them
 * arrived as rows, and a reader had to reconstruct the relationship from the
 * text. The PO asked for ビジュアライズによって理解をしやすくする and got a
 * spreadsheet.
 *
 * WHY THESE ARE DRAWN AND THE SCENERY IS GENERATED.
 *
 * That line is the one the whole architecture rests on. An arrow's start and
 * end, the order of steps, what contains what, which column a cell belongs to
 * - all of it is MEANING, and an image generator gets it wrong in ways
 * nothing downstream can detect. A watercolour ridge that is slightly the
 * wrong shape costs nothing; an arrow pointing the wrong way is a false
 * statement rendered at 1672x941 and shown to a room. So scenery is generated
 * and structure is drawn, and the drawing is built from the storyboard's own
 * fields so that it cannot disagree with the words.
 *
 * WHAT THE DESIGN KIT REQUIRES THESE TO PRESERVE, and where each is kept:
 *
 *   登場主体        every node/column/step is a DOM box carrying its own label
 *   順序            the array order is the draw order; nothing is sorted
 *   矢印の始点と終点 connectors are computed from the two boxes they join
 *   方向            declared per node, and the arrowhead follows it
 *   包含関係        a layer's items are drawn INSIDE the layer's box
 *   共通基盤        the last layer is drawn as the base beneath the others
 *   比較軸          one row per axis, shared across every column
 *   ラベル          every label is in a box; nothing is ever on a connector
 */

/** @param {any} theme */
function ink(theme) {
  const c = theme.colors;
  return {
    flow: c.accent_teal?.hex || '#0F8A9A',
    structure: c.heading_navy?.hex || '#03224F',
    soft: c.table_rule?.hex || '#C1D1E1',
    accent: c.rule_orange?.hex || '#F56C21',
  };
}

/**
 * An arrowhead marker.
 *
 * One per SVG instance with a per-instance id, because two SVGs in one
 * document sharing a marker id would have the second silently use the first.
 *
 * @param {string} id
 * @param {string} colour
 */
function arrowMarker(id, colour) {
  return `<marker id="${id}-head" viewBox="0 0 10 10" refX="9" refY="5"
      markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="${colour}"/>
    </marker>`;
}

/**
 * THE CONNECTOR LAYER FOR A HUB ECOSYSTEM.
 *
 * Drawn under the node boxes, from the centre's edge to each node's edge, so
 * a line never starts inside a box or ends on a word. The geometry comes from
 * the same ring the template lays the boxes out on, which is why the two
 * cannot drift: there is one source of positions.
 *
 * @param {any} theme
 * @param {{cx: number, cy: number, x: number, y: number, w: number, h: number, direction: string}[]} nodes
 * @param {{cx: number, cy: number, w: number, h: number}} centre
 * @param {number} w
 * @param {number} h
 */
export function hubConnectors(theme, nodes, centre, w, h) {
  const k = ink(theme);
  const id = 'hub';
  const lines = nodes.map((n, i) => {
    // Start and end on the BOX EDGES, along the line joining the two centres.
    const dx = n.cx - centre.cx;
    const dy = n.cy - centre.cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const from = edgePoint(centre.cx, centre.cy, centre.w / 2 + 10, centre.h / 2 + 10, ux, uy);
    const to = edgePoint(n.cx, n.cy, n.w / 2 + 10, n.h / 2 + 10, -ux, -uy);
    const marker = n.direction === 'from' ? `marker-start="url(#${id}-head)"` : `marker-end="url(#${id}-head)"`;
    const both = n.direction === 'both'
      ? `marker-start="url(#${id}-head)" marker-end="url(#${id}-head)"`
      : marker;
    return `<line x1="${round(from.x)}" y1="${round(from.y)}" x2="${round(to.x)}" y2="${round(to.y)}"
        stroke="${k.flow}" stroke-width="2.4" stroke-dasharray="7 6" stroke-linecap="round"
        ${both} data-deck-connector="${i + 1}"/>`;
  }).join('\n    ');
  return `<svg class="diagram-connectors" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
     data-deck-id="ecosystem-connectors" data-deck-role="connectors" data-deck-decorative data-deck-ignore>
  <defs>${arrowMarker(id, k.flow)}</defs>
  ${lines}
</svg>`;
}

/** Where a ray from a box's centre leaves the box. */
function edgePoint(cx, cy, hw, hh, ux, uy) {
  const tx = ux === 0 ? Infinity : hw / Math.abs(ux);
  const ty = uy === 0 ? Infinity : hh / Math.abs(uy);
  const t = Math.min(tx, ty);
  return { x: cx + ux * t, y: cy + uy * t };
}

function round(n) { return Math.round(n * 100) / 100; }

/**
 * THE RING a hub's nodes are placed on.
 *
 * Deterministic from the node count, so the same content always renders the
 * same. Starts at the top and goes clockwise, which is the reading order a
 * Japanese reader brings to a radial figure.
 *
 * @param {number} count
 * @param {number} w
 * @param {number} h
 * @param {number} nodeW
 * @param {number} nodeH
 */
export function ringPositions(count, w, h, nodeW, nodeH) {
  const cx = w / 2;
  const cy = h / 2;
  // The ellipse is wide and shallow because a slide is: a circle would push
  // the top and bottom nodes off the canvas and crowd the sides.
  const rx = (w - nodeW) / 2 - 12;
  const ry = (h - nodeH) / 2 - 10;
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    return {
      cx: cx + rx * Math.cos(angle),
      cy: cy + ry * Math.sin(angle),
      w: nodeW,
      h: nodeH,
    };
  });
}

/**
 * THE ARROW BETWEEN TWO PROCESS STEPS.
 *
 * Its own element between the step boxes, not a glyph inside one, so the DOM
 * says what the picture says: this step leads to that one. The direction is
 * the storyboard's declared direction and nothing here can draw it backwards
 * - there is no parameter for that.
 *
 * @param {any} theme
 * @param {'horizontal' | 'vertical'} direction
 * @param {number} n  which gap this is, for the id
 */
export function stepArrow(theme, direction, n) {
  const k = ink(theme);
  const id = `pa${n}`;
  const horizontal = direction !== 'vertical';
  const w = horizontal ? 54 : 40;
  const h = horizontal ? 40 : 46;
  const line = horizontal
    ? `<line x1="4" y1="${h / 2}" x2="${w - 10}" y2="${h / 2}" stroke="${k.flow}" stroke-width="3" stroke-linecap="round" marker-end="url(#${id}-head)"/>`
    : `<line x1="${w / 2}" y1="4" x2="${w / 2}" y2="${h - 10}" stroke="${k.flow}" stroke-width="3" stroke-linecap="round" marker-end="url(#${id}-head)"/>`;
  return `<svg class="step-arrow step-arrow--${horizontal ? 'h' : 'v'}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
     data-deck-id="step-arrow-${n}" data-deck-role="step-arrow" data-deck-decorative data-deck-ignore>
  <defs>${arrowMarker(id, k.flow)}</defs>
  ${line}
</svg>`;
}

/**
 * The chevron the reference sets between a two-column comparison.
 *
 * Only for exactly two columns: with three or more it would have to point at
 * one of them, and a mark that singles out a column without the author saying
 * so is a verdict deck invented.
 *
 * @param {any} theme
 */
export function comparisonChevron(theme) {
  const k = ink(theme);
  return `<svg class="cmp-chevron" width="46" height="74" viewBox="0 0 46 74"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
     data-deck-id="comparison-chevron" data-deck-role="comparison-chevron" data-deck-decorative data-deck-ignore>
  <path d="M8,6 L38,37 L8,68" fill="none" stroke="${k.soft}" stroke-width="7"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

/**
 * THE TIMELINE AXIS: one line, one tick per entry, drawn from the same
 * positions the entry boxes use.
 *
 * @param {any} theme
 * @param {number} count
 * @param {number} w
 */
export function timelineAxis(theme, count, w = 1562, gap = 18) {
  const k = ink(theme);
  const h = 26;
  // THE TICKS SIT OVER THE CARDS THEY BELONG TO. Computed from the SAME grid
  // the entries are laid out on - column width and gutter - rather than by
  // dividing the axis evenly, which left every tick a few px off its card and
  // made the axis look like it belonged to a different picture.
  const colW = (w - (count - 1) * gap) / count;
  const ticks = Array.from({ length: count }, (_, i) => {
    const x = i * (colW + gap) + colW / 2;
    return `<circle cx="${round(x)}" cy="${h / 2}" r="8" fill="${k.flow}" data-deck-tick="${i + 1}"/>`;
  }).join('\n    ');
  return `<svg class="timeline-axis" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
     data-deck-id="timeline-axis" data-deck-role="timeline-axis" data-deck-decorative data-deck-ignore>
  <defs>${arrowMarker('tl', k.flow)}</defs>
  <line x1="0" y1="${h / 2}" x2="${w - 12}" y2="${h / 2}" stroke="${k.soft}" stroke-width="3"
        stroke-linecap="round" marker-end="url(#tl-head)"/>
  ${ticks}
</svg>`;
}
