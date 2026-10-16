/**
 * TEXT COMPARISON FOR THE VERBATIM GATES.
 *
 * Every check that asks "does this really come from the source?" runs through
 * this module, so the ledger gate, the fidelity gate and the copy sheet cannot
 * drift into three slightly different ideas of what "verbatim" means.
 *
 * Three normalisations, each with a reason:
 *
 *   collapse()   whitespace only. Notion returns a block's text with the line
 *                breaks of whoever typed it; a quote that differs from the
 *                source by a newline is the same quote. Nothing else is
 *                touched, so a changed character is still a changed quote.
 *   digits()     full-width to half-width, for NUMBER comparison only. 1,234
 *                and １２３４ are the same number written by two keyboards.
 *                Never used to compare words.
 *   kanji        十二 and 12 are the same quantity. A source written in kanji
 *                numerals used to BLOCK the arabic slide, and - worse - an
 *                invented kanji quantity was not checked at all.
 *
 * WHAT IS NOT FOLDED, and why it matters:
 *
 *   `、` and `・` are NOT treated as numeric separators. They are list
 *   punctuation: folding 「9月・10月」 or 「1、2、3」 into one number made two
 *   figures into one, and the merged value then matched nothing.
 *
 *   The DECIMAL POINT is preserved. It used to be stripped along with the
 *   grouping comma, which made 1.5 and 15 the same number - so a source
 *   saying 1.5% authorised a slide saying 15%. Only `,` groups; only `.`
 *   divides.
 */

/** @param {string} s */
export function collapse(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * Full-width digits and the two punctuation marks that are genuinely numeric.
 *
 * `，` (U+FF0C) is a full-width comma and `．` (U+FF0E) a full-width period,
 * both of which appear inside numbers. `、` and `・` do not: they separate
 * items in a list, and folding them joined two numbers into one.
 *
 * @param {string} s
 */
export function digits(s) {
  return String(s == null ? '' : s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/，/g, ',')
    .replace(/．/g, '.')
    .replace(/％/g, '%');
}

/**
 * The units that make a short number load-bearing.
 *
 * A single digit in connective prose - 「3つの論点」 - is the agent's own
 * writing and must not have to trace to the source, or the gate would fire on
 * every sentence it wrote. A single digit WITH a unit - 「3件」, 「5%」 - is a
 * claim about the world and must trace. That is the whole reason this list
 * exists rather than a bare digit count.
 */
const UNIT = '%|円|ドル|人|件|日|月|年|週|時間|分|秒|回|倍|割|個|名|社|台|枚|本|点|票|位|度|kg|km|m|cm|GB|MB';
const UNIT_RE = new RegExp(`^(?:${UNIT})`);

/**
 * CANONICAL FORM OF A NUMBER'S DIGITS.
 *
 * Grouping separators go; the decimal point stays. Trailing zeros after a
 * decimal point go, and so do leading zeros, because 1.50, 1.5 and 01.5 are
 * one number written three ways - but 1.5 and 15 are two numbers, and that is
 * the distinction the old version lost.
 *
 * Done textually rather than through Number(), so a long digit string - an
 * order number, a phone number - does not lose precision on the way through.
 *
 * @param {string} raw
 */
export function numericCore(raw) {
  let s = String(raw).replace(/,/g, '');
  if (!s.includes('.')) {
    s = s.replace(/^0+(?=\d)/, '');
    return s;
  }
  let [whole, frac = ''] = s.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  if (whole === '') whole = '0';
  return frac === '' ? whole : `${whole}.${frac}`;
}

/** Kanji digits and the powers they combine with. */
const KANJI_DIGIT = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_SMALL = { 十: 10, 百: 100, 千: 1000 };
const KANJI_LARGE = { 万: 10000, 億: 100000000 };
const KANJI_CHARS = `${Object.keys(KANJI_DIGIT).join('')}${Object.keys(KANJI_SMALL).join('')}${Object.keys(KANJI_LARGE).join('')}`;

/**
 * JAPANESE NUMERALS AS A VALUE.
 *
 * 十二 -> 12, 五十 -> 50, 千二百 -> 1200, 一万三千 -> 13000. Minutes are typed
 * by people, and people write 十二件 as readily as 12件; the gate has to see
 * them as the same quantity in both directions. Without this a kanji source
 * BLOCKED an arabic slide, and an invented kanji quantity passed unchecked
 * because no token was produced for it at all.
 *
 * Returns null for anything this does not confidently understand - 四半期 is
 * a word, not a number - because a wrong value here would be worse than none.
 *
 * @param {string} s
 * @returns {string | null} the canonical digit string, or null
 */
export function kanjiToNumber(s) {
  if (!s || !new RegExp(`^[${KANJI_CHARS}]+$`).test(s)) return null;
  let total = 0;
  let section = 0;
  let digit = 0;
  let sawAny = false;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) {
      digit = KANJI_DIGIT[ch];
      sawAny = true;
    } else if (ch in KANJI_SMALL) {
      // 十 with no digit before it means one ten, as in 十二.
      section += (digit === 0 ? 1 : digit) * KANJI_SMALL[ch];
      digit = 0;
      sawAny = true;
    } else if (ch in KANJI_LARGE) {
      total += (section + digit || 1) * KANJI_LARGE[ch];
      section = 0;
      digit = 0;
      sawAny = true;
    } else {
      return null;
    }
  }
  if (!sawAny) return null;
  return String(total + section + digit);
}

/**
 * Every number in a piece of text, with the unit that follows it.
 *
 * Covers arabic and kanji numerals both, so the two sides of every comparison
 * speak one language.
 *
 * `at`/`end` are offsets into the NORMALISED text, so a caller can tell which
 * numbers are part of a larger thing: a date owns its own digits, and
 * reporting them twice made one wrong date into two findings.
 *
 * @param {string} text
 * @returns {{raw: string, core: string, unit: string, at: number, end: number, loadBearing: boolean, script: 'arabic' | 'kanji'}[]}
 */
export function numericTokens(text) {
  const norm = digits(text);
  /** @type {{raw: string, core: string, unit: string, at: number, end: number, loadBearing: boolean, script: 'arabic' | 'kanji'}[]} */
  const out = [];

  const re = /\d(?:[\d,.]*\d)?/g;
  for (let m = re.exec(norm); m; m = re.exec(norm)) {
    const raw = m[0];
    // A trailing separator belongs to the sentence, not to the number.
    const trimmed = raw.replace(/[.,]+$/, '');
    if (!trimmed) continue;
    const after = norm.slice(m.index + raw.length);
    const unitMatch = UNIT_RE.exec(after);
    const unit = unitMatch ? unitMatch[0] : '';
    const core = numericCore(trimmed);
    out.push({
      raw: trimmed,
      core,
      unit,
      at: m.index,
      end: m.index + raw.length,
      // Two digits is enough to be a claim on its own; one digit needs a unit.
      // A decimal is always a claim: nobody writes 1.5 as connective prose.
      loadBearing: core.replace(/[^0-9]/g, '').length >= 2 || core.includes('.') || unit !== '',
      script: 'arabic',
    });
  }

  const kre = new RegExp(`[${KANJI_CHARS}]+`, 'g');
  for (let m = kre.exec(norm); m; m = kre.exec(norm)) {
    const value = kanjiToNumber(m[0]);
    if (value === null) continue;
    const after = norm.slice(m.index + m[0].length);
    const unitMatch = UNIT_RE.exec(after);
    const unit = unitMatch ? unitMatch[0] : '';
    // 一つ, 二人 and the like are the agent counting in prose, exactly as a
    // bare arabic digit is, so the same threshold applies.
    out.push({
      raw: m[0],
      core: value,
      unit,
      at: m.index,
      end: m.index + m[0].length,
      loadBearing: value.length >= 2 || unit !== '',
      script: 'kanji',
    });
  }
  return out;
}

/**
 * EVERY DATE IN A PIECE OF TEXT, AS ONE CANONICAL TOKEN PER OCCURRENCE.
 *
 * Dates get their own check because their individual numbers are too small to
 * catch on their own: a source containing 10件 and 14人 would make up the
 * digits of 10月14日 without ever containing that date.
 *
 * ONE TOKEN PER OCCURRENCE, and that is the fix for a false refusal that fired
 * on ordinary decks. The old version ran four independent patterns over the
 * text, so 2026年10月14日 produced THREE overlapping tokens - the full date,
 * the year-month and the month-day - while 2026-10-14 produced one. A source
 * written with hyphens and a slide written in Japanese therefore disagreed
 * about the same date, and the slide was blocked twice for it.
 *
 * Now the scan is single-pass and longest-match-first, so each written date
 * yields exactly the form it states. The SOURCE side additionally vouches for
 * the less specific forms it implies (see impliedDateForms), which is the safe
 * direction: a source saying 2026年10月14日 covers a slide saying 10月14日,
 * and a source saying only 10月14日 does NOT cover a slide that has invented
 * the year.
 *
 * @param {string} text
 * @returns {{raw: string, normal: string, at: number, end: number}[]}
 */
export function dateTokens(text) {
  const norm = digits(text);
  /** @type {{raw: string, normal: string, at: number, end: number}[]} */
  const out = [];
  // Longest first, and alternation in one regex so matches cannot overlap.
  const re = new RegExp([
    '(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日',
    '(\\d{4})[/-](\\d{1,2})[/-](\\d{1,2})',
    '(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月',
    '(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日',
  ].join('|'), 'g');
  for (let m = re.exec(norm); m; m = re.exec(norm)) {
    const parts = m.slice(1).filter((x) => x !== undefined).map((x) => String(Number(x)));
    out.push({
      raw: m[0], normal: parts.join('-'), at: m.index, end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * The less specific forms a written date also vouches for.
 *
 * Only ever applied to the SOURCE side. 2026-10-14 implies 2026-10 and 10-14;
 * 10-14 implies nothing, so a slide cannot acquire a year from it.
 *
 * @param {string} normal
 * @returns {string[]}
 */
export function impliedDateForms(normal) {
  const parts = normal.split('-');
  if (parts.length === 3) {
    return [normal, `${parts[0]}-${parts[1]}`, `${parts[1]}-${parts[2]}`];
  }
  return [normal];
}

/**
 * Everything a source text can vouch for, prepared once per run.
 * @param {string} text
 */
export function sourceIndex(text) {
  const flat = collapse(text);
  const cores = new Set(numericTokens(flat).map((t) => t.core));
  const dates = new Set();
  for (const d of dateTokens(flat)) {
    for (const form of impliedDateForms(d.normal)) dates.add(form);
  }
  return {
    text: flat,
    /** @param {string} q */
    hasQuote(q) {
      return flat.includes(collapse(q));
    },
    /** @param {string} core */
    hasNumber(core) {
      return cores.has(numericCore(core));
    },
    /** @param {string} normal */
    hasDate(normal) {
      return dates.has(normal);
    },
    numberCount: cores.size,
    dateCount: dates.size,
  };
}

/**
 * The union of several sources, for a storyboard built from more than one.
 * @param {{id: string, text: string}[]} sources
 */
export function combinedIndex(sources) {
  const parts = sources.map((s) => ({ id: s.id, index: sourceIndex(s.text) }));
  const byId = new Map(parts.map((p) => [p.id, p.index]));
  return {
    parts,
    /**
     * The index of ONE named source, for a check that must not be satisfied
     * by a different source carrying the same words.
     * @param {string} id
     */
    forSource(id) {
      return byId.get(id) || null;
    },
    /** @param {string} q @returns {string | null} the source id that contains it */
    quoteFrom(q) {
      const hit = parts.find((p) => p.index.hasQuote(q));
      return hit ? hit.id : null;
    },
    /** @param {string} q @returns {string[]} every source id containing it */
    quoteFoundIn(q) {
      return parts.filter((p) => p.index.hasQuote(q)).map((p) => p.id);
    },
    /** @param {string} core */
    hasNumber(core) {
      return parts.some((p) => p.index.hasNumber(core));
    },
    /** @param {string} normal */
    hasDate(normal) {
      return parts.some((p) => p.index.hasDate(normal));
    },
  };
}

/**
 * Is this table cell the same data as something in the source?
 *
 * A table cell is held to the whole-cell standard, but "the whole cell" has to
 * mean the same cell written with a different keyboard: full-width digits, a
 * grouping comma added or removed, and kanji numerals are all the same data.
 * Comparing the literal characters rejected harmless reformatting.
 *
 * @param {string} cell
 * @param {ReturnType<typeof combinedIndex>} index
 * @returns {string | null} the source id it was found in, or null
 */
export function cellFoundIn(cell, index) {
  const direct = index.quoteFrom(cell);
  if (direct) return direct;
  // Compare on a numeric skeleton: the cell's non-numeric characters in order,
  // plus its numbers in canonical form. A source line matches when it has the
  // same words and the same numbers, however either side wrote them.
  const want = cellSkeleton(cell);
  if (!want) return null;
  for (const part of index.parts) {
    if (part.index.text.split(/[\n|]/).some((line) => cellSkeleton(line) === want)) return part.id;
    // Notion tables arrive as rows of cells, so the cell may also sit inside a
    // longer line among its neighbours.
    if (part.index.text.split(/[|、,]/).some((piece) => cellSkeleton(piece) === want)) return part.id;
  }
  return null;
}

/** @param {string} s */
function cellSkeleton(s) {
  const flat = collapse(digits(s));
  if (!flat) return null;
  const numbers = numericTokens(flat).map((t) => t.core).join('|');
  const words = flat.replace(new RegExp(`[0-9,.${KANJI_CHARS}\\s]`, 'g'), '');
  return `${words}#${numbers}`;
}
