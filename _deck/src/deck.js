import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validate, pageTypes } from './schema.js';
import { loadTheme } from './theme/load.js';
import { DeckError, EXIT, environment } from './util/fail.js';
import { assertInside, sha256, sha256File } from './util/fs.js';
import { loadYaml } from './util/yaml.js';
import { paths, requireWorkspace } from './workspace.js';

/**
 * Load everything a command needs about a deck: the request, the storyboard,
 * the theme and the asset manifest, each schema-checked on the way in.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.requireStoryboard]
 * @returns {{root: string, p: import('./workspace.js').Paths, request: any, storyboard: any, theme: any, manifest: any}}
 */
export function loadDeck({ cwd = process.cwd(), requireStoryboard = true } = {}) {
  const root = requireWorkspace(cwd);
  const p = paths(root);

  const request = loadYaml(p.deckYaml);
  const reqErrors = validate('deck.schema.json', request, `${p.deckYaml}: `);
  if (reqErrors.length > 0) {
    throw new DeckError('deck.yaml does not match deck\'s request schema', EXIT.VERDICT_FAILED, reqErrors);
  }
  rejectUnimplementedOutputs(request, p.deckYaml);

  let storyboard = null;
  if (fs.existsSync(p.storyboard)) {
    storyboard = loadYaml(p.storyboard);
    const sbErrors = validate('storyboard.schema.json', storyboard, `${p.storyboard}: `);
    if (sbErrors.length > 0) {
      throw new DeckError('storyboard.yaml does not match deck\'s storyboard schema', EXIT.VERDICT_FAILED, sbErrors);
    }
  } else if (requireStoryboard) {
    environment(`this deck has no storyboard.yaml`, [`Expected at: ${p.storyboard}`]);
  }

  const theme = loadTheme(request.request.theme, request.theme_overrides || {});
  const manifest = loadManifest(p);
  return { root, p, request, storyboard, theme, manifest };
}

/**
 * Read and VALIDATE assets/manifest.json.
 *
 * It used to be read with readJsonIfExists, which returns null on malformed
 * JSON, and the caller substituted an empty manifest. So a corrupted manifest
 * silently became "this deck has no assets", every slot rendered empty, and
 * the render reported success. Nothing said a word about the file that could
 * not be parsed.
 *
 * @param {import('./workspace.js').Paths} p
 */
export function loadManifest(p) {
  if (!fs.existsSync(p.assetManifest)) {
    return { schema: 'deck.assets/1', assets: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p.assetManifest, 'utf8'));
  } catch (err) {
    throw new DeckError('assets/manifest.json is not valid JSON', EXIT.VERDICT_FAILED, [
      String(err.message),
      'deck will not silently treat a corrupt manifest as an empty one: every slot would render blank and the build would report success.',
    ]);
  }
  const errors = validate('asset-manifest.schema.json', parsed, `${p.assetManifest}: `);
  if (errors.length > 0) {
    throw new DeckError('assets/manifest.json does not match deck\'s asset schema', EXIT.VERDICT_FAILED, errors);
  }
  return parsed;
}

/**
 * PPTX is out of this increment. It is refused BY NAME rather than ignored,
 * because an ignored output format means the PO asks for a pptx, gets a clean
 * exit, and finds no pptx - which reads as deck losing the file rather than
 * declining the job.
 * @param {any} request
 * @param {string} file
 */
function rejectUnimplementedOutputs(request, file) {
  const formats = request.request.output?.formats;
  if (!formats) return;
  const unimplemented = {
    pptx: 'PPTX export is not implemented in this increment. PDF is the primary deliverable; a pptx of one full-page image per slide is exactly the raster-dependence this tool exists to remove, and an editable pptx is a separate piece of work.',
    pptx_image: 'Same as pptx: not implemented in this increment.',
    pptx_editable: 'Same as pptx: not implemented in this increment.',
    svg: 'SVG export is not implemented.',
  };
  for (const f of formats) {
    if (unimplemented[f]) {
      throw new DeckError(`${file}: output format "${f}" is not implemented`, EXIT.VERDICT_FAILED, [unimplemented[f]]);
    }
  }
}

/**
 * Per-slide validation that a JSON Schema cannot express: which page type
 * accepts which content, and whether the words the PO wrote can actually be
 * laid out by the template that claims them.
 *
 * @param {any} storyboard
 * @param {any} theme
 * @returns {string[]} problems, empty when the storyboard is renderable
 */
export function validateSemantics(storyboard, theme) {
  const { implemented, unimplemented } = pageTypes();
  /** @type {string[]} */
  const problems = [];
  const seenSlides = new Set();
  const seenSlots = new Set();

  for (const slide of storyboard.slides) {
    if (seenSlides.has(slide.id)) {
      problems.push(`duplicate slide id "${slide.id}": slide ids are referenced by approvals, assets and lint findings, so they must be unique`);
    }
    seenSlides.add(slide.id);

    if (!implemented.has(slide.page_type)) {
      const reason = unimplemented.get(slide.page_type)
        || 'this name is not in deck\'s page-type vocabulary';
      problems.push(`slide "${slide.id}": page_type "${slide.page_type}" is not implemented. ${reason}`);
      continue;
    }
    if (!theme.page_types[slide.page_type]) {
      problems.push(`slide "${slide.id}": theme "${theme.name}" has no geometry for page_type "${slide.page_type}"`);
    }

    // UNIQUE WITHIN THE SLIDE, not across the deck.
    //
    // This used to be deck-wide, with the reason written into the message:
    // `deck assets import` addressed slots by id alone. That made the CLI's
    // addressing scheme a constraint on the storyboard, and it capped a deck
    // at one standard-3col slide with column art. Slots are now addressed by
    // `<slide-id>:<slot-id>` - see slotKey - so two slides may each have their
    // own col-1-art, which is what "the first column's picture" has always
    // meant. Within ONE slide an id still has to be unique: two boxes claiming
    // the same position is a storyboard that cannot be drawn.
    const seenHere = new Set();
    for (const slot of slide.slots || []) {
      if (seenHere.has(slot.id)) {
        problems.push(`slide "${slide.id}" declares slot "${slot.id}" twice. Slot ids are unique within a slide - across slides they may repeat, because \`col-1-art\` names a position on the page rather than one particular picture.`);
      }
      seenHere.add(slot.id);
      seenSlots.add(slotKey(slide.id, slot.id));
      const geometry = (theme.page_types[slide.page_type]?.slots || {})[slot.id];
      if (!geometry) {
        problems.push(`slide "${slide.id}": slot "${slot.id}" has no position in theme "${theme.name}" for page_type "${slide.page_type}". Known slots for this page type: ${Object.keys(theme.page_types[slide.page_type]?.slots || {}).join(', ') || '(none)'}`);
      }
      // A SLOT THE TEMPLATE WILL NOT DRAW IS A PICTURE NOBODY SEES.
      //
      // The theme may qualify a flow slot - ecosystem-art is declared for the
      // ecosystem page type but only the LAYERS form has a band to put it in;
      // a hub already fills the canvas. Without this the author declares the
      // slot, the brief asks the PO to draw it, `slot-fill` blocks until it
      // exists, and the template silently draws nothing. Refusing by name is
      // the only honest outcome.
      if (geometry && geometry.layout && slide[slide.page_type]?.layout !== geometry.layout) {
        problems.push(`slide "${slide.id}": slot "${slot.id}" is only drawn on a ${slide.page_type} whose layout is "${geometry.layout}", and this slide's layout is "${slide[slide.page_type]?.layout ?? '(none)'}". Remove the slot, or change the layout.`);
      }
      if (slot.width_px > theme.canvas.width || slot.height_px > theme.canvas.height) {
        problems.push(`slide "${slide.id}": slot "${slot.id}" is ${slot.width_px}x${slot.height_px}, larger than the ${theme.canvas.width}x${theme.canvas.height} canvas`);
      }
    }

    problems.push(...validateSlideShape(slide));
    problems.push(...validateCapacity(slide, theme));
  }
  return problems;
}

/**
 * WHAT THE PAGE CAN HOLD, as against what the schema permits.
 *
 * THE DEFECT THIS CLOSES. There are two ways to give a page type more than it
 * can lay out - more ITEMS, or longer TEXT - and the storyboard schema bounded
 * neither consistently. Six dimensions carry a `maxItems` and every one of
 * them holds: a stress deck built at exactly those caps, with short text,
 * renders clean. The dimensions with NO maxItems are the ones that break, and
 * they break the same way every time: the page renders, nothing refuses it,
 * and the author is handed a wall of geometry findings instead of the one
 * sentence they needed. An eight-item agenda produced 25; a fourteen-row
 * table produced 329.
 *
 * The pattern is not that counts are safe and lengths are not. It is that a
 * bound exists exactly where somebody once measured a page type, and nowhere
 * else. So the bound belongs where the measurement is: in the THEME, beside
 * the geometry it was measured against.
 *
 * WHY NOT THE SCHEMA. How many rows fit is a fact about a canvas size, a type
 * size and a row height - all theme. The same storyboard on a taller canvas
 * holds more. The schema's existing maxItems are a different kind of statement
 * - "beyond four columns a comparison stops being readable" is a design-kit
 * judgement that travels with the content, not with the page - and those stay
 * where they are. The schema says what is MEANINGFUL; the theme says what
 * FITS.
 *
 * WHY THIS REFUSES rather than warns. A count is a discrete authoring decision
 * with an obvious remedy, and the design kit names it: when content will not
 * fit, the answer is to raise the page split with the author
 * (ページ分割等の必要箇所をまとめて確認する), never to summarise, delete,
 * shrink below readability or add pages unasked. A refusal before anything
 * renders is that conversation happening at the cheapest moment.
 *
 * TEXT LENGTH IS DELIBERATELY NOT HERE. See the note in the README: a
 * character budget is a theme-dependent approximation of something the render
 * already measures exactly, and two sources of truth that disagree is a worse
 * failure than a late one.
 *
 * @param {any} slide
 * @param {any} theme
 * @returns {string[]}
 */
function validateCapacity(slide, theme) {
  const out = [];
  const capacity = theme.page_types?.[slide.page_type]?.capacity;
  if (!capacity) return out;
  // A FOOTER BANNER COSTS ONE ROW, AND THAT HAD TO BE MEASURED TOO.
  //
  // The first version of this carried one number per dimension, swept with no
  // footer. A realistic mid-sized deck then failed on a six-row table - under
  // the cap of seven - by 4.69 px, because its table also had a conclusion
  // banner. Re-swept: a table holds 7 rows plain, 7 with a note, and 6 with a
  // footer; an agenda holds 7 plain and 6 with a footer. The banner is 92 px
  // off the bottom of the page and a row is about 90, so it costs exactly one.
  //
  // This is the kind of dependency only varied input finds, and it is why the
  // limit is a shape rather than a scalar. A page type whose body absorbs
  // slack - the diagram types have a flexible illustration band under the
  // figure - does not pay it, and says so by declaring one number.
  const hasFooter = Boolean(slide.footer);
  for (const [path, declared] of Object.entries(capacity)) {
    const limit = typeof declared === 'number'
      ? declared
      : (hasFooter && Number.isFinite(declared.max_with_footer)
        ? declared.max_with_footer
        : declared.max);
    const value = path.split('.').reduce((o, k) => (o == null ? o : o[k]), slide);
    if (!Array.isArray(value) || !Number.isFinite(limit) || value.length <= limit) continue;
    out.push(
      `slide "${slide.id}": ${path} has ${value.length} entries, and theme "${theme.name}" `
      + `lays out at most ${limit} on a page of type "${slide.page_type}"`
      + `${hasFooter && typeof declared === 'object' && declared.max_with_footer < declared.max ? ` that carries a footer banner (${declared.max} without one - the banner takes 92 px off the bottom of the page, which is about one row)` : ''}. That limit is `
      + 'MEASURED from real renders, not a preference: past it the content runs off the page. '
      + 'Split it across two slides. Do not summarise it, drop entries, or shrink the type '
      + 'to fit - the design kit forbids all three (無断要約 / 文言削除 / 読めない大きさへの縮小).',
    );
  }
  return out;
}

/** @param {any} slide @returns {string[]} */
function validateSlideShape(slide) {
  /** @type {string[]} */
  const out = [];
  const kinds = (slide.body || []).map((b) => b.kind);
  const needs = (what, cond) => {
    if (!cond) out.push(`slide "${slide.id}" is page_type "${slide.page_type}" but ${what}`);
  };

  switch (slide.page_type) {
    case 'cover':
      needs('has no title', slide.title);
      break;
    case 'agenda':
      needs('has no agenda.items', (slide.agenda?.items || []).length > 0);
      if (slide.agenda?.active != null && slide.agenda.active > (slide.agenda.items || []).length) {
        out.push(`slide "${slide.id}": agenda.active is ${slide.agenda.active} but there are only ${slide.agenda.items.length} items`);
      }
      break;
    case 'section-divider':
      needs('has no title', slide.title);
      break;
    case 'standard-3col':
      needs('has no cards block in body', kinds.includes('cards'));
      needs('has no title', slide.title);
      break;
    case 'table':
      needs('has no table', slide.table);
      break;
    case 'statement':
      needs('has no title', slide.title);
      // THE EYEBROW IS NOT OPTIONAL HERE. Every other content page carries one
      // and a cover does not have to; a statement page without it is a large
      // sentence on white with nothing saying where in the argument it sits,
      // which is exactly how it read to the PO arriving at it mid-deck. It is
      // one short phrase the author already knows, so requiring it costs
      // nothing and is the difference between a pause and a stray title.
      needs('has no section_label; a statement page needs the eyebrow that says where in the deck this pause is happening', slide.section_label);
      break;
    case 'comparison': {
      needs('has no comparison', slide.comparison);
      // EVERY COLUMN ANSWERS EVERY AXIS. A column with a missing cell shifts
      // every row beneath it, so the thing the page exists to show - that
      // these two values are answers to the same question - becomes false.
      // Refusing is the only honest option: deck cannot invent the cell and
      // must not silently pad it.
      const c = slide.comparison;
      if (c) {
        const n = (c.axes || []).length;
        (c.columns || []).forEach((col, i) => {
          if ((col.cells || []).length !== n) {
            out.push(`slide "${slide.id}": comparison column ${i + 1} ("${col.label}") has ${(col.cells || []).length} cell(s) but there are ${n} axes. Corresponding rows must align across columns, so deck will not pad or drop a cell.`);
          }
        });
      }
      break;
    }
    case 'process':
      needs('has no process', slide.process);
      break;
    case 'ecosystem': {
      needs('has no ecosystem', slide.ecosystem);
      const e = slide.ecosystem;
      if (e && e.layout === 'hub') {
        if (!e.centre) out.push(`slide "${slide.id}": an ecosystem with layout "hub" needs a centre`);
        if ((e.nodes || []).length < 2) {
          out.push(`slide "${slide.id}": an ecosystem with layout "hub" needs at least two nodes around the centre`);
        }
        if ((e.layers || []).length > 0) {
          out.push(`slide "${slide.id}": layout is "hub", so \`layers\` would not be drawn. deck refuses rather than dropping it.`);
        }
      }
      if (e && e.layout === 'layers') {
        if ((e.layers || []).length < 2) {
          out.push(`slide "${slide.id}": an ecosystem with layout "layers" needs at least two layers - the functions and the base they share`);
        }
        if (e.centre || (e.nodes || []).length > 0) {
          out.push(`slide "${slide.id}": layout is "layers", so \`centre\`/\`nodes\` would not be drawn. deck refuses rather than dropping them.`);
        }
      }
      break;
    }
    case 'timeline':
      needs('has no timeline', slide.timeline);
      break;
    default:
      break;
  }

  // Block kinds a page type cannot lay out. Accepting and dropping them would
  // lose the PO's words silently, which is the one thing this schema exists to
  // prevent.
  const spec = PAGE_TYPE_CONTENT[slide.page_type] || { blocks: {}, fields: [] };
  const allowed = Object.keys(spec.blocks);
  for (const k of kinds) {
    if (!allowed.includes(k)) {
      out.push(`slide "${slide.id}": page_type "${slide.page_type}" cannot lay out a "${k}" block. Accepted here: ${allowed.join(', ') || '(none)'}. deck refuses rather than dropping the block.`);
    }
  }

  // MULTIPLICITY. The templates render only the FIRST block of a kind, so a
  // second one was accepted by the schema, signed into the content digest,
  // and then silently absent from the page. Two statements plus a footer
  // validated cleanly while the HTML contained one statement and no footer.
  // That is content loss, and avoiding it is the central promise of the tool.
  for (const [kind, max] of Object.entries(spec.blocks)) {
    // `Infinity` means the template renders every one of them, so there is no
    // loss to guard against; overflowing the page is the lint gate's job.
    if (!Number.isFinite(max)) continue;
    const n = kinds.filter((k) => k === kind).length;
    if (n > max) {
      out.push(`slide "${slide.id}": ${n} "${kind}" blocks, but page_type "${slide.page_type}" renders ${max === 1 ? 'only the first' : `at most ${max}`}. The rest would be silently dropped, so deck refuses. Split the slide, or merge the blocks.`);
    }
  }

  // KIND-SPECIFIC FIELDS. A `paragraph` with no text, or a `bullets` with no
  // items, renders as nothing at all.
  (slide.body || []).forEach((b, i) => {
    const where = `slide "${slide.id}" body[${i}] (${b.kind})`;
    if ((b.kind === 'paragraph' || b.kind === 'statement') && !String(b.text ?? '').trim()) {
      out.push(`${where} has no text, so it would render as nothing`);
    }
    if (b.kind === 'bullets' && (b.items || []).length === 0) {
      out.push(`${where} has no items, so it would render as nothing`);
    }
    if (b.kind === 'cards' && (b.cards || []).length === 0) {
      out.push(`${where} has no cards, so it would render as nothing`);
    }
    const used = { paragraph: 'text', statement: 'text', bullets: 'items', cards: 'cards' }[b.kind];
    for (const stray of ['text', 'items', 'cards']) {
      if (b[stray] !== undefined && stray !== used) {
        out.push(`${where} also carries "${stray}", which a "${b.kind}" block does not render. deck refuses rather than dropping it.`);
      }
    }
  });

  // TOP-LEVEL FIELDS THE PAGE TYPE DOES NOT RENDER. `footer` on a cover, a
  // `table` on an agenda, an `agenda` on a statement: all were accepted and
  // all silently vanished.
  //
  // THE LIST IS DERIVED, not written here. It used to be three hard-coded
  // names, so adding `comparison` to one page type left it silently accepted
  // and dropped on all the others - the exact drift this check exists to
  // prevent, reintroduced by the check's own shape. Every field ANY page type
  // declares is refused on every page type that does not.
  for (const field of ALL_RENDERED_FIELDS) {
    const present = slide[field] !== undefined && slide[field] !== null;
    if (present && !spec.fields.includes(field)) {
      out.push(`slide "${slide.id}" has ${FIELD_LABELS[field] || `a "${field}"`} ("${field}"), but page_type "${slide.page_type}" does not render one. It would be silently dropped, so deck refuses.`);
    }
  }

  // Layout line breaks naming a field this page type does not set.
  for (const field of Object.keys(slide.line_breaks_after || {})) {
    const target = field === 'statement'
      ? (slide.body || []).some((b) => b.kind === 'statement')
      : slide[field] !== undefined && slide[field] !== null;
    if (!target) {
      out.push(`slide "${slide.id}" declares line_breaks_after.${field}, but has no ${field} to break`);
    }
  }
  return out;
}

/**
 * What each page type ACTUALLY RENDERS.
 *
 * `blocks` maps a body-block kind to how many of them the template draws;
 * `fields` lists the top-level slide fields it draws. Anything a storyboard
 * supplies beyond this is refused at validation time rather than accepted and
 * dropped. The numbers come from reading the templates, and
 * test/unit/content.test.js asserts that this table and the templates agree -
 * so the table cannot drift away from what is really rendered.
 */
export const PAGE_TYPE_CONTENT = {
  cover: { blocks: {}, fields: [] },
  agenda: { blocks: {}, fields: ['agenda', 'footer'] },
  'section-divider': { blocks: {}, fields: [] },
  // standard3col uses `.find` for the cards block - only the first is drawn -
  // but maps over EVERY paragraph and bullets block, so those are unbounded.
  'standard-3col': { blocks: { cards: 1, paragraph: Infinity, bullets: Infinity }, fields: ['footer'] },
  table: { blocks: {}, fields: ['table', 'footer'] },
  // `footer` is the FRAMING a statement page needs. Without it the page was a
  // large sentence on white with nothing saying why the deck had stopped, and
  // it read as a title slide that had wandered in. The whitespace is right -
  // the design kit asks for it - the frame was missing.
  statement: { blocks: { statement: 1 }, fields: ['footer'] },
  // THE DIAGRAM PAGE TYPES.
  //
  // Each draws ONE structured field and an optional conclusion banner. They
  // take no body blocks: a diagram's content is the relationship, and a
  // paragraph floating beside it is the thing these page types exist to stop
  // the deck doing. Lead-in prose belongs in the subtitle, which they all draw.
  comparison: { blocks: {}, fields: ['comparison', 'footer'] },
  process: { blocks: {}, fields: ['process', 'footer'] },
  ecosystem: { blocks: {}, fields: ['ecosystem', 'footer'] },
  timeline: { blocks: {}, fields: ['timeline', 'footer'] },
};

/** Every top-level field SOME page type renders, so the rest can refuse it. */
const ALL_RENDERED_FIELDS = [...new Set(
  Object.values(PAGE_TYPE_CONTENT).flatMap((c) => c.fields),
)];

/** How each reads in a refusal message. */
const FIELD_LABELS = {
  footer: 'a footer banner',
  table: 'a table',
  agenda: 'an agenda list',
  comparison: 'a comparison',
  process: 'a process',
  ecosystem: 'an ecosystem diagram',
  timeline: 'a timeline',
};

/**
 * Slot id -> asset record, newest import wins.
 * @param {string} root
 * @param {any} manifest
 * @param {any} storyboard
 * @returns {Record<string, {src: string, sha256: string, stored_file: string, brief_digest: string, stale: boolean}>}
 */
export function resolveAssets(root, manifest, storyboard, { verify = false } = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  /** @type {string[]} */
  const problems = [];
  const briefs = slotBriefs(storyboard);
  // THE CONTAINMENT ROOT ITSELF MUST BE CONTAINED.
  //
  // `assets/` was trusted as the boundary without checking that it is still
  // inside the workspace. If assets/ is an external symlink, every manifest
  // entry resolves under it, passes the per-entry check, and external files
  // are handed to the renderer and added to Chrome's allowlist - with
  // verify:true and a matching hash, because the hash describes whatever is
  // actually there.
  let assetsDir;
  try {
    assetsDir = assertInside(path.join(root, 'assets'), root, 'the deck\'s assets directory');
  } catch (err) {
    if (verify) throw err;
    // Without verification this is a read-only caller (status, prompts); it
    // gets an empty set and the problem, rather than external files.
    const out = {};
    Object.defineProperty(out, '__problems', {
      value: [`${err.message}. ${(err.details || []).join(' ')}`],
      enumerable: false,
    });
    return out;
  }

  // ONLY THE SLOTS THIS STORYBOARD STILL HAS.
  //
  // Every non-superseded manifest entry used to be resolved, verified and
  // folded into the render fingerprint - including entries for slots that no
  // longer exist. Deleting a removed slide's unused image then BLOCKED the
  // render, and editing an unused image invalidated output it has nothing to
  // do with. The manifest keeps its historical records either way; they are
  // simply not inputs to this render.
  const liveSlots = new Set(Object.keys(briefs));

  for (const a of manifest.assets) {
    if (a.superseded_by) continue;
    // A MANIFEST ENTRY MAY NAME ITS SLOT EITHER WAY.
    //
    // Entries written before slots were qualified carry a bare id, and the
    // PO's deck is full of them. A bare id resolves when exactly one slot in
    // the storyboard has it - which is every slot on a deck that predates
    // this change, because a bare id was required to be unique then. An
    // ambiguous one is reported rather than guessed: two slides now legally
    // share `col-1-art`, and silently picking one would put an illustration
    // on the wrong page, which renders cleanly and which lint cannot see.
    const ref = resolveSlotRef(storyboard, a.slot_id);
    if (ref && ref.ambiguous) {
      problems.push(`the asset manifest names slot "${a.slot_id}", and ${ref.ambiguous.length} slides have a slot with that id (${ref.ambiguous.join(', ')}). Re-import it naming the slide: deck gate assets import ${ref.ambiguous[0]} <file>`);
      continue;
    }
    const key = ref ? ref.key : a.slot_id;
    if (!liveSlots.has(key)) continue;

    // CONTAINMENT. `stored_file` is a path out of a JSON file that may have
    // been edited or shared. A crafted manifest pointing at ../../private.png,
    // or at a symlink out of assets/, would place local imagery into the PDF.
    let abs;
    try {
      abs = assertInside(path.resolve(root, a.stored_file), assetsDir,
        `the asset for slot "${a.slot_id}" (${a.stored_file})`);
    } catch (err) {
      problems.push(`slot "${a.slot_id}": ${err.message}. ${(err.details || []).join(' ')}`);
      continue;
    }

    if (!fs.existsSync(abs)) {
      // Previously skipped in silence, so a deleted asset simply rendered as
      // empty space and nothing said why.
      problems.push(`slot "${a.slot_id}": the imported file ${a.stored_file} is missing. Re-import it, or remove the slot.`);
      continue;
    }

    // INTEGRITY. The hash in the manifest is what geometry.json and the export
    // report publish. If the bytes on disk no longer match it, those reports
    // state a provenance that is not true of the image actually in the PDF.
    if (verify) {
      const actual = sha256File(abs);
      if (actual !== a.sha256) {
        problems.push(`slot "${a.slot_id}": ${a.stored_file} has been modified since import. The manifest records ${a.sha256}, the file on disk is ${actual}. deck will not publish the recorded hash for different bytes.`);
        continue;
      }
    }

    out[key] = {
      ...a,
      src: pathToFileURL(abs).href,
      abs,
      // An asset is REUSED when its container moves or resizes, and only
      // re-requested when the brief materially changed. That distinction is
      // the digest below, nothing to do with geometry.
      stale: briefs[key] !== undefined && briefs[key] !== a.brief_digest,
    };
  }

  if (verify && problems.length > 0) {
    throw new DeckError(`${problems.length} asset problem(s)`, EXIT.VERDICT_FAILED, problems);
  }
  Object.defineProperty(out, '__problems', { value: problems, enumerable: false });
  return out;
}

/**
 * EVERY SLOT THAT HAS NO PICTURE IN IT.
 *
 * One answer, derived once, used by three callers that must not disagree:
 * the `slot-fill` lint rule's sibling in `render --release`, `deck gate
 * status --json`, and through that the launcher's `build-cycle` line. The PO's
 * point was exact - seeing `lint_verdict=pass  slots_empty=14` would have
 * caught it on the spot - and that only works if the number beside the
 * verdict is the same number the verdict is about.
 *
 * `reuse_unchanged` is reported separately rather than counted here. deck
 * never generates those, so an outstanding one is the PO's to supply and must
 * not block a preview; it still has to be visible, which is why it is a
 * second list and not a silence.
 *
 * @param {any} storyboard
 * @param {Record<string, any>} assets  as resolveAssets returns them
 * @returns {{empty: {slide: string, slot: string, width_px: number, height_px: number}[],
 *            awaiting_reuse: {slide: string, slot: string}[],
 *            total: number}}
 */
export function slotFillState(storyboard, assets) {
  const empty = [];
  const awaitingReuse = [];
  let total = 0;
  for (const slide of storyboard.slides || []) {
    for (const slot of slide.slots || []) {
      total += 1;
      if (assets[slotKey(slide.id, slot.id)]) continue;
      if (slot.decorative === true) continue;
      if (slot.reuse_unchanged === true) {
        awaitingReuse.push({ slide: slide.id, slot: slot.id });
        continue;
      }
      empty.push({
        slide: slide.id, slot: slot.id, width_px: slot.width_px, height_px: slot.height_px,
      });
    }
  }
  return { empty, awaiting_reuse: awaitingReuse, total };
}

/**
 * A SLOT'S IDENTITY IS (SLIDE, SLOT ID). THE FLAT ID NEVER WAS.
 *
 * `col-1-art` is "the first column's picture" - a position within a page type,
 * not a name for one particular picture in one particular deck. Every
 * standard-3col slide has a first column, so every one of them wants that slot.
 *
 * The flat id was a convenience of `deck assets import <slot-id>`, and it
 * leaked out of the CLI into a uniqueness rule over the whole deck. The
 * consequence was that a deck could carry column art on exactly ONE
 * standard-3col slide. The PO's real deck has four, so twelve illustrations
 * could not be imported and all four pages rendered as empty frames - beside a
 * cover and an agenda that DID have art, which is what made them read as
 * broken images rather than as reserved space.
 *
 * There was no spelling that worked. Theme ids on both slides collide;
 * per-slide ids are refused as unknown to the theme; and adding aliases
 * through theme_overrides passes validate and then silently renders NOTHING,
 * because the template resolved every slide to the first alias.
 *
 * So the key is qualified, and this is the one function that forms it. The
 * separator cannot occur in either half: both ids are matched against
 * ^[a-z0-9][a-z0-9-]{0,62}$ by the schema.
 *
 * @param {string} slideId
 * @param {string} slotId
 */
export function slotKey(slideId, slotId) {
  return `${slideId}:${slotId}`;
}

/**
 * The same pair as a FILENAME token.
 *
 * A colon is legal in a POSIX filename and a bad idea in one - Finder shows it
 * as a slash, and it needs quoting in every shell. Filenames use a hyphen:
 * `04-decided-col-1-art.png`, which is what `prompts --single` asks the PO to
 * name the file and what `inbox` reads back.
 *
 * @param {string} slideId
 * @param {string} slotId
 */
export function slotFileToken(slideId, slotId) {
  return `${slideId}-${slotId}`;
}

/**
 * Resolve what a human or an older manifest wrote to the qualified key.
 *
 * Accepts the qualified form, and a BARE slot id when exactly one slot in the
 * deck has it. The bare form is why `deck assets import cover-art` still works
 * and why a manifest written before this change still resolves - that deck is
 * on the PO's disk right now and must not need re-importing.
 *
 * @param {any} storyboard
 * @param {string} wanted
 * @returns {{key: string, slide: any, slot: any} | {ambiguous: string[]} | null}
 */
export function resolveSlotRef(storyboard, wanted) {
  const all = [];
  for (const slide of storyboard.slides || []) {
    for (const slot of slide.slots || []) {
      all.push({ key: slotKey(slide.id, slot.id), slide, slot });
    }
  }
  const exact = all.find((x) => x.key === wanted);
  if (exact) return exact;
  const bare = all.filter((x) => x.slot.id === wanted);
  if (bare.length === 1) return bare[0];
  if (bare.length > 1) return { ambiguous: bare.map((x) => x.key) };
  return null;
}

/** @param {any} storyboard @returns {Record<string, string>} slot id -> brief digest */
export function slotBriefs(storyboard) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const slide of storyboard.slides) {
    for (const slot of slide.slots || []) out[slotKey(slide.id, slot.id)] = briefDigest(slot);
  }
  return out;
}

/** @param {any} slot */
export function briefDigest(slot) {
  // Only the BRIEF and the reuse flag. Deliberately not width/height: moving
  // or resizing a container must not re-request the illustration.
  return sha256(JSON.stringify({ brief: slot.brief, reuse_unchanged: slot.reuse_unchanged === true }));
}
