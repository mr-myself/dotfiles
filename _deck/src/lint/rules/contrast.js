import { box, finding } from '../finding.js';

/**
 * Text below this alpha paints nothing. Must match PAINT_ALPHA_FLOOR in
 * lint/rules/content-integrity.js, which owns that case.
 */
const PAINT_ALPHA_FLOOR = 0.004;

/**
 * CONTRAST, against the ACTUAL composited backing colour.
 *
 * Reading the nearest `background-color` is the naive implementation and it is
 * wrong in the common case: a heading with `background: transparent` inside a
 * navy band has a CSS background of rgba(0,0,0,0), which composites to white
 * and scores a beautiful, entirely fictional contrast ratio. The collector
 * therefore walks the ancestors and composites every layer onto opaque white,
 * and this rule consumes that.
 *
 * FOREGROUND ALPHA AND OPACITY ARE COMPOSITED TOO. Translucent text used to
 * be flattened against white no matter what was actually behind it, so
 * rgba(255,255,255,0.1) over black - an effective 1.20:1, invisible - scored
 * as pure white on white-ish and produced no finding at all. The text colour's
 * own alpha and the product of every ancestor `opacity` are now composited
 * against the RESOLVED BACKING, which is the only order that gives the colour
 * a reader actually sees.
 *
 * Where that cannot be done honestly, it says so:
 *
 *   over a gradient or an image backing, no single colour IS the answer. The
 *   case is reported as `unsupported` - which is a BLOCKING severity - rather
 *   than passed. A theme may declare `contrast_backing` on the element to
 *   assert the effective colour behind it, and then the check runs against
 *   that declared value and names it in the report, so the assertion is
 *   visible rather than hidden.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function contrastRule({ slides, theme }) {
  const findings = [];
  const normalMin = theme?.lint?.contrast_min ?? 4.5;
  const largeMin = theme?.lint?.contrast_min_large ?? 3.0;
  /** @type {Record<string, number>} */
  const exceptions = theme?.lint?.contrast_exceptions || {};

  for (const slide of slides) {
    for (const el of slide.elements) {
      if (!el.visible || !el.text) continue;
      // Only elements that actually PAINT their own text. `text_lines` walks
      // the whole subtree, so it is true of wrappers too; `own_text` is the
      // one that means "this element has a text node of its own". Without it
      // an inherited colour is reported once per nesting level.
      if (!el.own_text || el.text_lines.length === 0) continue;
      // A DECORATIVE MARK IS NOT TEXT TO READ. The chapter numeral behind a
      // divider title is a watermark: it is deliberately pale, nobody is
      // meant to read it, and requiring 4.5:1 of it would mean the theme
      // could not express the reference's most recognisable page. Declaring
      // it decorative in the DOM is the author saying so, and it is the same
      // declaration the collision rule already honours.
      if (el.decorative) continue;

      const fgRaw = parseColourWithAlpha(el.style.color);
      if (!fgRaw) {
        findings.push(finding({
          rule: 'contrast',
          severity: 'unsupported',
          slide: slide.slide_id,
          element: el.id,
          message: `${el.id} has a text colour deck cannot parse ("${el.style.color}"), so its contrast cannot be verified`,
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
        continue;
      }

      const declared = el.placement && el.placement.contrast_backing;
      let backing;
      let backingNote;
      if (declared) {
        backing = parseHex(declared);
        backingNote = `declared by the component as ${declared}`;
        if (!backing) {
          findings.push(finding({
            rule: 'contrast',
            severity: 'unsupported',
            slide: slide.slide_id,
            element: el.id,
            message: `${el.id} declares contrast_backing "${declared}", which is not a hex colour deck can use`,
            boxes: [box(el.rect, el.id)].filter(Boolean),
          }));
          continue;
        }
      } else if (el.backing.textured) {
        findings.push(finding({
          rule: 'contrast',
          severity: 'unsupported',
          slide: slide.slide_id,
          element: el.id,
          message: `${el.id} sits over a textured or image backing (${el.backing.layers.filter((l) => l.kind === 'image').map((l) => `${l.element}: ${l.value}`).join('; ')}), so no single backing colour exists. deck will not guess: either declare contrast_backing on the component, or move the text off the image.`,
          expected: { contrast_min: normalMin, how_to_resolve: 'declare contrast_backing, or do not set text over an image' },
          measured: { color: el.style.color, backing_layers: el.backing.layers },
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
        continue;
      } else {
        backing = el.backing.composited;
        backingNote = `composited from ${el.backing.layers.length} background layer(s)`;
      }

      // THE FOREGROUND AND THE BACKGROUND ARE COMPOSITED THROUGH THE SAME
      // LAYER STACK, separately.
      //
      // Multiplying the text's alpha by the inherited opacity and
      // compositing it over the already-flattened backing double-counts the
      // background the text COVERS inside its own layer. Measured: white
      // text in a black group at opacity .4 over a white page is really
      // white on #999999, about 2.7:1 - under the large-text minimum - while
      // the old model compared #666666 against black and reported nothing.
      //
      // Replaying the stack is the only model that gets both pixels right.
      const opacity = el.effective_opacity === undefined ? 1 : el.effective_opacity;
      const alpha = clamp01(fgRaw.a * opacity);
      // TEXT THAT PAINTS NOTHING IS THE CONTENT-INTEGRITY RULE'S, NOT THIS
      // ONE'S - and that is a decision, not an assumption.
      //
      // Both rules used to skip zero-alpha text, each taking it that the
      // other had it covered, so `color: transparent` on a required title
      // passed all ten rules. The split is now written down in both places:
      // below this floor nothing is drawn and content-integrity fails it for
      // being absent; above it, this rule composites it and fails it on the
      // ratio. Reporting a 1.00:1 ratio for invisible text would be a true
      // number and a useless one - "it is not there" is the finding the
      // author needs.
      //
      // The floor matches PAINT_ALPHA_FLOOR in content-integrity.js. If one
      // moves, move the other: a gap between them is exactly the hole this
      // closed.
      if (alpha <= PAINT_ALPHA_FLOOR) continue;

      let fg;
      if (declared || !Array.isArray(el.backing.stack) || el.backing.stack.length === 0) {
        // A declared backing, or geometry from a deck version that did not
        // record a stack: fall back to the flat model, which is right
        // whenever no ancestor is translucent.
        fg = compositeOver(fgRaw, backing, alpha);
      } else {
        fg = flattenStack(el.backing.stack, fgRaw);
      }

      const ratio = contrastRatio(fg, backing);
      const large = isLargeText(el.style.font_size_px, el.style.font_weight);
      const key = el.role || el.id;
      const required = exceptions[key] ?? (large ? largeMin : normalMin);
      const isException = Object.prototype.hasOwnProperty.call(exceptions, key);

      if (ratio + 0.005 >= required) {
        // A DECLARED EXCEPTION IS REPORTED EVERY RUN, not only when it fails.
        //
        // The PO's decision was that the design kit's pale agenda grey stays
        // as designed - inactive items are meant to recede - and that the
        // relaxation is recorded explicitly rather than the colour being
        // quietly darkened. An exception that only surfaced on failure would
        // be, in practice, silent: it never fails, so nobody would ever read
        // it. So it is emitted as a suggestion, which appears in the report
        // and in `deck doctor` without failing the gate.
        if (isException && ratio < normalMin) {
          findings.push(finding({
            rule: 'contrast',
            severity: 'suggestion',
            slide: slide.slide_id,
            element: el.id,
            message: `THEME EXCEPTION IN USE: ${el.id} (role "${key}") has contrast ${ratio.toFixed(2)}:1, under the ${normalMin}:1 default. It passes only because the theme declares an exception at ${required}:1. Reason: ${theme?.lint?.exception_notes?.[key] || '(no reason recorded - deck validate refuses an undocumented exception)'}`,
            expected: { default_contrast_min: normalMin, exception_allows: required },
            measured: {
              ratio: Math.round(ratio * 100) / 100,
              color: `#${hex(fg)}`,
              backing: `#${hex(backing)}`,
              role: key,
              text: el.text.slice(0, 60),
            },
            boxes: [],
          }));
        }
        continue;
      }
      findings.push(finding({
        rule: 'contrast',
        slide: slide.slide_id,
        element: el.id,
        message: `${el.id} has contrast ${ratio.toFixed(2)}:1 against its backing #${hex(backing)}, below the required ${required}:1${isException ? ` (theme exception for "${key}")` : large ? ' (large text, so 3:1 applies)' : ''}${alpha < 0.999 ? `. Its effective alpha is ${alpha.toFixed(3)} (text alpha ${fgRaw.a}, inherited opacity ${opacity.toFixed(3)}), so the colour a reader sees is #${hex(fg)}, not #${hex(fgRaw)}` : ''}`,
        expected: { contrast_min: required, large_text: large, theme_exception: isException ? key : null },
        measured: {
          ratio: Math.round(ratio * 100) / 100,
          color: `#${hex(fg)}`,
          declared_color: el.style.color,
          text_alpha: fgRaw.a,
          inherited_opacity: Math.round(opacity * 1000) / 1000,
          effective_alpha: Math.round(alpha * 1000) / 1000,
          backing: `#${hex(backing)}`,
          backing_source: backingNote,
          font_size_px: el.style.font_size_px,
          font_weight: el.style.font_weight,
          text: el.text.slice(0, 60),
        },
        boxes: [box(el.rect, el.id)].filter(Boolean),
      }));
    }
  }
  return findings;
}

/**
 * WCAG "large text": 18pt (24px) regular, or 14pt (18.66px) bold.
 * @param {number} px @param {string} weight
 */
export function isLargeText(px, weight) {
  const w = Number(weight);
  const bold = Number.isFinite(w) ? w >= 700 : weight === 'bold' || weight === 'bolder';
  if (bold) return px >= 18.66;
  return px >= 24;
}

/** @param {{r:number,g:number,b:number}} a @param {{r:number,g:number,b:number}} b */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** @param {{r:number,g:number,b:number}} c */
export function relativeLuminance({ r, g, b }) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Composite a layer stack over opaque white, with an optional foreground
 * painted on top of everything inside the innermost layer.
 *
 * The same arithmetic the collector uses for the background pixel, applied
 * here to the text pixel. Kept in the rule as well so it is unit-testable
 * without a browser.
 *
 * @param {{background: object | null, opacity: number}[]} stack innermost first
 * @param {{r:number,g:number,b:number,a:number} | null} foreground
 */
export function flattenStack(stack, foreground) {
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let aa = 0;
  if (foreground && foreground.a > 0) {
    ar = foreground.r * foreground.a;
    ag = foreground.g * foreground.a;
    ab = foreground.b * foreground.a;
    aa = foreground.a;
  }
  for (const entry of stack) {
    const bg = entry.background;
    if (bg && bg.a > 0) {
      const keep = 1 - aa;
      ar += bg.r * bg.a * keep;
      ag += bg.g * bg.a * keep;
      ab += bg.b * bg.a * keep;
      aa += bg.a * keep;
    }
    const o = entry.opacity === undefined ? 1 : entry.opacity;
    if (o < 1) {
      ar *= o;
      ag *= o;
      ab *= o;
      aa *= o;
    }
  }
  const keep = 1 - aa;
  return {
    r: Math.round(ar + 255 * keep),
    g: Math.round(ag + 255 * keep),
    b: Math.round(ab + 255 * keep),
  };
}

/**
 * Composite a foreground over a backing at the given alpha.
 * @param {{r:number,g:number,b:number}} fg
 * @param {{r:number,g:number,b:number}} bg
 * @param {number} alpha
 */
export function compositeOver(fg, bg, alpha) {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

/**
 * Parse a colour KEEPING its alpha, rather than flattening it over white.
 *
 * Keeping the alpha is the point: a colour flattened over white before the
 * backing is known cannot be composited correctly afterwards, and that was
 * the bug - rgba(255,255,255,0.1) over black scored as near-white.
 *
 * @param {string} value
 * @returns {{r:number,g:number,b:number,a:number} | null}
 */
export function parseColourWithAlpha(value) {
  if (!value) return null;
  const m = String(value).match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/]/).map((x) => parseFloat(x.trim()));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? clamp01(parts[3]) : 1 };
  }
  // THE MODERN color() SYNTAX, which Chrome returns for anything computed
  // through color-mix(). Components are 0..1, not 0..255.
  //
  // Without this a theme that says "this teal at 26%" - the ordinary way to
  // express a watermark - produced `color(srgb 0.058 0.541 0.603 / 0.26)`,
  // which the rule could not read and therefore reported as UNSUPPORTED: four
  // blocking findings for a colour the browser had already resolved.
  const fn = String(value).trim().match(/^color\(\s*srgb\s+([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(/[\s/]+/).filter(Boolean).map((x) => parseFloat(x));
    if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
    return {
      r: clamp01(parts[0]) * 255,
      g: clamp01(parts[1]) * 255,
      b: clamp01(parts[2]) * 255,
      a: parts.length > 3 && Number.isFinite(parts[3]) ? clamp01(parts[3]) : 1,
    };
  }
  const hexed = parseHex(value);
  return hexed ? { ...hexed, a: 1 } : null;
}

/** @param {string} value */
export function parseHex(value) {
  const m = String(value).trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function hex({ r, g, b }) {
  const p = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `${p(r)}${p(g)}${p(b)}`;
}

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect'],
  numbers: ['effective_opacity?', 'color_alpha?'],
  nested: { style: ['font_size_px'] },
  backing: true,
  textLines: true,
};
