/**
 * THE WATERCOLOUR DECORATION, AS VECTOR.
 *
 * The reference deck carries a soft watercolour landscape in the top-right of
 * every content page, a larger one down the right of its cover, divider and
 * agenda pages, and a small botanical wash in the bottom-left. Without them a
 * rendered page is a correctly-measured grid of text on white, which is
 * exactly what the PO saw and exactly why they said it did not look like the
 * reference. Geometry was never the problem.
 *
 * WHY IT IS BUILT HERE RATHER THAN SHIPPED AS A PNG.
 *
 * The reference artwork is in the PO's confidential client deck and must not
 * be copied into this repository. Generating a raster is not available to
 * this tool either. So the decoration is drawn: layered translucent paths
 * under a soft blur, with a fractal-noise layer at low opacity for paper
 * tooth. It is not the reference illustration and does not pretend to be -
 * it is a wash in the reference's palette and shape language, which is what
 * makes the page read as the same design.
 *
 * INLINE, NOT url(). Every decoration is emitted into the document as an
 * inline <svg>. A CSS url() would be a resource request that has to survive
 * into the published standalone HTML, and a file:// reference that works in
 * the render and breaks when the deck is handed to someone else is worse than
 * no decoration.
 *
 * IT IS ALWAYS DECORATIVE. Each root carries data-deck-decorative, so the
 * collision rule permits content to sit over it, and it is never allowed to
 * carry a word: the no-text rule that governs slot images governs this too.
 */

/**
 * VARIATION, DETERMINISTIC FROM THE SLIDE ID.
 *
 * Every page rendered the identical wash, so a deck read as one slide
 * repeated fifteen times - the reference varies its landscape page to page.
 * The variation is seeded from the slide's own id rather than from a counter
 * or a random number, for two reasons: a given slide always renders the same,
 * so the render fingerprint is stable and a re-render is byte-identical; and
 * inserting a slide does not reshuffle the artwork of every slide after it.
 *
 * @param {string} s
 */
function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i += 1) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

/**
 * A DOCUMENT-UNIQUE ID PREFIX FOR ONE DECORATION INSTANCE.
 *
 * Every slide in a render lives in ONE document - that is deliberate, and it
 * is what makes the geometry deck lints and the PDF it ships come from the
 * same layout. It also means every `id` in every inline SVG shares one
 * namespace, and a duplicate is resolved to the FIRST definition silently.
 *
 * Three functions in this file took an `id` parameter with a default, and
 * nothing ever passed one, so all eight content pages defined `dtr-mask` and
 * all eight used the first page's. The first page's wash is 701 px wide; the
 * process page's is 865. Its wash was therefore masked to 701 px and cut dead
 * at x = 1508 with a straight vertical edge, which the PO read - correctly -
 * as a misplaced image box. The comments above these filters warned about
 * exactly this and the defaults defeated them.
 *
 * Derived from the seed, so it is stable across renders: the same slide gets
 * the same ids, the render fingerprint does not move, and a re-render is
 * byte-identical.
 *
 * @param {string} prefix
 * @param {string|number} seed
 */
function uid(prefix, seed) {
  return `${prefix}${seedOf(String(seed)).toString(36)}`;
}

/** A small deterministic generator, so one seed gives a whole wash. */
function rng(seed) {
  let x = seed;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * A ridge line of `n` peaks across a width, varied by the generator.
 *
 * The SHAPE changes - how many peaks, how high, where they fall - rather than
 * just the colour, because a recoloured identical silhouette still reads as
 * the same picture.
 *
 * @param {() => number} rand
 * @param {number} w
 * @param {number} base    the ridge's average height
 * @param {number} amp     how far peaks swing around it
 * @param {number} peaks
 */
function ridgeLine(rand, w, base, amp, peaks) {
  const pts = [];
  for (let i = 0; i <= peaks; i += 1) {
    const x = Math.round((i / peaks) * w);
    const y = Math.round(base - amp * rand() - (i % 2 === 0 ? amp * 0.35 : 0));
    pts.push([x, y]);
  }
  return pts;
}

/**
 * The palette the washes are drawn from, taken from the theme so a theme
 * override moves the decoration with it.
 * @param {any} theme
 */
function palette(theme) {
  const c = theme.colors;
  return {
    far: c.decor_far?.hex || '#BFD8E6',
    mid: c.decor_mid?.hex || '#8FB8CE',
    near: c.decor_near?.hex || '#5E93AE',
    foliage: c.decor_foliage?.hex || '#A9C6A4',
    deep: c.decor_deep?.hex || '#44708C',
  };
}

/**
 * Paper tooth and a soft edge.
 *
 * `feTurbulence` at a low octave count gives the mottling real watercolour has
 * where pigment settles; `feGaussianBlur` on the whole group is what stops the
 * ridges reading as flat vector shapes. The filter is defined once per SVG and
 * carries a per-instance id, because two SVGs in one document with the same
 * filter id would have the second silently use the first.
 *
 * @param {string} id
 * @param {number} blur
 */
function washFilter(id, blur, tooth = 7) {
  return `
    <filter id="${id}-wash" x="-15%" y="-15%" width="130%" height="130%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="${tooth}" result="tooth"/>
      <feDisplacementMap in="SourceGraphic" in2="tooth" scale="7" xChannelSelector="R" yChannelSelector="G" result="rough"/>
      <feGaussianBlur in="rough" stdDeviation="${blur}"/>
    </filter>
    <filter id="${id}-soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${blur * 2.2}"/>
    </filter>`;
}

/**
 * A ridge line across a box, as a closed path down to the baseline.
 * @param {number[][]} points
 * @param {number} baseline
 * @param {number} width
 */
function ridge(points, baseline, width) {
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  return `${d} L${width},${baseline} L0,${baseline} Z`;
}

/**
 * A MASK THAT DISSOLVES ON THE INNER TWO EDGES.
 *
 * The wash sits in the top-right corner, so its top and right edges are the
 * CANVAS edges - a painting that runs off the paper there is correct and is
 * what the reference does. Its left and bottom edges are inside the page, and
 * those are the ones that have to disappear into the paper.
 *
 * The previous mask was a single radial gradient from the top-right corner.
 * Its ramp ran from 0.72 to 1.0 of the radius, which near the foot of the box
 * is only a few dozen pixels, and the foot is where all four ridge layers
 * overlap and the wash is densest. The result had a straight bottom edge and
 * a straight right-hand edge, and the PO read the whole thing as a misplaced
 * image box rather than as paint.
 *
 * Two linear gradients NESTED as masks multiply, which gives each edge its
 * own ramp: the horizontal one dissolves across the left 60% of the width,
 * the vertical one across the bottom 60% of the height, and neither has to
 * compromise for the other. Nested masks are SVG 1.1 and need no blend mode.
 *
 * @param {string} id   per-instance, because two SVGs in one document sharing
 *                      a mask id would have the second silently use the first
 * @param {number} w
 * @param {number} h
 */
function dissolve(id, w, h) {
  return `<linearGradient id="${id}-fx" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000"/>
      <stop offset="0.18" stop-color="#2a2a2a"/>
      <stop offset="0.42" stop-color="#9a9a9a"/>
      <stop offset="0.62" stop-color="#e8e8e8"/>
      <stop offset="0.78" stop-color="#fff"/>
    </linearGradient>
    <linearGradient id="${id}-fy" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="0.30" stop-color="#fff"/>
      <stop offset="0.52" stop-color="#dcdcdc"/>
      <stop offset="0.74" stop-color="#787878"/>
      <stop offset="0.92" stop-color="#141414"/>
      <stop offset="1" stop-color="#000"/>
    </linearGradient>
    <mask id="${id}-mask-y">
      <rect width="${w}" height="${h}" fill="url(#${id}-fy)"/>
    </mask>
    <mask id="${id}-mask">
      <rect width="${w}" height="${h}" fill="url(#${id}-fx)" mask="url(#${id}-mask-y)"/>
    </mask>`;
}

/**
 * THE TOP-RIGHT WASH, on every content page.
 *
 * Three ridge layers from pale to deeper, a drift of mist across them, and a
 * suggestion of roofs at the right where the reference puts its village. It
 * fades out to the LEFT and DOWN so that it never competes with the title,
 * which starts at the left margin and runs under it.
 *
 * @param {any} theme
 * @param {object} [opts]
 * @param {number} [opts.w]
 * @param {number} [opts.h]
 * @param {string} [opts.id]
 */
export function mountainsTopRight(theme, { w = 760, h = 300, seed = 'default' } = {}) {
  const id = uid('dtr', seed);
  const p = palette(theme);
  const rand = rng(seedOf(seed));
  // Width and height vary a little too, so the wash does not occupy an
  // identical rectangle on every page.
  const W = Math.round(w * (0.84 + rand() * 0.3));
  const H = Math.round(h * (0.86 + rand() * 0.26));
  const tooth = Math.floor(rand() * 90) + 3;
  const far = ridgeLine(rand, W, H * 0.46, H * 0.3, 4 + Math.floor(rand() * 3));
  const mid = ridgeLine(rand, W, H * 0.6, H * 0.26, 4 + Math.floor(rand() * 3));
  const near = ridgeLine(rand, W, H * 0.74, H * 0.2, 3 + Math.floor(rand() * 3));
  const trees = ridgeLine(rand, W, H * 0.88, H * 0.12, 5 + Math.floor(rand() * 3));
  const roofX = Math.round(W * (0.6 + rand() * 0.25));
  const roofY = Math.round(H * 0.86);
  // EVERY RIDGE IS CLOSED WELL BELOW THE BOX, so no polygon's flat bottom
  // edge is ever inside the visible area. Closing them at H put a straight
  // horizontal line across the foot of the wash, and the mask then had to
  // fade a dense four-layer band out within the last 12% of the height - too
  // fast to read as anything but a cut. The PO saw it as a misplaced image
  // box, which is exactly what a soft painting with one straight edge is.
  const BELOW = Math.round(H * 1.9);
  return `<svg class="decor decor--topright" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
     data-deck-id="decor-topright" data-deck-role="decoration" data-deck-decorative data-deck-ignore>
  <defs>
    ${washFilter(id, 2.4, tooth)}
    ${dissolve(id, W, H)}
  </defs>
  <g mask="url(#${id}-mask)">
    <g filter="url(#${id}-soft)" opacity="0.34">
      <path fill="${p.far}" d="${ridge(far, BELOW, W)}"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.46">
      <path fill="${p.mid}" d="${ridge(mid, BELOW, W)}"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.5">
      <path fill="${p.near}" d="${ridge(near, BELOW, W)}"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.42">
      <path fill="${p.foliage}" d="${ridge(trees, BELOW, W)}"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.5" fill="${p.deep}">
      <path d="M${roofX},${roofY} l34,-26 34,26 z"/>
      <rect x="${roofX + 14}" y="${roofY}" width="40" height="22" rx="2"/>
    </g>
    <g filter="url(#${id}-soft)" opacity="0.5" fill="#FFFFFF">
      <ellipse cx="${Math.round(W * 0.56)}" cy="${Math.round(H * 0.72)}" rx="${Math.round(W * 0.26)}" ry="20"/>
    </g>
  </g>
</svg>`;
}

/**
 * THE TALL RIGHT-HAND HERO, for cover, divider and agenda pages.
 *
 * The same landscape carried down the page: ridges at the top, a village band
 * in the middle, water and stones at the foot. It bleeds off the right and
 * bottom edges, as the reference does, and fades to nothing on its left so
 * the text column has no hard boundary to fight.
 *
 * @param {any} theme
 * @param {object} [opts]
 */
export function heroRight(theme, { w = 620, h = 941, seed = 'default' } = {}) {
  const id = uid('dhr', seed);
  const p = palette(theme);
  return `<svg class="decor decor--hero" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
     data-deck-id="decor-hero" data-deck-role="decoration" data-deck-decorative data-deck-ignore>
  <defs>
    ${washFilter(id, 3)}
    <linearGradient id="${id}-fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000"/>
      <stop offset="0.34" stop-color="#8a8a8a"/>
      <stop offset="0.66" stop-color="#fff"/>
    </linearGradient>
    <linearGradient id="${id}-foot" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff"/>
      <stop offset="0.86" stop-color="#fff"/>
      <stop offset="1" stop-color="#4a4a4a"/>
    </linearGradient>
    <mask id="${id}-mask">
      <rect width="${w}" height="${h}" fill="url(#${id}-fade)"/>
      <rect width="${w}" height="${h}" fill="url(#${id}-foot)" style="mix-blend-mode:multiply"/>
      <rect x="0" y="0" width="3" height="${h}" fill="#000"/>
    </mask>
  </defs>
  <g mask="url(#${id}-mask)">
    <g filter="url(#${id}-soft)" opacity="0.3">
      <path fill="${p.far}" d="${ridge([[0, 300], [110, 196], [220, 250], [330, 140], [450, 212], [w, 150]], 520, w)}"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.44">
      <path fill="${p.mid}" d="${ridge([[0, 372], [96, 290], [210, 338], [322, 240], [438, 300], [w, 244]], 560, w)}"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.46">
      <path fill="${p.near}" d="${ridge([[0, 452], [104, 392], [216, 430], [330, 360], [452, 410], [w, 364]], 610, w)}"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.5">
      <path fill="${p.foliage}" d="${ridge([[0, 556], [92, 500], [196, 540], [306, 482], [418, 528], [520, 486], [w, 514]], 700, w)}"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.55" fill="${p.deep}">
      <path d="M186,604 l44,-34 44,34 z"/><rect x="200" y="604" width="56" height="34" rx="2"/>
      <path d="M278,620 l50,-38 50,38 z"/><rect x="296" y="620" width="64" height="38" rx="2"/>
      <path d="M396,596 l42,-32 42,32 z"/><rect x="410" y="596" width="54" height="32" rx="2"/>
      <path d="M486,626 l46,-34 46,34 z"/><rect x="502" y="626" width="58" height="34" rx="2"/>
    </g>
    <g filter="url(#${id}-soft)" opacity="0.45" fill="#FFFFFF">
      <ellipse cx="300" cy="586" rx="210" ry="22"/>
      <ellipse cx="470" cy="618" rx="160" ry="18"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.4">
      <path fill="${p.mid}" d="M0,742 C140,712 300,768 ${w},726 L${w},${h} L0,${h} Z"/>
    </g>
    <g filter="url(#${id}-wash)" opacity="0.5" fill="${p.deep}">
      <ellipse cx="206" cy="800" rx="34" ry="19"/>
      <ellipse cx="300" cy="826" rx="26" ry="15"/>
      <ellipse cx="412" cy="798" rx="30" ry="17"/>
      <ellipse cx="516" cy="834" rx="24" ry="14"/>
    </g>
    <g filter="url(#${id}-soft)" opacity="0.5" fill="#FFFFFF">
      <ellipse cx="330" cy="862" rx="260" ry="26"/>
    </g>
  </g>
</svg>`;
}

/**
 * THE BOTTOM-LEFT BOTANICAL, a quiet corner the reference never leaves empty.
 *
 * Small, pale and low-contrast: it is there to stop the page's bottom-left
 * corner reading as an unfinished margin, not to be looked at.
 *
 * @param {any} theme
 * @param {object} [opts]
 */
export function leavesBottomLeft(theme, { w = 250, h = 190, seed = 'default' } = {}) {
  const id = uid('dbl', seed);
  const p = palette(theme);
  const leaf = (cx, cy, rx, ry, rot, fill, op) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" opacity="${op}" transform="rotate(${rot} ${cx} ${cy})"/>`;
  return `<svg class="decor decor--leaves" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
     data-deck-id="decor-leaves" data-deck-role="decoration" data-deck-decorative data-deck-ignore>
  <defs>
    ${washFilter(id, 1.6)}
    <radialGradient id="${id}-fade" cx="0%" cy="100%" r="112%">
      <stop offset="0" stop-color="#d8d8d8"/>
      <stop offset="0.5" stop-color="#6e6e6e"/>
      <stop offset="1" stop-color="#000"/>
    </radialGradient>
    <mask id="${id}-mask">
      <rect width="${w}" height="${h}" fill="url(#${id}-fade)"/>
    </mask>
  </defs>
  <g mask="url(#${id}-mask)" filter="url(#${id}-wash)">
    <path d="M6,184 C40,150 70,120 96,74" stroke="${p.foliage}" stroke-width="3" fill="none" opacity="0.5"/>
    <path d="M6,184 C52,168 96,146 142,112" stroke="${p.foliage}" stroke-width="2.4" fill="none" opacity="0.42"/>
    ${leaf(42, 150, 26, 13, -34, p.foliage, 0.5)}
    ${leaf(74, 118, 29, 14, -40, p.mid, 0.42)}
    ${leaf(104, 86, 25, 12, -46, p.foliage, 0.46)}
    ${leaf(70, 168, 24, 12, 16, p.mid, 0.36)}
    ${leaf(116, 140, 27, 13, -8, p.foliage, 0.38)}
    ${leaf(150, 108, 22, 11, -22, p.mid, 0.32)}
    ${leaf(28, 118, 20, 10, -62, p.foliage, 0.34)}
  </g>
</svg>`;
}

/**
 * The glyph inside a card's icon circle.
 *
 * THE REFERENCE PUTS A TOPICAL PICTOGRAM HERE - a document, a group of
 * people, a database - chosen by whoever made the slide. The storyboard does
 * not carry that choice: `icon` names a COLOUR role, not a subject, and
 * inferring a pictogram from the card's heading would be the tool inventing
 * meaning. So the circle carries the column's number, which is honest, reads
 * as deliberate, and matches the numbering language the deck already uses on
 * its agenda and divider pages.
 *
 * @param {number} n
 */
export function cardIconGlyph(n) {
  return `<span class="icon-num" data-deck-ignore>${String(n).padStart(2, '0')}</span>`;
}

/**
 * The lamp mark the reference sets beside a conclusion banner.
 * @param {string} colour
 */
export function footerMark(colour) {
  return `<svg class="footer-mark" width="46" height="46" viewBox="0 0 46 46" xmlns="http://www.w3.org/2000/svg"
     aria-hidden="true" focusable="false" data-deck-decorative data-deck-ignore>
  <g fill="none" stroke="${colour}" stroke-width="2.6" stroke-linecap="round">
    <path d="M23 9 a10 10 0 0 1 10 10 c0 5 -3.4 7.2 -4.6 9.6 l-10.8 0 C16.4 26.2 13 24 13 19 a10 10 0 0 1 10 -10 z"/>
    <path d="M19 33 l8 0"/>
    <path d="M20 37 l6 0"/>
    <path d="M23 3 l0 3.4 M38 11 l-2.6 2 M8 11 l2.6 2 M41 24 l-3.4 0 M5 24 l3.4 0"/>
  </g>
</svg>`;
}

/**
 * THE WASH INSIDE AN EMPTY COLUMN FRAME.
 *
 * A flat gradient in a 474x268 box reads as three blank rectangles, which is
 * not much better than the void it replaced. This is a small landscape in the
 * same language as the page's corner wash, varied per column so the three do
 * not look like a repeated tile. It is still obviously not a photograph - the
 * point is that the page looks composed while the illustrations are being
 * drawn, not that anyone is fooled.
 *
 * @param {any} theme
 * @param {number} n  1-based column index
 */
export function columnWash(theme, n, seed = 'default') {
  const p = palette(theme);
  const rand = rng(seedOf(`${seed}:${n}`));
  const id = uid(`cw${n}`, `${seed}:${n}`);
  const w = 474;
  const h = 268;
  // Each column gets its own horizon and ridge offsets.
  // Varied per column AND per slide: three identical pale rectangles on every
  // three-column page was the same "one slide repeated" problem in miniature.
  const lift = Math.round(rand() * 40 - 18);
  const shift = Math.round(rand() * 90 - 45);
  const tooth = Math.floor(rand() * 90) + 3;
  return `<svg class="card-art-wash" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" data-deck-decorative data-deck-ignore>
  <defs>
    ${washFilter(id, 2, tooth)}
    <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.far}" stop-opacity="0.26"/>
      <stop offset="1" stop-color="${p.far}" stop-opacity="0.05"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#${id}-sky)"/>
  <g filter="url(#${id}-soft)" opacity="0.3">
    <path fill="${p.far}" d="${ridge([[0, 150 + lift], [90 + shift, 96 + lift], [190, 128 + lift], [300 + shift, 72 + lift], [400, 118 + lift], [w, 86 + lift]], h, w)}"/>
  </g>
  <g filter="url(#${id}-wash)" opacity="0.38">
    <path fill="${p.mid}" d="${ridge([[0, 186 + lift], [86, 146 + lift], [180 + shift, 178 + lift], [286, 124 + lift], [392 + shift, 164 + lift], [w, 132 + lift]], h, w)}"/>
  </g>
  <g filter="url(#${id}-wash)" opacity="0.42">
    <path fill="${p.foliage}" d="${ridge([[0, 232 + lift], [78 + shift, 200 + lift], [172, 228 + lift], [268, 194 + lift], [370 + shift, 224 + lift], [w, 202 + lift]], h, w)}"/>
  </g>
  <g filter="url(#${id}-wash)" opacity="0.4" fill="${p.deep}">
    <path d="M${150 + shift},${236 + lift} l26,-20 26,20 z"/>
    <rect x="${162 + shift}" y="${236 + lift}" width="30" height="17" rx="2"/>
    <path d="M${262 + shift},${244 + lift} l30,-22 30,22 z"/>
    <rect x="${276 + shift}" y="${244 + lift}" width="34" height="15" rx="2"/>
  </g>
  <g filter="url(#${id}-soft)" opacity="0.45" fill="#FFFFFF">
    <ellipse cx="${210 + shift}" cy="${212 + lift}" rx="150" ry="16"/>
  </g>
</svg>`;
}
