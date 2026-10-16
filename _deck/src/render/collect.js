/**
 * The in-page geometry collector.
 *
 * This function is serialised and evaluated INSIDE Chrome by Playwright, so it
 * must be entirely self-contained: no imports, no closure over module scope.
 *
 * It is evaluated under the SAME media rules that produce the PDF. Chrome's
 * print path applies print media, and a layout measured under screen media is
 * not the layout that ships - so render.js emulates print media before calling
 * this, and the measurement and the export see one geometry.
 *
 * Everything is reported in canonical canvas pixels: coordinates relative to
 * the slide's own canvas element, divided by its rendered scale. A theme that
 * previews at 0.5x must still lint at authored size.
 *
 * ALL slides live in ONE document, each canvas its own printed page. That is
 * why this returns an array rather than a single slide: the geometry deck
 * lints and the PDF it ships then come from literally the same layout, so
 * "the geometry you lint is not the geometry you ship" cannot happen. The
 * per-slide files under out/html are standalone copies for inspection.
 *
 * @returns {{slides: object[], document: object}}
 */
export function collectGeometry() {
  const canvases = Array.from(document.querySelectorAll('[data-deck-canvas]'));
  if (canvases.length === 0) {
    return { slides: [], document: { error: 'no element carries data-deck-canvas; nothing can be measured' } };
  }
  return {
    document: {
      media: matchMedia('print').matches ? 'print' : 'screen',
      fonts_ready: document.fonts ? document.fonts.status : 'unknown',
      canvas_count: canvases.length,
    },
    slides: canvases.map(measureCanvas),
  };

  function measureCanvas(canvas) {
    const canvasRect = canvas.getBoundingClientRect();
    const authoredW = Number(canvas.getAttribute('data-deck-canvas-width'));
    const authoredH = Number(canvas.getAttribute('data-deck-canvas-height'));
    if (!authoredW || !authoredH) {
      return {
        slide_id: canvas.getAttribute('data-deck-slide-id'),
        error: 'data-deck-canvas-width/height are missing, so canvas pixels are undefined',
      };
    }
    const scale = canvasRect.width / authoredW;
    if (!(scale > 0)) {
      return {
        slide_id: canvas.getAttribute('data-deck-slide-id'),
        error: 'the canvas has zero width in this media; nothing can be measured',
      };
    }

    /** Convert a viewport rect into canonical canvas pixels. */
    function toCanvas(r) {
      if (!r) return null;
      return {
        x: (r.left - canvasRect.left) / scale,
        y: (r.top - canvasRect.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
      };
    }
    function withCentre(r) {
      if (!r) return null;
      return { ...r, cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
    }
    function unionRects(rects) {
      const live = rects.filter((r) => r && r.width > 0 && r.height > 0);
      if (live.length === 0) return null;
      let l = Infinity; let t = Infinity; let rr = -Infinity; let b = -Infinity;
      for (const r of live) {
        l = Math.min(l, r.left); t = Math.min(t, r.top);
        rr = Math.max(rr, r.right); b = Math.max(b, r.bottom);
      }
      return { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t };
    }

    /**
     * The union of the PAINTED LEAVES under this element - the ink, not the
     * wrapper and not an inner wrapper either.
     *
     * This is the measurement that catches "the box is centred but its
     * contents are not", and it has to RECURSE to do so. Measuring only
     * immediate children was a false pass in the headline rule: a centred
     * stack containing a full-width, left-aligned heading has a child box
     * exactly as wide as the stack, so the union equalled the wrapper, the
     * centres matched, and visibly left-aligned text passed. Any descendant
     * that is itself just a box gets opened; only text line boxes and
     * genuinely atomic leaves (images, canvases, empty painted boxes such as
     * rules and icon circles) contribute a rectangle.
     */
    function contentUnion(el) {
      const rects = [];
      collectInk(el, rects, 0);
      return unionRects(rects);
    }

    /**
     * Displays whose text sits in line boxes this element owns.
     *
     * An `inline` element's box is the union of the line boxes it happens to
     * span, not a container with a content edge, so the arithmetic below does
     * not apply to it and its rects are left alone.
     */
    const SNAPPABLE_DISPLAY = new Set([
      'block', 'flow-root', 'list-item', 'flex', 'grid',
      'inline-block', 'inline-flex', 'inline-grid', 'table-cell', 'table-caption',
    ]);

    /**
     * A function that snaps a text rect onto its line box, or null when this
     * element's geometry does not let us compute one.
     *
     * Returns null - leaving the font box untouched - for:
     *   - `line-height: normal` or any unparseable value: there is no slot
     *     height to snap to, and inventing one would move real ink;
     *   - a transformed element: the rects are in transformed coordinates and
     *     the slot arithmetic is in untransformed ones;
     *   - an inline element, per SNAPPABLE_DISPLAY above.
     *
     * In each of those the measurement falls back to the font box, which is
     * what this code did before and is wrong only by the font's asymmetry.
     */
    function lineBoxSnapperFor(el) {
      // AN INLINE ELEMENT DOES NOT OWN ITS LINE BOXES. Its block container
      // does, so the slot geometry comes from there.
      //
      // Measured without this: a <sup> inside a <p> was left unsnapped, its
      // raised font box pulled the union 4.17 px up, and a correctly centred
      // heading with a footnote marker read as displaced. <ruby>/<rt> did
      // the same in the other direction. Walking up to the block that owns
      // the line box fixes both, and is what CSS says the line box is.
      let owner = el;
      let guard = 0;
      while (owner && guard < 32) {
        const ocs = getComputedStyle(owner);
        if (ocs.transform && ocs.transform !== 'none') return null;
        if (SNAPPABLE_DISPLAY.has(ocs.display)) break;
        owner = owner.parentElement;
        guard += 1;
      }
      if (!owner || guard >= 32) return null;

      const cs = getComputedStyle(owner);
      if (cs.transform && cs.transform !== 'none') return null;
      if (!SNAPPABLE_DISPLAY.has(cs.display)) return null;
      const lineHeight = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return null;

      const box = owner.getBoundingClientRect();
      const borderTop = parseFloat(cs.borderTopWidth) || 0;
      const paddingTop = parseFloat(cs.paddingTop) || 0;
      const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
      const paddingBottom = parseFloat(cs.paddingBottom) || 0;
      const contentTop = box.top + borderTop + paddingTop;
      const contentHeight = box.height - borderTop - paddingTop - borderBottom - paddingBottom;

      // THE SLOT HEIGHT, from the laid-out box wherever the box is trustworthy.
      //
      // Three cases, and getting the third wrong is what hid the push:
      //
      //  1. The content box holds a whole number of line-heights - ordinary
      //     flow. Dividing it by that number gives the real slot height and
      //     avoids the computed value's rounding: Chrome lays out a computed
      //     `line-height: 109.2` as 109.1875, and using 109.2 moved a
      //     perfectly centred heading 0.00625 px, right onto the tolerance
      //     boundary.
      //
      //  2. The content box is TALLER than line-height but not a multiple of
      //     it - a taller inline on the line, such as a bigger <span>, a
      //     <sup> or <ruby>. The real line box is taller than line-height,
      //     and the content box describes it better than the computed value
      //     does. Measured: forcing line-height here instead shrank a
      //     mixed-size line from 72 px to 48 px and reported a correctly
      //     centred paragraph as 12 px out - a false FAILURE traded for the
      //     false pass, which is not a trade worth making.
      //
      //  3. The content box is SHORTER than one line - a height set
      //     independently of the text. This is the case that hides a push,
      //     so the computed line-height is the honest slot height and the
      //     overflow past the box is kept.
      const lineCount = Math.max(1, Math.round(contentHeight / lineHeight));
      const fitsWholeLines = Math.abs(contentHeight - lineCount * lineHeight) < 1;
      let slotHeight;
      if (fitsWholeLines) {
        slotHeight = contentHeight / lineCount;
      } else if (contentHeight >= lineHeight) {
        slotHeight = contentHeight / Math.max(1, Math.floor(contentHeight / lineHeight));
      } else {
        slotHeight = lineHeight;
      }

      return (r) => {
        // Pick the slot by the rect's CENTRE rather than its top: the font
        // box overhangs its slot, so its top can fall inside the slot above.
        const index = Math.round(((r.top + r.height / 2) - contentTop) / slotHeight - 0.5);
        const top = contentTop + index * slotHeight;
        return {
          left: r.left,
          top,
          right: r.right,
          bottom: top + slotHeight,
          width: r.width,
          height: slotHeight,
        };
      };
    }

    /** Atomic painted things: they have no inner content to descend into. */
    const ATOMIC = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'HR', 'BR']);

    /**
     * @param {Element} el
     * @param {DOMRect[]} out
     * @param {number} depth guards against a pathological DOM; 64 is far
     *   deeper than any slide template and keeps this from ever hanging.
     */
    function collectInk(el, out, depth) {
      if (depth > 64) {
        out.push(el.getBoundingClientRect());
        return;
      }
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!node.nodeValue || !node.nodeValue.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const snapToLineBox = lineBoxSnapperFor(el);
          for (const r of Array.from(range.getClientRects())) {
            // A TEXT RECT IS SNAPPED TO ITS LINE BOX.
            //
            // getClientRects returns the FONT box - ascent plus descent -
            // which is not symmetric about the line box the author laid out.
            // Measured on Noto Sans JP at 56 px with line-height 76.72: the
            // font box is 81 px tall and sits 1.0 px BELOW the box top and
            // 5.28 px below its bottom. Using it raw makes a perfectly
            // centred heading read 0.86 px off; using a per-side allowance
            // against the total leading lets a real push hide inside that
            // allowance, and a 3 px `padding-top` on a fixed-height heading
            // moved the painted text 2.14 px while the rule reported 0.00.
            //
            // Neither font metric can tell "this side overhangs because of
            // leading" from "this side overhangs because the content was
            // pushed". The element's own geometry can: a line box is at
            // contentTop + i x line-height and is exactly line-height tall,
            // and padding moves contentTop. So each rect is snapped onto the
            // slot it belongs to, which removes the font's asymmetry
            // completely while keeping every displacement the author caused.
            //
            // Horizontally nothing is touched: a run wider than its box is
            // painted at that width.
            const snapped = snapToLineBox ? snapToLineBox(r) : r;
            if (snapped.right > snapped.left && snapped.bottom > snapped.top) out.push(snapped);
          }
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const cs = getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (Number(cs.opacity) === 0) continue;
        if (node.hasAttribute('data-deck-ignore')) continue;

        if (ATOMIC.has(node.tagName)) {
          out.push(node.getBoundingClientRect());
          continue;
        }
        // A descendant that paints a background, a border or a shadow is ink
        // in its own right - an icon circle or a rule is an empty div - so its
        // own box counts AND its children are still descended into.
        if (paintsItself(cs)) out.push(node.getBoundingClientRect());

        const before = out.length;
        collectInk(node, out, depth + 1);
        // A box with no ink under it at all still occupies space the author
        // placed, so fall back to its own rectangle rather than vanishing.
        if (out.length === before && !paintsItself(cs)) {
          const r = node.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) out.push(r);
        }
      }
    }

    /** Does this element paint anything of its own? */
    function paintsItself(cs) {
      const bg = parseColour(cs.backgroundColor);
      if (bg && bg.a > 0) return true;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
      if (cs.boxShadow && cs.boxShadow !== 'none') return true;
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (cs[`border${side}Style`] !== 'none' && parseFloat(cs[`border${side}Width`]) > 0) return true;
      }
      return false;
    }

    /**
     * Does this element draw text of its own, as opposed to containing
     * elements that do?
     *
     * Type size and contrast are properties of DRAWN TEXT. A wrapper inherits
     * a font size it never paints with, and reporting against it produces the
     * same finding once per nesting level plus one bogus one for the wrapper.
     */
    function hasOwnText(el) {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue && node.nodeValue.trim()) return true;
      }
      return false;
    }

    /**
     * EVERY TEXT LINE BOX, WITH THE TEXT THAT IS ACTUALLY ON THAT LINE.
     *
     * The per-line text is the point. This used to stamp the WHOLE text
     * node's value onto every one of its line boxes, so a subtitle that wrapped
     * to four lines reported the same 80 characters four times. Two things
     * were impossible while that was true:
     *
     *   - a finding could not say WHICH characters had fallen off the page.
     *     It quoted the whole string whether one line was lost or all four.
     *   - nothing could answer the question this tool exists to answer: are
     *     all of the PO's words on the delivered page? That needs the text of
     *     the lines that are INSIDE the canvas, which nothing had.
     *
     * So each character is measured and assigned to the line box it landed
     * in. DOM offsets are UTF-16 code units, so a surrogate pair is advanced
     * over as one step - splitting one would produce a lone surrogate and a
     * garbled quotation, which on a Japanese deck is the exact failure mode
     * the whole verbatim chain exists to prevent.
     *
     * Characters whose own rect is empty - a space that collapsed at a line
     * break - go to the line their predecessor is on, so no character is
     * dropped from the reconstruction.
     *
     * COST: one getBoundingClientRect per character, and nothing here mutates
     * the DOM, so Chrome serves them all from one layout. Measured on the
     * heaviest stress page (a 14x6 table, ~2000 characters) it is not a
     * visible part of the render.
     */
    function textLines(el) {
      const out = [];
      // NO CALLBACK FILTER. The page runs with javaScriptEnabled:false, and a
      // TreeWalker whose filter is a JS function cannot call it there - it
      // throws "The provided callback is no longer runnable". The walker is
      // created with the bare SHOW_TEXT bitmask and the filtering is done in
      // this loop, which runs in the evaluate context rather than the page's.
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      while (n) {
        if (n.nodeValue && n.nodeValue.trim()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          const boxes = Array.from(range.getClientRects())
            .filter((r) => r.width > 0 || r.height > 0);
          const texts = boxes.map(() => '');
          const value = n.nodeValue;
          let lastLine = 0;
          for (let i = 0; i < value.length;) {
            // One STEP per code point: a surrogate pair is two UTF-16 units
            // and must be selected as one, or the slice is half a character.
            const code = value.codePointAt(i);
            const step = code > 0xffff ? 2 : 1;
            const charRange = document.createRange();
            charRange.setStart(n, i);
            charRange.setEnd(n, i + step);
            const cr = charRange.getBoundingClientRect();
            let line = lastLine;
            if (cr.width > 0 || cr.height > 0) {
              const mid = cr.top + cr.height / 2;
              let best = -1;
              let bestDistance = Infinity;
              for (let b = 0; b < boxes.length; b += 1) {
                const box = boxes[b];
                if (mid >= box.top && mid <= box.bottom) { best = b; break; }
                const d = Math.min(Math.abs(mid - box.top), Math.abs(mid - box.bottom));
                if (d < bestDistance) { bestDistance = d; best = b; }
              }
              if (best >= 0) { line = best; lastLine = best; }
            }
            if (texts[line] !== undefined) texts[line] += value.slice(i, i + step);
            i += step;
          }
          boxes.forEach((r, i) => {
            out.push({ ...withCentre(toCanvas(r)), text: texts[i].trim() });
          });
        }
        n = walker.nextNode();
      }
      return out;
    }

    /**
     * Does this element paint a surface of its own?
     *
     * Its OWN background only - not an ancestor's, which is what
     * backingColour composites. An element with a transparent background
     * paints nothing and hides nothing, however opaque the page behind it is.
     */
    function paintsBackground(el) {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
      const c = parseColour(cs.backgroundColor);
      return Boolean(c && c.a > 0);
    }

    /**
     * Resolve the colour actually BEHIND the element by compositing every
     * ancestor background over white, rather than reading the nearest
     * background-color property. `background: transparent` on the element with a
     * navy parent is the case that makes the naive read wrong.
     *
     * Returns `textured: true` when an ancestor paints an image or gradient,
     * because then no single colour is the answer and the contrast rule must say
     * so instead of guessing.
     */
    function backingColour(el) {
      const layers = [];
      const stack = [];
      let textured = false;
      // AN OPAQUE BACKGROUND HIDES THE COLOURS BEHIND IT. IT DOES NOT CANCEL
      // THE OPACITY OF THE GROUPS AROUND IT.
      //
      // The walk used to stop at the first opaque background, so an opaque
      // black child inside a parent at `opacity: 0.4` reported its backing as
      // pure black and white text on it as 21:1, where compositing the whole
      // stack gives about 2.7:1 - the group fades the black to mid grey and
      // the text with it. Once an opaque colour is found, later backgrounds
      // contribute nothing and are recorded as null, but the walk continues
      // to the root collecting every `opacity`.
      let opaqueReached = false;
      let node = el;
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        if (!opaqueReached && cs.backgroundImage && cs.backgroundImage !== 'none') {
          textured = true;
          layers.push({ kind: 'image', value: cs.backgroundImage.slice(0, 120), element: describe(node) });
        }
        const c = opaqueReached ? null : parseColour(cs.backgroundColor);
        if (c && c.a > 0) layers.push({ kind: 'colour', rgba: c, element: describe(node) });

        // THE LAYER STACK, innermost first.
        //
        // An `opacity` BELOW 1 is a layer boundary, and that is the whole
        // reason this is a stack rather than a single colour. A group that
        // paints a black background at opacity .4 over a white page shows
        // #999999 beside its text, while the white text inside it - which
        // COVERS that black within the layer - shows as white. Multiplying
        // the text's alpha by the group's opacity and compositing it over
        // black gets both of those wrong: it reported a high contrast for
        // white-on-black when the reader sees white on mid grey, about
        // 2.7:1. The contrast rule replays this stack for the foreground and
        // the background separately.
        const opacity = Number(cs.opacity);
        stack.push({
          element: describe(node),
          background: c && c.a > 0 ? c : null,
          opacity: Number.isFinite(opacity) ? opacity : 1,
          textured: Boolean(cs.backgroundImage && cs.backgroundImage !== 'none'),
        });

        if (c && c.a >= 1 && !textured) opaqueReached = true;
        node = node.parentElement;
      }

      // The BACKGROUND pixel beside the text: the stack with no foreground.
      const composited = flattenStack(stack, null);

      return {
        textured,
        composited,
        stack,
        layers: layers.slice(0, 6),
      };
    }

    /**
     * Composite a layer stack over opaque white.
     *
     * Premultiplied source-over, accumulating from the innermost layer
     * outward, with each element's `opacity` applied to everything
     * accumulated so far at the moment that element's layer closes.
     *
     * @param {{background: object | null, opacity: number}[]} stack innermost first
     * @param {{r: number, g: number, b: number, a: number} | null} foreground
     *   painted on top of everything inside the innermost layer
     */
    function flattenStack(stack, foreground) {
      // Premultiplied accumulator.
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
          // accum OVER bg
          const keep = 1 - aa;
          ar += bg.r * bg.a * keep;
          ag += bg.g * bg.a * keep;
          ab += bg.b * bg.a * keep;
          aa += bg.a * keep;
        }
        const o = entry.opacity;
        if (o < 1) {
          ar *= o;
          ag *= o;
          ab *= o;
          aa *= o;
        }
      }
      // Finally over the opaque white page.
      const keep = 1 - aa;
      return {
        r: Math.round(ar + 255 * keep),
        g: Math.round(ag + 255 * keep),
        b: Math.round(ab + 255 * keep),
      };
    }

    function parseColour(value) {
      if (!value) return null;
      const text = String(value).trim();
      const rgb = text.match(/^rgba?\(([^)]+)\)$/);
      if (rgb) {
        const parts = rgb[1].split(/[,/]/).map((s) => parseFloat(s.trim()));
        if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      }
      // THE MODERN color() SYNTAX. Chrome returns `color(srgb r g b / a)` with
      // components in 0..1 for anything computed through color-mix(), which
      // is how a theme expresses "this teal at 26%". The parser only knew
      // rgb(), so every such colour came back unparseable and the contrast
      // rule reported UNSUPPORTED - four blocking findings on a real deck for
      // a colour the browser had resolved perfectly well.
      const fn = text.match(/^color\(\s*srgb\s+([^)]+)\)$/i);
      if (fn) {
        const parts = fn[1].split(/[\s/]+/).filter(Boolean).map((x) => parseFloat(x));
        if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
        const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
        return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a };
      }
      return null;
    }

    /**
     * The product of every `opacity` from this element up to the canvas.
     *
     * A group set to opacity .15 fades its text exactly as a translucent text
     * colour would, and the contrast rule has to see it. CSS opacity composites
     * the whole subtree, so the factors multiply.
     */
    function effectiveOpacity(el) {
      let o = 1;
      let node = el;
      while (node && node !== document.documentElement) {
        const v = Number(getComputedStyle(node).opacity);
        if (Number.isFinite(v)) o *= v;
        node = node.parentElement;
      }
      return o;
    }

    function describe(el) {
      const id = el.getAttribute && el.getAttribute('data-deck-id');
      if (id) return `#${id}`;
      return `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(/\s+/).join('.')}` : ''}`;
    }

    /** The chain of ancestors that could clip this element. */
    function clippingAncestors(el) {
      const out = [];
      let node = el.parentElement;
      while (node && node !== document.documentElement) {
        const cs = getComputedStyle(node);
        const clips = ['hidden', 'clip', 'scroll', 'auto'].includes(cs.overflowX)
          || ['hidden', 'clip', 'scroll', 'auto'].includes(cs.overflowY)
          || (cs.clipPath && cs.clipPath !== 'none');
        if (clips) {
          out.push({
            element: describe(node),
            deck_id: node.getAttribute('data-deck-id') || null,
            overflow_x: cs.overflowX,
            overflow_y: cs.overflowY,
            clip_path: cs.clipPath && cs.clipPath !== 'none' ? cs.clipPath : null,
            rect: withCentre(toCanvas(node.getBoundingClientRect())),
          });
        }
        node = node.parentElement;
      }
      return out;
    }

    /**
     * The deck ids of every ancestor, nearest first.
     *
     * The collision rule used to treat geometric containment as nesting, so
     * two unrelated elements sharing a rectangle - or one accidentally
     * covering another completely - were exempt, which is precisely backwards:
     * total overlap is the worst collision there is. Real ancestry is a DOM
     * fact and belongs here, not in a guess made from rectangles.
     */
    function ancestry(el) {
      const out = [];
      let node = el.parentElement;
      while (node && node !== document.documentElement) {
        const id = node.getAttribute('data-deck-id');
        if (id) out.push(id);
        node = node.parentElement;
      }
      return out;
    }

    /** The element's own zone, or the nearest ancestor's. */
    function zoneOf(el) {
      const owner = el.closest('[data-deck-zone]');
      return owner ? owner.getAttribute('data-deck-zone') : null;
    }

    function parseJsonAttr(el, name) {
      const raw = el.getAttribute(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return { __parse_error: String(e.message), __raw: raw.slice(0, 200) };
      }
    }

    // --- named reference regions -------------------------------------------
    //
    // A placement contract names its reference region rather than implying one,
    // because the design kit's margins are vertically asymmetric: the canvas
    // centre and the safe-content centre are DIFFERENT y values. Guessing would
    // pass a wrongly-centred title half the time.
    const regions = {
      canvas: withCentre({ x: 0, y: 0, w: authoredW, h: authoredH }),
    };
    for (const el of Array.from(canvas.querySelectorAll('[data-deck-region]'))) {
      regions[el.getAttribute('data-deck-region')] = withCentre(toCanvas(el.getBoundingClientRect()));
    }
    for (const el of Array.from(canvas.querySelectorAll('[data-deck-slot]'))) {
      regions[`slot:${el.getAttribute('data-deck-slot')}`] = withCentre(toCanvas(el.getBoundingClientRect()));
    }

    // --- elements ----------------------------------------------------------
    const elements = [];
    for (const el of Array.from(canvas.querySelectorAll('[data-deck-id]'))) {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const union = contentUnion(el);
      const lines = textLines(el);
      const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
      elements.push({
        id: el.getAttribute('data-deck-id'),
        role: el.getAttribute('data-deck-role') || null,
        group: el.getAttribute('data-deck-group') || null,
        decorative: el.hasAttribute('data-deck-decorative'),
        background_of: el.getAttribute('data-deck-background-of') || null,
        anchor: el.getAttribute('data-deck-anchor') || null,
        // A zone is INHERITED. The theme declares `bleed` on a slot
        // container; the <img> inside it is in the same zone and should not
        // have to repeat the attribute, or forgetting it would report the
        // image as body content breaking three margins.
        zone: zoneOf(el),
        slot: el.getAttribute('data-deck-slot') || null,
        // filled | empty | reuse, written by the renderer, which is the only
        // thing that knows whether it put an image in the box.
        slot_state: el.getAttribute('data-deck-slot-state') || null,
        placement: parseJsonAttr(el, 'data-deck-placement'),
        proximity: parseJsonAttr(el, 'data-deck-proximity'),
        visible,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim(),
        own_text: hasOwnText(el),
        ancestry: ancestry(el),
        rect: withCentre(toCanvas(box)),
        content_union: withCentre(toCanvas(union && {
          left: union.left, top: union.top, width: union.width, height: union.height,
        })),
        text_lines: lines,
        overflow: {
          // scrollWidth/Height are integers, so a sub-pixel difference is not
          // overflow. The +1 tolerance below lives in the rule, not here.
          scroll_w: el.scrollWidth,
          scroll_h: el.scrollHeight,
          client_w: el.clientWidth,
          client_h: el.clientHeight,
          overflow_x: cs.overflowX,
          overflow_y: cs.overflowY,
          text_overflow: cs.textOverflow,
          line_clamp: cs.webkitLineClamp || 'none',
          white_space: cs.whiteSpace,
        },
        style: {
          font_family: cs.fontFamily,
          font_size_px: parseFloat(cs.fontSize),
          font_weight: cs.fontWeight,
          line_height: cs.lineHeight,
          color: cs.color,
          background_color: cs.backgroundColor,
          display: cs.display,
          position: cs.position,
          transform: cs.transform,
          opacity: cs.opacity,
          letter_spacing: cs.letterSpacing,
          text_align: cs.textAlign,
        },
        // DOES THIS ELEMENT PAINT A SURFACE OF ITS OWN?
        //
        // A box that paints covers what is under it across its WHOLE rect,
        // not just where its own text is. The footer banner is 1672x92 px of
        // painted wash whose text ink is 722x62, and a table row that ran
        // down into it was completely hidden while `collision` reported
        // nothing - it was comparing ink with ink, and there was no ink in
        // the part of the band doing the hiding. The collision rule uses this
        // to widen a painting element to its painted box.
        //
        // A gradient counts. The footer banner's wash IS a gradient, and a
        // check that only looked at background-color would have read alpha 0
        // and missed the exact element this was written for.
        paints_background: paintsBackground(el),
        backing: backingColour(el),
        // Reported separately from `style.color` so the contrast rule can
        // composite the text's own alpha and the inherited opacity against the
        // backing instead of over an assumed white.
        effective_opacity: effectiveOpacity(el),
        color_alpha: (parseColour(cs.color) || { a: 1 }).a,
        clipping_ancestors: clippingAncestors(el),
      });
    }

    // --- images -------------------------------------------------------------
    const images = Array.from(canvas.querySelectorAll('img')).map((img) => ({
      deck_id: img.getAttribute('data-deck-id') || null,
      slot: img.closest('[data-deck-slot]') ? img.closest('[data-deck-slot]').getAttribute('data-deck-slot') : null,
      src: img.getAttribute('src'),
      complete: img.complete,
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      rect: withCentre(toCanvas(img.getBoundingClientRect())),
      object_fit: getComputedStyle(img).objectFit,
    }));

    return {
      slide_id: canvas.getAttribute('data-deck-slide-id'),
      page_type: canvas.getAttribute('data-deck-page-type'),
      variant: canvas.getAttribute('data-deck-variant') || null,
      canvas: { authored_w: authoredW, authored_h: authoredH, rendered_scale: scale },
      media: matchMedia('print').matches ? 'print' : 'screen',
      fonts_ready: document.fonts ? document.fonts.status : 'unknown',
      regions,
      elements,
      images,
    };
  }
}
