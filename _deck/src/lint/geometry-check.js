/**
 * STRUCTURAL VALIDATION OF MEASURED GEOMETRY, before any rule runs.
 *
 * geometry.json was parsed as JSON and then trusted. It is a file on disk
 * that a previous deck version can have written, that a partial write can
 * have truncated, or that a future collector bug can get wrong - and every
 * rule is written to skip what it cannot measure, so absent data produced
 * silence rather than failure.
 *
 * Reproduced: replacing `slides` with an empty array gave "verdict: pass,
 * slides checked: 0, rules run: 9/9". Missing centre coordinates do the same
 * by another route - every comparison becomes NaN, and `NaN > 2` is false.
 *
 * DRIVEN BY THE RULES' OWN DECLARATIONS. A hand-written list of fields to
 * check drifted from what the rules actually read: it validated `canvas` and
 * `content-region` but not a custom reference region a placement contract
 * named, and `overflow.scroll_w` but not `client_w`. Eight of nine malformed
 * cases passed. Each rule now exports a READS declaration and this validates
 * exactly the union of them, so a rule cannot quietly depend on a field
 * nothing checks - and adding a rule that reads something new either
 * declares it or is the next thing to fix here.
 *
 * Anything wrong BLOCKS. A gate that cannot see its subject must say so.
 */

/** The fill states the renderer may record on a slot box. */
const SLOT_STATES = new Set(['filled', 'empty', 'reuse']);

/** A separator no slide id can contain, for comparing id lists as one string. */
const SEP = String.fromCharCode(0);

/** Fields every measured rectangle must carry, as finite numbers. */
const RECT_FIELDS = ['x', 'y', 'w', 'h', 'cx', 'cy'];

/**
 * Merge every rule's READS into one requirement set.
 * @param {{id: string, reads?: object}[]} rules
 */
function mergeReads(rules) {
  /** @type {{rects: Set<string>, optionalRects: Set<string>, numbers: Set<string>, optionalNumbers: Set<string>, nested: Map<string, Set<string>>, textLines: boolean, clippingAncestorRects: boolean, referencedRegions: boolean, backing: boolean}} */
  const merged = {
    rects: new Set(),
    optionalRects: new Set(),
    numbers: new Set(),
    optionalNumbers: new Set(),
    nested: new Map(),
    textLines: false,
    clippingAncestorRects: false,
    referencedRegions: false,
    backing: false,
    slotState: false,
  };
  for (const rule of rules) {
    const reads = rule.reads;
    if (!reads) continue;
    for (const raw of reads.rects || []) {
      const optional = raw.endsWith('?');
      const name = optional ? raw.slice(0, -1) : raw;
      (optional ? merged.optionalRects : merged.rects).add(name);
    }
    for (const raw of reads.numbers || []) {
      const optional = raw.endsWith('?');
      const name = optional ? raw.slice(0, -1) : raw;
      (optional ? merged.optionalNumbers : merged.numbers).add(name);
    }
    for (const [obj, fields] of Object.entries(reads.nested || {})) {
      if (!merged.nested.has(obj)) merged.nested.set(obj, new Set());
      for (const f of fields) merged.nested.get(obj).add(f);
    }
    merged.textLines = merged.textLines || Boolean(reads.textLines);
    merged.clippingAncestorRects = merged.clippingAncestorRects || Boolean(reads.clippingAncestorRects);
    merged.referencedRegions = merged.referencedRegions || Boolean(reads.referencedRegions);
    merged.backing = merged.backing || Boolean(reads.backing);
    merged.slotState = merged.slotState || Boolean(reads.slotState);
  }
  // A rect that ANY rule requires outright is required, even if another rule
  // treats it as optional.
  for (const name of merged.rects) merged.optionalRects.delete(name);
  for (const name of merged.numbers) merged.optionalNumbers.delete(name);
  return merged;
}

/**
 * @param {any} geometry the parsed geometry.json
 * @param {any} storyboard
 * @param {{id: string, reads?: object}[]} [rules] defaults to the real rule set
 * @returns {string[]} problems, empty when the geometry is usable
 */
export function checkGeometry(geometry, storyboard, rules) {
  /** @type {string[]} */
  const problems = [];

  if (!Array.isArray(geometry.slides)) {
    return ['geometry.json has no slides array, so there is nothing to lint'];
  }

  const expected = storyboard.slides.map((s) => s.id);
  const measured = geometry.slides.map((s) => s && s.slide_id);

  if (measured.length !== expected.length) {
    problems.push(`geometry.json measured ${measured.length} slide(s) but the storyboard has ${expected.length}.${measured.length === 0 ? ' A lint run over zero slides is not a pass.' : ''}`);
  }
  if (measured.join(SEP) !== expected.join(SEP)) {
    problems.push(`the measured slides do not match the storyboard.\n    storyboard: ${expected.join(', ') || '(none)'}\n    measured:   ${measured.join(', ') || '(none)'}`);
  }
  // Identity is wrong, so per-slide checks would pile noise on top of it.
  if (problems.length > 0) return problems;

  const reads = mergeReads(rules || defaultRules());

  geometry.slides.forEach((slide, i) => {
    const where = `slide ${i + 1} ("${slide.slide_id}")`;
    if (slide.error) {
      problems.push(`${where} records a measurement error: ${slide.error}`);
      return;
    }
    if (!slide.regions || typeof slide.regions !== 'object') {
      problems.push(`${where} has no measured regions, so no placement contract can be checked`);
      return;
    }
    for (const required of ['canvas', 'content-region']) {
      const r = slide.regions[required];
      if (!r) {
        problems.push(`${where} is missing the "${required}" region`);
        continue;
      }
      const bad = badRect(r);
      if (bad) problems.push(`${where}: region "${required}" has ${bad}`);
    }
    if (!Array.isArray(slide.elements)) {
      problems.push(`${where} has no elements array`);
      return;
    }
    if (slide.elements.length === 0) {
      problems.push(`${where} measured zero elements; a slide that renders nothing is not a slide that passes`);
    }

    slide.elements.forEach((el, j) => {
      const id = el && el.id ? `"${el.id}"` : `#${j + 1}`;
      const at = `${where}: element ${id}`;
      if (!el || typeof el !== 'object') {
        problems.push(`${at} is not an object`);
        return;
      }
      if (!el.id) problems.push(`${at} has no id`);

      for (const name of reads.rects) {
        const bad = badRect(el[name]);
        if (bad) problems.push(`${at} has ${name} with ${bad}`);
      }
      for (const name of reads.optionalRects) {
        if (el[name] === null || el[name] === undefined) continue;
        const bad = badRect(el[name]);
        if (bad) problems.push(`${at} has a ${name} with ${bad}`);
      }
      for (const name of reads.numbers) {
        if (!Number.isFinite(el[name])) {
          problems.push(`${at} has ${name} = ${JSON.stringify(el[name])}, which is not a finite number`);
        }
      }
      for (const name of reads.optionalNumbers) {
        if (el[name] === undefined) continue;
        if (!Number.isFinite(el[name])) {
          problems.push(`${at} has ${name} = ${JSON.stringify(el[name])}, which is not a finite number`);
        }
      }
      for (const [obj, fields] of reads.nested) {
        if (!el[obj] || typeof el[obj] !== 'object') {
          problems.push(`${at} has no ${obj} measurements`);
          continue;
        }
        for (const f of fields) {
          if (!Number.isFinite(el[obj][f])) {
            problems.push(`${at} has ${obj}.${f} = ${JSON.stringify(el[obj][f])}, which is not a finite number`);
          }
        }
      }

      if (reads.textLines) {
        if (!Array.isArray(el.text_lines)) {
          problems.push(`${at} has no text_lines array`);
        } else {
          el.text_lines.forEach((line, k) => {
            const bad = badRect(line);
            if (bad) problems.push(`${at} text line ${k + 1} has ${bad}`);
          });
        }
      }

      if (reads.clippingAncestorRects) {
        if (!Array.isArray(el.clipping_ancestors)) {
          problems.push(`${at} has no clipping_ancestors array`);
        } else {
          el.clipping_ancestors.forEach((anc, k) => {
            const bad = badRect(anc && anc.rect);
            if (bad) problems.push(`${at} clipping ancestor ${k + 1} (${anc && anc.element}) has ${bad}`);
          });
        }
      }

      // A SLOT THAT RENDERED WITHOUT RECORDING WHETHER IT HAS A PICTURE.
      //
      // The slot-fill rule reads this field and skips what it cannot measure,
      // like every rule here - so a collector that stopped writing it would
      // turn "14 slots empty" into "0 findings, verdict pass", which is the
      // exact failure that rule exists to end. Validating it means the
      // missing measurement blocks instead.
      if (reads.slotState && el.slot) {
        if (!SLOT_STATES.has(el.slot_state)) {
          problems.push(`${at} carries data-deck-slot="${el.slot}" but slot_state is ${JSON.stringify(el.slot_state)}, not one of ${[...SLOT_STATES].join(', ')}. Whether a slot has its picture cannot be left unmeasured.`);
        }
      }

      if (reads.backing) {
        if (!el.backing || typeof el.backing !== 'object') {
          problems.push(`${at} has no backing measurement, so its contrast cannot be resolved`);
        } else {
          const c = el.backing.composited;
          const badChannel = !c || typeof c !== 'object'
            ? 'no composited colour'
            : ['r', 'g', 'b'].filter((ch) => !Number.isFinite(c[ch]));
          if (typeof badChannel === 'string' || badChannel.length > 0) {
            problems.push(`${at} has a backing with ${typeof badChannel === 'string' ? badChannel : `a non-finite ${badChannel.join(', ')} channel`}`);
          }
          // Reported AND returned, not reported and then iterated: a
          // validator that throws on malformed input replaces a clean block
          // with an unhandled TypeError out of `deck lint`.
          const stack = el.backing.stack === undefined ? [] : el.backing.stack;
          if (!Array.isArray(stack)) {
            problems.push(`${at} has a backing.stack that is not an array`);
            return;
          }
          for (const [k, entry] of stack.entries()) {
            if (!Number.isFinite(entry && entry.opacity)) {
              problems.push(`${at} backing layer ${k + 1} has opacity = ${JSON.stringify(entry && entry.opacity)}, which is not a finite number`);
            }
          }
        }
      }

      // EVERY REGION A PLACEMENT CONTRACT NAMES. Validating only the two
      // standard regions left a custom one - an agenda badge, say - able to
      // carry undefined coordinates, and the comparison then yielded NaN.
      if (reads.referencedRegions && el.placement && typeof el.placement === 'object') {
        const ref = el.placement.reference;
        if (typeof ref === 'string' && ref) {
          const region = slide.regions[ref];
          if (!region) {
            // Centring reports this itself, as an `unsupported` finding with
            // the list of known regions, which is the more useful message.
            // Not duplicated here.
          } else {
            const bad = badRect(region);
            if (bad) problems.push(`${at} is placed against region "${ref}", which has ${bad}`);
          }
        }
      }
    });
  });

  return problems;
}

/** The real rule set, imported lazily to keep this module free of cycles. */
let cachedRules = null;
function defaultRules() {
  if (!cachedRules) {
    throw new Error('checkGeometry needs the rule set; call setRuleSet() or pass it in');
  }
  return cachedRules;
}

/**
 * Hand the validator the rule set.
 *
 * The engine calls this at import time. It is a setter rather than an import
 * because engine.js imports every rule AND this module, and importing the
 * engine from here would be a cycle.
 *
 * @param {{id: string, reads?: object}[]} rules
 */
export function setRuleSet(rules) {
  cachedRules = rules;
}

/**
 * @param {any} r
 * @returns {string | null} a description of what is wrong, or null
 */
function badRect(r) {
  if (!r || typeof r !== 'object') return 'no measured rectangle';
  const missing = RECT_FIELDS.filter((f) => !(f in r));
  if (missing.length > 0) return `a rectangle missing ${missing.join(', ')}`;
  const nonFinite = RECT_FIELDS.filter((f) => !Number.isFinite(r[f]));
  if (nonFinite.length > 0) {
    return `a rectangle whose ${nonFinite.join(', ')} ${nonFinite.length === 1 ? 'is' : 'are'} not a finite number (${nonFinite.map((f) => `${f}=${JSON.stringify(r[f])}`).join(', ')})`;
  }
  return null;
}
