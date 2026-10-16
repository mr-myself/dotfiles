import { sha256 } from './util/fs.js';

/**
 * Content digests.
 *
 * Approval has to survive reformatting but never survive an edit to the words.
 * So the digest is taken over a CANONICAL projection of the storyboard, not
 * over the file bytes: re-indenting the YAML or reordering two keys inside a
 * slide must not invalidate the PO's approval, while changing a character of
 * `title`, reordering the slides, or adding one must.
 *
 * Two digests, because they answer different questions:
 *
 *   agenda digest   the deck's spine: slide ids, order, page types, titles.
 *                   This is what `deck approve agenda` signs off.
 *   content digest  everything verbatim the renderer is forbidden to alter:
 *                   titles, subtitles, body, table cells, speaker notes.
 *                   This is what `deck approve content` signs off.
 *
 * Theme and layout are in NEITHER, because the PO decided that changing the
 * theme invalidates rendered output but not content approval.
 */

/**
 * JSON with object keys sorted recursively, so key order in the YAML cannot
 * move the digest. Arrays keep their order - slide order is content.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** @param {unknown} v @returns {unknown} */
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  // `undefined` and `null` are NOT the same thing here. `subtitle: null` means
  // an intentionally absent subtitle, and it is part of the signed content:
  // back-filling it later must break approval.
  return v === undefined ? null : v;
}

/**
 * THE AGENDA ARTIFACT THE PO ACTUALLY REVIEWED.
 *
 * `agendaDigest` below hashes the storyboard's SPINE - slide ids, order, page
 * types, titles - and that was the only thing `approve agenda` recorded. But
 * the agenda gate runs BEFORE the agent writes the storyboard: at that point
 * the storyboard is still the scaffold `deck init` produced, so every normal
 * run approved the scaffold and then invalidated the approval the moment the
 * first real title was written. The PO saw their agenda approval evaporate on
 * every single deck.
 *
 * What they reviewed is agenda.json: the items, why each one is there, what
 * the agent wants out of the room, which ledger entries it rests on, and -
 * the half that makes the review meaningful - WHAT IS BEING LEFT OUT AND WHY.
 * So that is what gets hashed.
 *
 * The exclusions are in the digest deliberately. An agenda whose exclusion
 * list has quietly changed is a different agenda, even if the items are
 * identical: the PO agreed to leave those things out for those reasons.
 *
 * `missing_evidence` is in too, for the same reason - it is a statement about
 * what the deck cannot support, and the PO signed off knowing it.
 *
 * @param {any} agenda the parsed agenda.json
 */
export function agendaArtifactProjection(agenda) {
  return {
    meeting: {
      name: nullable(agenda.meeting?.name),
      when: nullable(agenda.meeting?.when),
      purpose: nullable(agenda.meeting?.purpose),
      audience: nullable(agenda.meeting?.audience),
    },
    items: (agenda.items || []).map((it, i) => ({
      index: i,
      id: it.id,
      heading: it.heading,
      why: it.why,
      wants: it.wants === undefined ? null : it.wants,
      ledger_refs: [...(it.ledger_refs || [])],
    })),
    excluded: (agenda.excluded || []).map((ex, i) => ({
      index: i,
      ledger_refs: [...(ex.ledger_refs || [])],
      reason: ex.reason,
    })),
    missing_evidence: (agenda.missing_evidence || []).map((m, i) => ({
      index: i, what: m.what, why: m.why,
    })),
  };
}

/** @param {any} agenda */
export function agendaArtifactDigest(agenda) {
  return sha256(canonicalJson({ kind: 'deck.agenda-artifact/1', agenda: agendaArtifactProjection(agenda) }));
}

/**
 * Which agenda field moved, for an approval that no longer matches.
 * @param {any} before @param {any} after
 * @returns {string[]}
 */
export function describeAgendaChanges(before, after) {
  /** @type {string[]} */
  const changes = [];
  const m = (k) => {
    if (JSON.stringify(before.meeting?.[k]) !== JSON.stringify(after.meeting?.[k])) {
      changes.push(`the meeting's ${k} changed`);
    }
  };
  for (const k of ['name', 'when', 'purpose', 'audience']) m(k);

  const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
  const b = byId(before.items);
  const a = byId(after.items);
  for (const [id, item] of a) {
    const was = b.get(id);
    if (!was) { changes.push(`agenda item "${id}" is new`); continue; }
    for (const k of ['heading', 'why', 'wants']) {
      if (JSON.stringify(was[k]) !== JSON.stringify(item[k])) changes.push(`agenda item "${id}": ${k} changed`);
    }
    if (JSON.stringify(was.ledger_refs) !== JSON.stringify(item.ledger_refs)) {
      changes.push(`agenda item "${id}": the ledger entries it rests on changed`);
    }
    if (was.index !== item.index) changes.push(`agenda item "${id}" moved from position ${was.index + 1} to ${item.index + 1}`);
  }
  for (const id of b.keys()) if (!a.has(id)) changes.push(`agenda item "${id}" was removed`);

  const exKey = (x) => `${(x.ledger_refs || []).join('+')}`;
  const bEx = new Map((before.excluded || []).map((x) => [exKey(x), x]));
  const aEx = new Map((after.excluded || []).map((x) => [exKey(x), x]));
  for (const [k, ex] of aEx) {
    const was = bEx.get(k);
    if (!was) { changes.push(`${k} is newly EXCLUDED from the agenda: ${ex.reason}`); continue; }
    if (was.reason !== ex.reason) changes.push(`the reason for excluding ${k} changed`);
  }
  for (const [k] of bEx) if (!aEx.has(k)) changes.push(`${k} is no longer excluded, so it is back in scope`);

  if (JSON.stringify(before.missing_evidence) !== JSON.stringify(after.missing_evidence)) {
    changes.push('the list of missing evidence changed');
  }
  return changes;
}

/**
 * The spine: identity, order and headline of every slide.
 * @param {any} storyboard
 * @returns {string}
 */
export function agendaDigest(storyboard) {
  const projection = (storyboard.slides || []).map((s, i) => ({
    index: i,
    id: s.id,
    page_type: s.page_type,
    title: s.title === undefined ? null : s.title,
  }));
  return sha256(canonicalJson({ kind: 'deck.agenda/1', slides: projection }));
}

/**
 * Everything the renderer must reproduce verbatim.
 * @param {any} storyboard
 * @returns {string}
 */
export function contentDigest(storyboard) {
  const projection = (storyboard.slides || []).map((s, i) => ({
    index: i,
    id: s.id,
    page_type: s.page_type,
    title: nullable(s.title),
    subtitle: nullable(s.subtitle),
    section_label: nullable(s.section_label),
    body: s.body === undefined ? null : s.body,
    table: s.table === undefined ? null : s.table,
    // AGENDA IS RENDERED CONTENT. It was omitted here once, and the effect was
    // that rewording, inserting, deleting or reordering an agenda item - or
    // moving which item is active - left the content digest unchanged and
    // `--release` happily shipped words nobody had approved. Agenda items are
    // verbatim text on a slide exactly as a title is.
    agenda: s.agenda === undefined ? null : s.agenda,
    footer: s.footer === undefined ? null : s.footer,
    speaker_notes: nullable(s.speaker_notes),
    // Slot IDENTITY and BRIEF are content: a changed brief means a different
    // illustration must be asked for. Slot geometry is layout and is excluded
    // from CONTENT, but it IS in the render fingerprint below, so resizing a
    // slot still invalidates rendered output.
    slots: (s.slots || []).map((sl) => ({
      id: sl.id,
      brief: nullable(sl.brief),
      reuse_unchanged: sl.reuse_unchanged === true,
    })),
    source_refs: s.source_refs === undefined ? null : s.source_refs,
  }));
  return sha256(canonicalJson({
    kind: 'deck.content/1',
    title: nullable(storyboard.title),
    slides: projection,
  }));
}

/** @param {unknown} v */
function nullable(v) {
  return v === undefined ? null : v;
}

/**
 * Describe what moved between two storyboards, so `deck render --release` can
 * say WHAT changed rather than only that something did.
 * @param {any} approved the storyboard as approved (projection form)
 * @param {any} current
 * @returns {string[]} human lines, empty when nothing relevant differs
 */
export function describeContentChanges(approved, current) {
  /** @type {string[]} */
  const lines = [];
  const a = indexSlides(approved);
  const c = indexSlides(current);

  if (approved.slides.length !== current.slides.length) {
    lines.push(`slide count: approved ${approved.slides.length}, now ${current.slides.length}`);
  }
  const approvedOrder = approved.slides.map((s) => s.id).join(',');
  const currentOrder = current.slides.map((s) => s.id).join(',');
  if (approvedOrder !== currentOrder) {
    lines.push(`slide order changed:\n    approved: ${approvedOrder || '(none)'}\n    now:      ${currentOrder || '(none)'}`);
  }
  for (const id of Object.keys(a)) {
    if (!(id in c)) lines.push(`slide removed: ${id}`);
  }
  for (const id of Object.keys(c)) {
    if (!(id in a)) lines.push(`slide added: ${id}`);
  }
  for (const id of Object.keys(c)) {
    if (!(id in a)) continue;
    for (const field of Object.keys({ ...a[id], ...c[id] })) {
      if (field === 'index' || field === 'id') continue;
      const before = canonicalJson(a[id][field] ?? null);
      const after = canonicalJson(c[id][field] ?? null);
      if (before !== after) {
        lines.push(`slide ${id}: ${field} changed\n    approved: ${truncate(before)}\n    now:      ${truncate(after)}`);
      }
    }
  }
  return lines;
}

/** @param {any} projection */
function indexSlides(projection) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const s of projection.slides || []) out[s.id] = s;
  return out;
}

/** @param {string} s */
function truncate(s) {
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/**
 * The projection stored alongside an approval, so a later `--release` can say
 * what changed rather than only that the digest differs.
 * @param {any} storyboard
 */
export function contentProjection(storyboard) {
  return {
    title: nullable(storyboard.title),
    slides: (storyboard.slides || []).map((s, i) => ({
      index: i,
      id: s.id,
      page_type: s.page_type,
      title: nullable(s.title),
      subtitle: nullable(s.subtitle),
      section_label: nullable(s.section_label),
      body: s.body === undefined ? null : s.body,
      table: s.table === undefined ? null : s.table,
      agenda: s.agenda === undefined ? null : s.agenda,
      footer: s.footer === undefined ? null : s.footer,
      speaker_notes: nullable(s.speaker_notes),
      slots: (s.slots || []).map((sl) => ({
        id: sl.id, brief: nullable(sl.brief), reuse_unchanged: sl.reuse_unchanged === true,
      })),
      source_refs: s.source_refs === undefined ? null : s.source_refs,
    })),
  };
}

/**
 * THE RENDER FINGERPRINT.
 *
 * The content digest answers "are these the approved words?" and deliberately
 * excludes the theme, the CSS, layout line breaks, slot geometry and which
 * asset fills a slot - because changing any of those must NOT invalidate a
 * content approval.
 *
 * But all of them change what the rendered page looks like. Keying output
 * freshness off the content digest therefore marked geometry, PDFs, PNGs and
 * lint reports as current after a theme edit that had moved every box on
 * every page. This is the second digest, and it covers everything that can
 * change a pixel:
 *
 *   the content digest        the words
 *   layout line breaks        where a title wraps
 *   slot geometry             the reserved boxes
 *   page types and variants   which template ran
 *   the theme's identity      name, version AND its full token set
 *   the theme's CSS bytes     arrangement, not just tokens
 *   the resolved assets       which file, by hash, filled which slot
 *   the render scale          what the PNGs are
 *
 * `deck lint` refuses geometry whose fingerprint does not match, and `deck
 * export` refuses a lint report that inspected a different render.
 *
 * @param {object} input
 * @param {any} input.storyboard
 * @param {any} input.theme          the merged, resolved theme
 * @param {string} input.themeCss    the stylesheet's bytes
 * @param {Record<string, {sha256: string}>} input.assets slot id -> asset
 * @param {number} input.scale
 * @param {object} input.options the resolved output options (see renderOptions)
 * @returns {string}
 */
export function renderFingerprint({ storyboard, theme, themeCss, assets, scale, options }) {
  const layout = (storyboard.slides || []).map((s, i) => ({
    index: i,
    id: s.id,
    page_type: s.page_type,
    variant: nullable(s.variant),
    line_breaks_after: s.line_breaks_after === undefined ? null : s.line_breaks_after,
    slots: (s.slots || []).map((sl) => ({
      id: sl.id,
      width_px: sl.width_px,
      height_px: sl.height_px,
      decorative: sl.decorative === true,
      reuse_unchanged: sl.reuse_unchanged === true,
    })),
  }));
  return sha256(canonicalJson({
    kind: 'deck.render/1',
    content: contentDigest(storyboard),
    layout,
    theme: {
      name: theme.name,
      version: nullable(theme.version),
      // The whole token set, not just its name: a theme edited in place has
      // the same name and a different layout.
      tokens: stripInternal(theme),
      css: sha256(themeCss),
    },
    assets: Object.fromEntries(
      Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))
        .map(([slot, a]) => [slot, a.sha256]),
    ),
    scale,
    options: options ?? null,
  }));
}

/**
 * THE ONE PLACE the render's output options are resolved.
 *
 * render, lint and export all need the same answer, and deriving it three
 * times is how they came to disagree. Anything added here is automatically in
 * the fingerprint, because renderFingerprint takes this object whole.
 *
 * @param {any} request the parsed deck.yaml
 * @param {any} theme
 */
export function renderOptions(request, theme) {
  const out = request?.request?.output || {};
  return {
    page_numbers: out.page_numbers !== false,
    png_scale: out.png_scale ?? theme.canvas.render_scale ?? 2,
  };
}

/** The theme without the `__`-prefixed fields the loader attaches. */
function stripInternal(theme) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(theme)) {
    if (!k.startsWith('__')) out[k] = v;
  }
  return out;
}
