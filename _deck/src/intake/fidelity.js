import { requiredText } from '../lint/rules/content-integrity.js';
import { loadSourceTexts } from './sources.js';
import { cellFoundIn, collapse, combinedIndex, dateTokens, numericTokens } from './text.js';
import { readLedger } from './ledger.js';

/**
 * THE FIDELITY GATE: source -> storyboard.
 *
 * `deck lint`'s content-integrity rule checks storyboard -> rendered DOM: the
 * words that were approved are the words on the page. This is the OTHER half,
 * and nothing checked it before: the words in the storyboard trace back to the
 * source. Between them, a number cannot change anywhere along the path from
 * the minutes to the PDF.
 *
 * It enumerates the storyboard's rendered fragments through the SAME
 * requiredText() the lint rule uses, so the two gates cannot disagree about
 * what the PO will see on the slide.
 *
 * WHAT IT CHECKS
 *
 *   numbers   every load-bearing number on a slide occurs in some source.
 *             "Load-bearing" is two or more digits, or any number carrying a
 *             unit - see text.js for why 「3つの論点」 is not checked and
 *             「3件」 is. The comparison is on the digit core, so 1,234 and
 *             1234 are the same number and 1,235 is not.
 *   dates     every date FORM occurs in some source. Checked as a whole form
 *             rather than as its digits, because a source containing 10件 and
 *             14人 would otherwise vouch for 10月14日.
 *   tables    every table cell containing a digit must be verbatim from a
 *             source. A table is where a number goes to be read as data, so
 *             the bar is higher there than for prose: the whole cell, not the
 *             number inside it.
 *   finished  a slide fragment may not describe a PENDING action with a
 *             completion word. This one is a HEURISTIC and is reported as a
 *             warning rather than a block - see below.
 *
 * WHAT IT CANNOT CHECK, stated so nobody mistakes a pass for a proof:
 *
 *   - ARITHMETIC. If the source says 40件 and 100件 and the agent writes 40%,
 *     the digits 40 are in the source and this gate passes. It catches digits
 *     that appear NOWHERE, not sums the agent computed.
 *   - MEANING. A number lifted from the right sentence into the wrong claim is
 *     verbatim and passes.
 *   - The completion check is word-matching, not comprehension. It fires on
 *     「完了」 next to a pending action's wording; it cannot see a sentence
 *     that implies completion without using any of these words. It is a
 *     warning for exactly that reason - blocking on a heuristic would teach
 *     the agent to word around it, which is worse than not having it. It also
 *     cannot tell an assertion from an adjective, which is why the handful of
 *     compounds that are never a completion claim are listed by name below
 *     rather than guessed at.
 */

/** Words that assert a thing is finished. Deliberately short and literal. */
const DONE_WORDS = ['完了', '対応済', '済み', '解決済', 'クローズ', '完結', '終了'];

/**
 * WORDS THAT CONTAIN A DONE WORD WITHOUT ASSERTING ANYTHING IS FINISHED.
 *
 * 「済み」 matches inside 「PMS導入済み」, which is not a claim that an open
 * action was completed - it is an ADJECTIVE describing which facilities
 * already run the system, and it is how the PO's whole deck refers to that
 * group. It fired three or four times on every run, against ledger entries it
 * merely shared some wording with, and a warning that is wrong every time is
 * one the reader learns to scroll past - which costs the warnings that are
 * right.
 *
 * Each entry is a longer string containing a DONE_WORD. A fragment is
 * searched for these first and they are blanked out, so 「導入済み施設では完了
 * していない」 still fires on 完了 while 「PMS導入済みの施設」 does not fire at
 * all. Suppressing the FRAGMENT when any of these appears would have been the
 * easier change and the wrong one: it would silence a real claim that happens
 * to sit in the same sentence as the adjective.
 *
 * 未導入 is here for the same reason from the other direction: it contains no
 * done word itself, but blanking it keeps the pair symmetrical for a reader
 * of this list, and a future done word ending in 導入 cannot start matching it.
 */
const NOT_A_COMPLETION_CLAIM = ['導入済み', '導入済', '未導入'];

/**
 * The fragment with its false completion words blanked out.
 *
 * Replaced with a character that is in no DONE_WORD, rather than deleted, so
 * that removing a run cannot accidentally join its neighbours into one.
 *
 * @param {string} text
 */
function withoutFalseCompletions(text) {
  let out = text;
  for (const phrase of NOT_A_COMPLETION_CLAIM) {
    out = out.split(phrase).join('\u0000'.repeat(phrase.length));
  }
  return out;
}

/**
 * @typedef {object} FidelityFinding
 * @property {'block' | 'warn'} severity
 * @property {string} slide_id
 * @property {string} field
 * @property {string} kind
 * @property {string} message
 * @property {string} [excerpt]
 */

/**
 * @param {import('../workspace.js').Paths} p
 * @param {any} storyboard
 * @returns {{findings: FidelityFinding[], checked: {fragments: number, numbers: number, dates: number, cells: number}}}
 */
export function checkFidelity(p, storyboard) {
  /** @type {FidelityFinding[]} */
  const findings = [];
  const sources = loadSourceTexts(p);
  const index = combinedIndex(sources);
  const ledger = (() => {
    try {
      return readLedger(p);
    } catch {
      return null;
    }
  })();
  const pending = ((ledger && ledger.entries) || []).filter(
    (e) => (e.kind === 'action' && e.status === 'pending')
      || (e.kind === 'decision' && e.status === 'unresolved'),
  );

  const checked = { fragments: 0, numbers: 0, dates: 0, cells: 0 };

  if (sources.length === 0) {
    findings.push({
      severity: 'block',
      slide_id: '(deck)',
      field: 'sources',
      kind: 'no-sources',
      message: 'no source text to check the storyboard against; every number on every slide is unverifiable',
    });
    return { findings, checked };
  }

  for (const slide of storyboard.slides || []) {
    for (const frag of requiredText(slide)) {
      checked.fragments += 1;
      const text = frag.text;

      // THE DATE CHECK OWNS ITS OWN DIGITS.
      //
      // A date is also a run of numbers - 2026年 is a number with a unit - so
      // a single wrong date produced TWO findings: one for the date and one
      // for the year inside it. The PO sees one mistake and should be told
      // about it once, in the terms that explain it.
      const dates = dateTokens(text);
      const insideADate = (token) => dates.some((d) => token.at >= d.at && token.end <= d.end);

      for (const token of numericTokens(text)) {
        if (!token.loadBearing) continue;
        if (insideADate(token)) continue;
        checked.numbers += 1;
        if (!index.hasNumber(token.core)) {
          findings.push({
            severity: 'block',
            slide_id: slide.id,
            field: frag.field,
            kind: 'number-not-in-source',
            excerpt: collapse(text),
            message: `the number ${token.raw}${token.unit} appears in no source text. deck will not put a number on a slide that the source does not contain.`,
          });
        }
      }

      for (const d of dates) {
        checked.dates += 1;
        if (!index.hasDate(d.normal)) {
          findings.push({
            severity: 'block',
            slide_id: slide.id,
            field: frag.field,
            kind: 'date-not-in-source',
            excerpt: collapse(text),
            message: `the date ${d.raw} appears in no source text`,
          });
        }
      }

      // A TABLE CELL IS DATA, so the whole cell must be verbatim when it
      // carries a digit. Prose may be the agent's; a table row may not.
      if (/^table\.rows\[/.test(frag.field) && /[0-9０-９]/.test(text)) {
        checked.cells += 1;
        // Through cellFoundIn, not a literal substring match: "the whole
        // cell" has to mean the same cell written with a different keyboard.
        // A grouping comma added or removed, full-width digits and kanji
        // numerals are all the same DATA, and rejecting them taught nothing
        // except to copy punctuation faithfully.
        if (cellFoundIn(text, index) === null) {
          findings.push({
            severity: 'block',
            slide_id: slide.id,
            field: frag.field,
            kind: 'table-cell-not-verbatim',
            excerpt: collapse(text),
            message: 'this table cell carries a number and is not verbatim from any source',
          });
        }
      }

      // THE PENDING-AS-FINISHED HEURISTIC. Warning, not a block.
      const done = DONE_WORDS.find((w) => withoutFalseCompletions(text).includes(w));
      if (done) {
        const hit = pending.find((e) => sharesSubstance(text, e.quote));
        if (hit) {
          findings.push({
            severity: 'warn',
            slide_id: slide.id,
            field: frag.field,
            kind: 'pending-described-as-finished',
            excerpt: collapse(text),
            message: `this says 「${done}」 and overlaps ledger entry "${hit.id}", which is ${hit.status}. Check it is not presenting an open item as settled.`,
          });
        }
      }
    }
  }

  return { findings, checked };
}

/** How much verbatim overlap counts as "about the same thing". */
const SUBSTANCE_WINDOW = 8;

/**
 * Do two pieces of text share enough wording to be about the same thing?
 *
 * BY CHARACTER WINDOW, NOT BY WORDS. The first version split the quote on
 * punctuation and looked for a shared token, which does not work on the
 * language this tool is for: 「送客チャネルをOTA中心にするか自社サイト中心に
 * するかは次回までに決める」 contains no punctuation at all, so it was one
 * token, and the comparison only matched when the slide repeated the entire
 * clause including its ending - exactly what a slide never does. The check
 * silently never fired.
 *
 * Eight characters of Japanese is a distinctive phrase, so a shared window is
 * good evidence the slide is talking about that ledger entry, and short
 * enough to survive the agent rewriting the end of the sentence.
 *
 * @param {string} slideText
 * @param {string} quote
 */
function sharesSubstance(slideText, quote) {
  const hay = collapse(slideText);
  const needle = collapse(quote);
  if (needle.length <= SUBSTANCE_WINDOW) return hay.includes(needle);
  for (let i = 0; i + SUBSTANCE_WINDOW <= needle.length; i += 1) {
    if (hay.includes(needle.slice(i, i + SUBSTANCE_WINDOW))) return true;
  }
  return false;
}
