import { box, finding } from '../finding.js';

/**
 * OVERFLOW / CLIPPING.
 *
 * Three different ways text disappears, and all three have to be caught:
 *
 *   1. the element's own scroll box is bigger than its client box - content
 *      that exists but is not shown;
 *   2. a text line box sticks out past a clipping ancestor, or past the canvas
 *      entirely (off-canvas text renders as nothing at all in the PDF);
 *   3. an ellipsis or a line clamp is active - Chrome renders "…" and the
 *      author's sentence is gone.
 *
 * scrollWidth/scrollHeight are integers, so sub-pixel layout noise would make
 * a bare `scroll > client` comparison fire constantly. One pixel of slack is
 * the smallest value that is quiet on correct layout; anything real overflows
 * by much more than that.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} ctx.theme
 * @returns {import('../finding.js').Finding[]}
 */
export function overflowRule({ slides }) {
  const findings = [];
  const SLACK = 1;

  for (const slide of slides) {
    const canvas = slide.regions.canvas;
    for (const el of slide.elements) {
      if (!el.visible) continue;
      const o = el.overflow;

      const clipsX = ['hidden', 'clip', 'scroll', 'auto'].includes(o.overflow_x);
      const clipsY = ['hidden', 'clip', 'scroll', 'auto'].includes(o.overflow_y);

      if (clipsX && o.scroll_w - o.client_w > SLACK) {
        findings.push(finding({
          rule: 'overflow',
          slide: slide.slide_id,
          element: el.id,
          axis: 'x',
          message: `${el.id} is ${o.scroll_w - o.client_w} px wider than its box and overflow-x is "${o.overflow_x}", so that content is not rendered`,
          expected: { scroll_w: `<= ${o.client_w + SLACK}`, overflow_x: o.overflow_x },
          measured: { scroll_w: o.scroll_w, client_w: o.client_w, text: el.text.slice(0, 120) },
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
      }
      if (clipsY && o.scroll_h - o.client_h > SLACK) {
        findings.push(finding({
          rule: 'overflow',
          slide: slide.slide_id,
          element: el.id,
          axis: 'y',
          message: `${el.id} is ${o.scroll_h - o.client_h} px taller than its box and overflow-y is "${o.overflow_y}", so that content is not rendered`,
          expected: { scroll_h: `<= ${o.client_h + SLACK}`, overflow_y: o.overflow_y },
          measured: { scroll_h: o.scroll_h, client_h: o.client_h, text: el.text.slice(0, 120) },
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
      }

      // An active clamp or ellipsis truncates words the PO wrote verbatim.
      // Declared `ellipsis` with content that fits is fine - it is the
      // combination of the property AND overflow that loses text.
      if (o.line_clamp !== 'none' && o.scroll_h - o.client_h > SLACK) {
        findings.push(finding({
          rule: 'overflow',
          slide: slide.slide_id,
          element: el.id,
          message: `${el.id} has -webkit-line-clamp: ${o.line_clamp} and more content than fits, so lines the storyboard declared are silently dropped`,
          expected: { line_clamp: 'no clamping of storyboard text' },
          measured: { line_clamp: o.line_clamp, scroll_h: o.scroll_h, client_h: o.client_h },
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
      }
      if (o.text_overflow === 'ellipsis' && o.scroll_w - o.client_w > SLACK) {
        findings.push(finding({
          rule: 'overflow',
          slide: slide.slide_id,
          element: el.id,
          axis: 'x',
          message: `${el.id} is being truncated with an ellipsis; the rendered text is not the storyboard's text`,
          expected: { text_overflow: 'the full string fits' },
          measured: { text_overflow: 'ellipsis', scroll_w: o.scroll_w, client_w: o.client_w },
          boxes: [box(el.rect, el.id)].filter(Boolean),
        }));
      }

      // THE LINE IS REPORTED AGAINST THE ELEMENT THAT OWNS IT.
      //
      // text_lines walks the whole subtree, so a <td>'s clipped line is also a
      // line of its <tr>, of the <table>, and of every wrapper above them.
      // Every one of them reported it. One over-long table produced 236
      // findings across 93 elements - 78 from the <table> alone, 6 from each
      // <tr> - for what is a handful of defects, and that is a report nobody
      // can read: the three real causes were buried under their own echoes.
      //
      // `own_text` is the element whose text node this is, and it is the only
      // one an author can act on. The same reasoning already governs type-size
      // and contrast, which report against drawn text rather than against
      // every wrapper that inherited a font size.
      //
      // An element with no own text still has a BOX, and the box checks above
      // still run on it - so a container that overflows is still reported as
      // a container that overflows.
      // ONE FINDING PER ELEMENT, WITH EVERY LOST LINE AS ITS EVIDENCE.
      //
      // Reporting per LINE made one over-long comparison cell five findings
      // and one page a hundred and two. The defect is "this element does not
      // fit", which is one thing an author fixes once; which of its lines
      // went over the edge is evidence for that, not five separate problems.
      // The lines are all still in `measured`, so nothing is lost from the
      // report - only the repetition is.
      const offCanvas = [];
      /** @type {Map<string, {clip: any, lines: any[]}>} */
      const clipped = new Map();
      for (const line of (el.own_text ? el.text_lines : [])) {
        if (outside(line, canvas, SLACK)) { offCanvas.push(line); continue; }
        for (const clip of el.clipping_ancestors) {
          if (!clip.rect) continue;
          if (outside(line, clip.rect, SLACK)) {
            const key = clip.deck_id || clip.element;
            if (!clipped.has(key)) clipped.set(key, { clip, lines: [] });
            clipped.get(key).lines.push(line);
            break;
          }
        }
      }
      if (offCanvas.length > 0) {
        findings.push(finding({
          rule: 'overflow',
          slide: slide.slide_id,
          element: el.id,
          message: `${offCanvas.length} text line(s) of ${el.id} fall outside the canvas and will not appear in the PDF, starting "${offCanvas[0].text}"`,
          expected: { within: 'canvas', canvas: rect(canvas) },
          measured: {
            lines_lost: offCanvas.length,
            lines: offCanvas.map((l) => ({ ...rect(l), text: l.text })),
          },
          boxes: [box(canvas, 'canvas', 'reference'), ...offCanvas.map((l) => box(l, `line of ${el.id}`))].filter(Boolean),
        }));
      }
      for (const [key, { clip, lines }] of clipped) {
        findings.push(finding({
          rule: 'overflow',
          slide: slide.slide_id,
          element: el.id,
          reference: key,
          message: `${lines.length} text line(s) of ${el.id} are clipped by ${key} (overflow-x ${clip.overflow_x}, overflow-y ${clip.overflow_y}), starting "${lines[0].text}"`,
          expected: { within: key, clip_rect: rect(clip.rect) },
          measured: {
            lines_lost: lines.length,
            lines: lines.map((l) => ({ ...rect(l), text: l.text })),
          },
          boxes: [
            box(clip.rect, `clipping ${key}`, 'reference'),
            ...lines.map((l) => box(l, `line of ${el.id}`)),
          ].filter(Boolean),
        }));
      }
    }
  }
  return findings;
}

/** Is `inner` not fully contained in `outer`, beyond `slack`? */
function outside(inner, outer, slack) {
  if (!inner || !outer) return false;
  return inner.x < outer.x - slack
    || inner.y < outer.y - slack
    || inner.x + inner.w > outer.x + outer.w + slack
    || inner.y + inner.h > outer.y + outer.h + slack;
}

function rect(r) {
  if (!r) return null;
  const n = (v) => Math.round(v * 100) / 100;
  return { x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) };
}

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect'],
  nested: { overflow: ['scroll_w', 'scroll_h', 'client_w', 'client_h'] },
  textLines: true,
  clippingAncestorRects: true,
};
