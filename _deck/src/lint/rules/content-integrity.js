import { ELEMENT_IDS, leadBlocksOf } from '../../render/templates.js';
import { box, finding } from '../finding.js';

/**
 * CONTENT INTEGRITY: required text must be VISIBLY PAINTED.
 *
 * Every other rule here asks whether something is in the right place. This
 * one asks whether it is there at all, and it exists because nothing else
 * did.
 *
 * `display: none` on a cover title produces an element every rule skips -
 * it is not visible, so it has no measurable geometry, so centring,
 * overflow, collision, margins, alignment, type size, contrast, repetition
 * and proximity all pass over it in silence. A measured fixture with a
 * hidden title passed all nine. The end-to-end verbatim test could not catch
 * it either: it compares `textContent`, which still contains hidden text.
 *
 * So this rule checks DELIVERED output rather than DOM content: for each
 * field the storyboard says must appear, there must be an element carrying
 * it that is visible, has a non-empty painted rectangle, and is not reduced
 * to nothing by opacity.
 *
 * AND THAT EVERY CHARACTER OF IT IS ON THE PAGE. That last check was missing
 * for a long time and the docstring above overclaimed without it: a stress
 * deck produced a cover whose subtitle was visibly cut off mid-sentence, and
 * this rule reported nothing, because `el.text` is textContent and textContent
 * keeps every character of a line typeset past the paper edge. The delivered
 * text is the text of the line boxes that are inside the canvas and inside
 * every clipping ancestor. See missingFromPage() at the foot of this file.
 *
 * It takes the storyboard, which no other rule does, because "what must be
 * on this slide" is a question only the storyboard can answer.
 *
 * THE DIVISION WITH THE CONTRAST RULE, stated so neither assumes the other:
 *
 *   paint alpha <= PAINT_ALPHA_FLOOR   THIS rule fails it. Nothing is drawn,
 *                                      so there is no contrast question to
 *                                      ask; "is it there" comes first.
 *   paint alpha above the floor        CONTRAST composites it and fails it
 *                                      on the ratio if it is too faint.
 *
 * There is no gap between those two and no overlap. The previous split had
 * both rules skipping zero-alpha text, each assuming the other covered it.
 */

/**
 * Below this, text is not painted in any meaningful sense.
 *
 * Not zero: a colour alpha of 0.0005 over any backing is indistinguishable
 * from nothing, and calling it "painted" would hand it to the contrast rule
 * to report a ratio of 1.00 instead of saying the honest thing.
 */
const PAINT_ALPHA_FLOOR = 0.004;

/**
 * Which element id carries which storyboard field.
 *
 * Built from ELEMENT_IDS and leadBlocksOf, the SAME helpers the templates
 * use to emit those ids, so the two cannot drift. They had: this list was
 * hand-written and omitted paragraph text, body bullet items and card bullet
 * items - all rendered by standard3col - so hiding any of them left them
 * outside every rule's coverage.
 *
 * Only fields that are RENDERED appear here. `purpose` and `speaker_notes`
 * are authoring metadata and are deliberately never drawn.
 *
 * @param {any} slide
 * @returns {{field: string, elementId: string, text: string}[]}
 */
export function requiredText(slide) {
  /** @type {{field: string, elementId: string, text: string}[]} */
  const required = [];
  const add = (field, elementId, text) => {
    if (typeof text === 'string' && text.trim()) required.push({ field, elementId, text });
  };

  add('title', ELEMENT_IDS.title(), slide.title);
  add('subtitle', ELEMENT_IDS.subtitle(), slide.subtitle);
  add('section_label', ELEMENT_IDS.sectionLabel(), slide.section_label);

  if (slide.footer) {
    add('footer.text', ELEMENT_IDS.footerText(), slide.footer.text);
    add('footer.label', ELEMENT_IDS.footerLabel(), slide.footer.label);
  }
  (slide.agenda?.items || []).forEach((item, i) => {
    add(`agenda.items[${i}]`, ELEMENT_IDS.agendaText(i + 1), item);
  });

  // THE LEAD BLOCKS. `lead-N` is indexed over the FILTERED paragraph/bullets
  // list, not over `body`, so this filters through the same helper the
  // template does rather than re-deriving the index.
  leadBlocksOf(slide).forEach((block, i) => {
    if (block.kind === 'paragraph') {
      add(`body[${i}] paragraph`, ELEMENT_IDS.lead(i), block.text);
      return;
    }
    (block.items || []).forEach((item, j) => {
      add(`body[${i}] bullet[${j}]`, ELEMENT_IDS.leadItem(i, j), item);
    });
  });

  for (const block of slide.body || []) {
    if (block.kind === 'statement') add('body statement', ELEMENT_IDS.statementBody(), block.text);
    (block.cards || []).forEach((card, i) => {
      const n = i + 1;
      add(`cards[${i}].heading`, ELEMENT_IDS.cardHeading(n), card.heading);
      add(`cards[${i}].body`, ELEMENT_IDS.cardBody(n), card.body);
      (card.items || []).forEach((item, j) => {
        add(`cards[${i}].items[${j}]`, ELEMENT_IDS.cardItem(n, j), item);
      });
    });
  }

  if (slide.table) {
    (slide.table.columns || []).forEach((c, i) => {
      add(`table.columns[${i}].heading`, ELEMENT_IDS.tableHeading(i), c.heading);
    });
    (slide.table.rows || []).forEach((row, r) => {
      row.forEach((cell, c) => add(`table.rows[${r}][${c}]`, ELEMENT_IDS.tableCell(r, c), cell));
    });
    add('table.note', ELEMENT_IDS.tableNote(), slide.table.note);
  }
  return required;
}

/**
 * @param {object} ctx
 * @param {any[]} ctx.slides measured geometry
 * @param {any} ctx.storyboard
 * @returns {import('../finding.js').Finding[]}
 */
export function contentIntegrityRule({ slides, storyboard }) {
  const findings = [];
  if (!storyboard) return findings;
  const bySlideId = new Map(storyboard.slides.map((s) => [s.id, s]));

  for (const measured of slides) {
    const slide = bySlideId.get(measured.slide_id);
    if (!slide) continue;
    const elements = new Map(measured.elements.map((e) => [e.id, e]));

    for (const { field, elementId, text } of requiredText(slide)) {
      const el = elements.get(elementId);
      const preview = text.length > 40 ? `${text.slice(0, 37)}...` : text;

      if (!el) {
        findings.push(finding({
          rule: 'content-integrity',
          slide: measured.slide_id,
          element: elementId,
          message: `the storyboard's ${field} ("${preview}") was not rendered at all: no element "${elementId}" exists on this slide`,
          expected: { field, text, element: elementId, rendered: true },
          measured: { element: null },
        }));
        continue;
      }
      if (!el.visible) {
        findings.push(finding({
          rule: 'content-integrity',
          slide: measured.slide_id,
          element: elementId,
          message: `the storyboard's ${field} ("${preview}") is in the DOM but is NOT VISIBLE, so it is absent from the delivered page. Every other rule skips an invisible element, which is why this one exists.`,
          expected: { field, text, visible: true },
          measured: { visible: false, display: el.style?.display, text: el.text },
          boxes: [box(el.rect, elementId)].filter(Boolean),
        }));
        continue;
      }
      const painted = el.content_union || el.rect;
      if (!painted || painted.w <= 0 || painted.h <= 0) {
        findings.push(finding({
          rule: 'content-integrity',
          slide: measured.slide_id,
          element: elementId,
          message: `the storyboard's ${field} ("${preview}") renders to an empty rectangle, so nothing is painted`,
          expected: { field, text, painted: 'a non-empty rectangle' },
          measured: { rect: el.rect, content_union: el.content_union },
          boxes: [box(el.rect, elementId)].filter(Boolean),
        }));
        continue;
      }
      if (el.text_lines.length === 0 && el.own_text) {
        findings.push(finding({
          rule: 'content-integrity',
          slide: measured.slide_id,
          element: elementId,
          message: `the storyboard's ${field} ("${preview}") has no measurable text line, so no glyphs were laid out`,
          expected: { field, text, text_lines: '>= 1' },
          measured: { text_lines: 0 },
          boxes: [box(el.rect, elementId)].filter(Boolean),
        }));
        continue;
      }
      // THE EFFECTIVE PAINT ALPHA, not element opacity alone.
      //
      // `color: transparent` leaves the rectangles, the textContent and
      // opacity:1 all intact, so checking opacity accepted it - and the
      // contrast rule skipped it as zero-alpha on the assumption that
      // content integrity had it covered. Each rule assuming the other was
      // handling it is what left the hole. The paint alpha is the product of
      // the two.
      const opacity = el.effective_opacity === undefined ? 1 : el.effective_opacity;
      const colourAlpha = el.color_alpha === undefined ? 1 : el.color_alpha;
      const paintAlpha = opacity * colourAlpha;
      if (paintAlpha <= PAINT_ALPHA_FLOOR) {
        const cause = colourAlpha <= PAINT_ALPHA_FLOOR && opacity > PAINT_ALPHA_FLOOR
          ? `its text colour is fully transparent (${el.style?.color})`
          : opacity <= PAINT_ALPHA_FLOOR && colourAlpha > PAINT_ALPHA_FLOOR
            ? `an ancestor sets opacity ${opacity}`
            : `its colour alpha is ${colourAlpha} and the inherited opacity is ${opacity}`;
        findings.push(finding({
          rule: 'content-integrity',
          slide: measured.slide_id,
          element: elementId,
          message: `the storyboard's ${field} ("${preview}") paints nothing: ${cause}. It occupies space and is in the DOM, so no other rule sees a problem.`,
          expected: { field, text, effective_paint_alpha: `> ${PAINT_ALPHA_FLOOR}` },
          measured: {
            effective_paint_alpha: Math.round(paintAlpha * 10000) / 10000,
            colour_alpha: colourAlpha,
            effective_opacity: opacity,
            color: el.style?.color ?? null,
          },
          boxes: [box(el.rect, elementId)].filter(Boolean),
        }));
        continue;
      }
      // THE WORDS THEMSELVES. A template that rendered the wrong field is a
      // content defect, and this is the right place to catch it.
      const rendered = (el.text || '').replace(/\s+/g, '');
      const wanted = text.replace(/\s+/g, '');
      if (!rendered.includes(wanted)) {
        findings.push(finding({
          rule: 'content-integrity',
          slide: measured.slide_id,
          element: elementId,
          message: `the storyboard's ${field} is not the text that was rendered into "${elementId}"`,
          expected: { field, text },
          measured: { rendered: el.text },
          boxes: [box(el.rect, elementId)].filter(Boolean),
        }));
        continue;
      }

      // ...AND THE WORDS THAT REACHED THE PAGE.
      //
      // Everything above this asks whether the text is in the DOM and painted
      // somewhere. `el.text` is textContent, and textContent still holds every
      // character of a line that was laid out past the paper edge - so a
      // subtitle visibly cut off mid-sentence satisfied every check above it.
      // That was measured: a cover whose subtitle ended 「行間が詰ま」 on the
      // page, with the rest of the sentence laid out below the canvas, and
      // this rule reporting nothing.
      //
      // The docstring promised "DELIVERED output rather than DOM content" and
      // this is the half that was missing. The delivered text is the text of
      // the line boxes that are actually inside the canvas and inside every
      // clipping ancestor; the rest was typeset into space nobody will see.
      //
      // `overflow` independently reports those lines as geometry, which is why
      // the characters were never lost silently - the verdict was FAIL either
      // way. The two are not duplicates: overflow says a box left the page,
      // this says WHICH OF THE PO'S CHARACTERS are not on it. That sentence is
      // the tool's central promise and one rule should state it.
      const missing = missingFromPage(el, canvasOf(measured));
      if (missing) {
        findings.push(finding({
          rule: 'content-integrity',
          slide: measured.slide_id,
          element: elementId,
          message: `${missing.length} character(s) of the storyboard's ${field} were laid out but are NOT ON THE PAGE: "${missing}". The words are in the DOM and the element is painted, so every check except this one passes; they are simply off the edge of the paper or clipped by an ancestor. Shorten the field, or move it to a page type that holds it - never let it ship truncated.`,
          expected: { field, text, delivered: 'every character inside the canvas' },
          measured: { missing, missing_count: missing.length },
          boxes: [box(el.rect, elementId)].filter(Boolean),
        }));
      }
    }
  }
  return findings;
}

/** @param {any} measured */
function canvasOf(measured) {
  return measured.regions?.canvas || null;
}

/**
 * The characters of an element's text that were laid out somewhere no reader
 * will see, or '' when every line landed on the page.
 *
 * Built from the LINE boxes, each of which carries its own text - see the
 * collector's textLines(). While every line carried the whole string this
 * could not be written at all.
 *
 * @param {any} el
 * @param {any} canvas
 * @returns {string} the missing characters, '' when none
 */
function missingFromPage(el, canvas) {
  if (!canvas || !Array.isArray(el.text_lines) || el.text_lines.length === 0) return '';
  const fontSize = el.style?.font_size_px;
  const clips = Array.isArray(el.clipping_ancestors) ? el.clipping_ancestors : [];
  let missing = '';
  for (const line of el.text_lines) {
    if (!line.text) continue;
    const band = glyphBand(line, fontSize);
    if (escapes(band, canvas) || clips.some((c) => c.rect && escapes(band, c.rect))) {
      missing += line.text;
    }
  }
  return missing;
}

/**
 * THE GLYPH BAND, NOT THE LINE BOX.
 *
 * A line box is the font's reserved space: with line-height 49 on a 32 px
 * font there is 8.5 px of leading above the glyphs and 8.5 below, and none of
 * it is ink. Two tempting tests are both wrong on it. Testing the line box's
 * EDGES reports a last line that is perfectly readable, because its leading
 * pokes past the margin - a false "your words are gone", which on this rule
 * is the most alarming thing it could say. Testing the line's CENTRE misses a
 * line whose lower half is off the paper, which was measured: the cover's
 * third subtitle line had its glyph band running 12 px past the paper edge,
 * visibly chopped in the PNG, and a centre test called it delivered.
 *
 * So the band is the line box inset by its own leading, and that is compared.
 * It is ink against paper, which is the question actually being asked.
 *
 * @param {any} line
 * @param {number} fontSize
 */
function glyphBand(line, fontSize) {
  const leading = Number.isFinite(fontSize) && fontSize > 0
    ? Math.max(0, (line.h - fontSize) / 2)
    : 0;
  return {
    x: line.x, y: line.y + leading, w: line.w, h: Math.max(1, line.h - leading * 2),
  };
}

/** @param {any} band @param {any} box */
function escapes(band, box) {
  return band.y < box.y || band.y + band.h > box.y + box.h
    || band.x < box.x || band.x + band.w > box.x + box.w;
}

/**
 * What this rule reads. geometry-check validates exactly these, so a field
 * added here is validated and a field read WITHOUT being declared here is the
 * bug the declaration exists to prevent.
 */
export const READS = {
  rects: ['rect', 'content_union?'],
  numbers: ['effective_opacity?', 'color_alpha?'],
  nested: { style: ['font_size_px'] },
  textLines: true,
  clippingAncestorRects: true,
};
