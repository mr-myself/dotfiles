import { box, finding } from '../finding.js';

/**
 * SLOT FILL: does the deck actually have its pictures in it?
 *
 * Fourteen of fifteen illustration slots on a real deck were empty. `deck
 * lint` passed. `deck gate render --release` produced a finished PDF. `deck
 * gate status` printed "cover-art empty" next to the others and nothing fell
 * over. The ten blocking findings the PO did get were all `repetition`, about
 * subtitles 32 px apart - measured on pages that had no pictures on them.
 *
 * The PO's diagnosis is the one this rule exists to answer:
 *
 *   lint は「ページ間で揃っているか」は測るが「ページに中身があるか」を測っていない
 *
 * Nine rules measured where things were. None asked whether anything was
 * there. This one does, for the one piece of content deck cannot see inside
 * and cannot invent: the illustration the PO has to supply.
 *
 * WHAT IS COMPARED WITH WHAT.
 *
 * The STORYBOARD says which slots exist - that is the author declaring this
 * page needs a picture here - and the RENDERED PAGE says whether one arrived.
 * Both halves are needed, and a first version that read only the DOM found
 * nothing on the very deck this rule was written for:
 *
 *   - an empty BLEED slot renders no box at all, deliberately, because the
 *     theme's own watercolour already fills that corner and a reserved frame
 *     drawn over it was two decorations fighting. No box, nothing to measure,
 *     no finding - and cover-art, agenda-art and divider-art are all bleed.
 *   - a column's art frame is marked `decorative`, because content is allowed
 *     to sit over it. Skipping decorative boxes skipped the slot as well.
 *
 * So absence of evidence is read as absence: a declared slot with no element
 * reporting `filled` has no picture in it, whatever the asset manifest says.
 * That is also the direction that fails safe - the manifest can hold a row for
 * a slot the storyboard no longer declares, and the manifest is not what the
 * audience sees.
 *
 * WHAT IS NOT A FAILURE, and why each:
 *
 *   reuse_unchanged   a logo, a photo, a product screen, a QR code. deck
 *                     never generates these and emits no prompt for them, so
 *                     demanding one before a preview would block a deck on an
 *                     asset the tool cannot produce. Reported as a suggestion
 *                     so it stays on the list.
 *   decorative        a slot the storyboard marks decorative is scenery, and
 *                     the theme's watercolour is already in that corner.
 *
 * Everything else BLOCKS. A slot is a declaration that this page needs a
 * picture; an empty one is an unfinished page, and the argument for having a
 * gate at all is that an unfinished page should not reach the PO looking
 * finished.
 *
 * @param {object} ctx
 * @param {any[]} ctx.slides
 * @param {any} [ctx.storyboard]
 * @returns {import('../finding.js').Finding[]}
 */
export function slotFillRule({ slides, storyboard }) {
  const findings = [];
  // Without a storyboard there is nothing declaring what SHOULD be here, and
  // this rule has no opinion rather than a false one. `deck lint` always has
  // one; the unit tests that drive rules directly sometimes do not.
  if (!storyboard || !Array.isArray(storyboard.slides)) return findings;

  const measured = new Map(slides.map((s) => [s.slide_id, s]));

  for (const slide of storyboard.slides) {
    const geometry = measured.get(slide.id);
    if (!geometry) continue;
    const filled = filledSlots(geometry);
    const boxes = slotBoxes(geometry);

    for (const slot of slide.slots || []) {
      if (filled.has(slot.id)) continue;
      if (slot.decorative === true) continue;
      const reuse = slot.reuse_unchanged === true;
      const where = boxes.get(slot.id) || null;
      findings.push(finding({
        rule: 'slot-fill',
        severity: reuse ? 'suggestion' : 'fail',
        slide: slide.id,
        element: where ? where.id : `slot-${slot.id}`,
        message: reuse
          ? `slot "${slot.id}" is marked reuse_unchanged and has no asset yet. deck does not generate these - a logo, a photo, a product screen, a QR code - so it is yours to supply before the deck is finished. It does not block a preview.`
          : `slot "${slot.id}" is empty: this page reserves ${slot.width_px}x${slot.height_px} px for an illustration ("${firstLine(slot.brief)}") and no image has been imported into it. Run \`deck gate prompts --single\`, draw it, drop the file in inbox/ and run \`deck gate inbox\` - or delete the slot from the storyboard if the page does not need a picture.`,
        expected: { slot_state: 'filled' },
        measured: {
          slot: slot.id,
          slot_state: where ? where.slot_state : 'not rendered',
          reserved_px: { w: slot.width_px, h: slot.height_px },
          reuse_unchanged: reuse,
        },
        boxes: [where && where.rect ? box(where.rect, where.id) : null].filter(Boolean),
      }));
    }
  }
  return findings;
}

/**
 * Slot ids a measured slide reports as having their picture.
 *
 * Any element carrying the slot id may report it, because a slot is drawn by
 * one of two paths - absolutely positioned, or in flow inside a card - and
 * only one of them draws any given slot. One `filled` anywhere is enough.
 *
 * @param {any} slide
 */
function filledSlots(slide) {
  const out = new Set();
  for (const el of slide.elements) {
    if (el.slot && el.slot_state === 'filled' && el.visible) out.add(el.slot);
  }
  return out;
}

/** @param {any} slide @returns {Map<string, any>} slot id -> the box drawn for it */
function slotBoxes(slide) {
  const out = new Map();
  for (const el of slide.elements) {
    if (el.slot && el.rect && !out.has(el.slot)) out.set(el.slot, el);
  }
  return out;
}

/** @param {string} [s] */
function firstLine(s) {
  const t = String(s || '').split('\n')[0].trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/** @see geometry-check.js - the fields this rule requires to be well formed. */
export const READS = {
  rects: ['rect'],
  slotState: true,
};
