import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../schema.js';
import { DeckError, EXIT } from '../util/fail.js';
import { loadSourceTexts } from './sources.js';
import { collapse, combinedIndex } from './text.js';

/**
 * THE LEDGER GATE: every quote is CHECKED, not trusted.
 *
 * The ledger exists to keep extraction apart from reasoning. The agent reads
 * the source once and writes down what it found - decisions, open questions,
 * actions with owner and deadline, numbers with units and periods - each
 * carrying the exact source wording. Everything downstream is built from this
 * file, so a summary never becomes the working material.
 *
 * That only helps if the quotes are real. An agent summarising a meeting will
 * produce a paraphrase that reads exactly like a quotation, and no amount of
 * instruction in a prompt makes the difference visible to the PO. So each
 * quote is looked for in the saved source text, and an entry whose quote
 * cannot be found is refused BY ID with the quote printed. This is the one
 * check in deck that can catch an invented decision.
 *
 * WHAT IT CANNOT CATCH, stated plainly: a quote that is real but was
 * MISREAD - lifted from a sentence that says the opposite, or from a comment
 * rejecting the idea. The quote is verbatim, so the gate passes. Only the PO
 * reading the ledger at gate 4 can catch that, which is why gate 4 shows the
 * quotes and not just the agent's headings.
 */

/** @param {import('../workspace.js').Paths} p */
export function ledgerPath(p) {
  return path.join(p.root, 'ledger.json');
}

/** @param {import('../workspace.js').Paths} p @returns {any | null} */
export function readLedger(p) {
  const file = ledgerPath(p);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new DeckError('ledger.json is not valid JSON', EXIT.PROCESS_FAILED, [String(err)]);
  }
  const errors = validate('ledger.schema.json', parsed, `${file}: `);
  if (errors.length > 0) {
    throw new DeckError("ledger.json does not match deck's ledger schema", EXIT.VERDICT_FAILED, errors);
  }
  return parsed;
}

/**
 * @typedef {object} LedgerProblem
 * @property {string} entry_id
 * @property {string} kind
 * @property {string} message
 * @property {string} [quote]
 */

/**
 * @param {import('../workspace.js').Paths} p
 * @returns {{ledger: any | null, problems: LedgerProblem[], checked: number, counts: Record<string, number>}}
 */
export function checkLedger(p) {
  /** @type {LedgerProblem[]} */
  const problems = [];
  const ledger = readLedger(p);
  if (!ledger) {
    return {
      ledger: null,
      checked: 0,
      counts: {},
      problems: [{
        entry_id: '(none)',
        kind: 'no-ledger',
        message: 'no ledger.json: nothing separates what the source said from what the agent concluded',
      }],
    };
  }

  const sources = loadSourceTexts(p);
  const index = combinedIndex(sources);
  const knownSourceIds = new Set(sources.map((s) => s.id));
  const seen = new Set();
  /** @type {Record<string, number>} */
  const counts = {};

  for (const e of ledger.entries || []) {
    counts[e.kind] = (counts[e.kind] || 0) + 1;

    if (seen.has(e.id)) {
      problems.push({ entry_id: e.id, kind: 'duplicate-id', message: `entry id "${e.id}" appears twice` });
    }
    seen.add(e.id);

    if (!knownSourceIds.has(e.source_id)) {
      problems.push({
        entry_id: e.id,
        kind: 'unknown-source',
        message: `entry "${e.id}" cites source "${e.source_id}", which is not in sources/manifest.json`,
      });
      // Nothing to verify the quote against; the citation is the defect.
      continue;
    }

    // THE CITED SOURCE IS THE ONE THAT HAS TO CONTAIN IT.
    //
    // This used to ask "which source contains this quote?" and take the first
    // answer, so a perfectly correct entry citing the minutes was refused
    // whenever an earlier source happened to carry the same sentence - a
    // forwarded copy of the same page, a quoted excerpt, boilerplate. The
    // other sources are now consulted only to EXPLAIN an absence.
    const cited = index.forSource(e.source_id);
    if (cited && !cited.hasQuote(e.quote)) {
      const elsewhere = index.quoteFoundIn(e.quote).filter((id) => id !== e.source_id);
      if (elsewhere.length > 0) {
        problems.push({
          entry_id: e.id,
          kind: 'quote-from-other-source',
          quote: collapse(e.quote),
          message: `entry "${e.id}" cites source "${e.source_id}", which does not contain this wording. It IS in ${elsewhere.map((x) => `"${x}"`).join(', ')} - cite the source it came from.`,
        });
      } else {
        problems.push({
          entry_id: e.id,
          kind: 'quote-not-in-source',
          quote: collapse(e.quote),
          message: `entry "${e.id}" quotes wording that appears in NO source text. Either it was paraphrased, or it was invented.`,
        });
      }
    }

    // The status vocabulary is per-kind, and getting it wrong is how a pending
    // action becomes a finished one. The schema cannot express this: its enum
    // has to hold every value for every kind.
    if (e.kind === 'action' && !['done', 'pending'].includes(e.status)) {
      problems.push({
        entry_id: e.id,
        kind: 'bad-status',
        message: `action "${e.id}" has status ${JSON.stringify(e.status)}; an action is "done" or "pending"`,
      });
    }
    if (e.kind === 'decision' && !['resolved', 'unresolved'].includes(e.status)) {
      problems.push({
        entry_id: e.id,
        kind: 'bad-status',
        message: `decision "${e.id}" has status ${JSON.stringify(e.status)}; a decision is "resolved" or "unresolved"`,
      });
    }
    // A number without its unit is not a number: 1,200 of what, over what?
    if (e.kind === 'number') {
      if (!e.value) {
        problems.push({ entry_id: e.id, kind: 'number-no-value', message: `number "${e.id}" records no value` });
      }
      if (!e.unit && !omits(e, 'unit')) {
        problems.push({
          entry_id: e.id,
          kind: 'number-no-unit',
          message: `number "${e.id}" records no unit, so it cannot be put on a slide without inventing one. If the source states a bare figure, record that with source_omits: ["unit"].`,
        });
      }
      if (!e.period && !omits(e, 'period')) {
        problems.push({
          entry_id: e.id,
          kind: 'number-no-period',
          message: `number "${e.id}" records no period; two numbers from different months are not a trend. If the source does not state one, record that with source_omits: ["period"] - do not infer it.`,
        });
      }
      if (e.value && !index.quoteFrom(String(e.value))) {
        problems.push({
          entry_id: e.id,
          kind: 'value-not-in-source',
          quote: String(e.value),
          message: `number "${e.id}" has value ${JSON.stringify(e.value)}, which appears in no source text`,
        });
      }
    }
    if (e.kind === 'action' && e.status === 'pending' && !e.owner && !omits(e, 'owner')) {
      problems.push({
        entry_id: e.id,
        kind: 'action-no-owner',
        message: `pending action "${e.id}" records no owner. If the source really does not say who owns it, record that with source_omits: ["owner"] - do not guess a name.`,
      });
    }
    for (const field of e.source_omits || []) {
      if (e[field]) {
        problems.push({
          entry_id: e.id,
          kind: 'omits-but-filled',
          message: `entry "${e.id}" declares the source omits "${field}" and then records a value for it (${JSON.stringify(e[field])}). One of the two is wrong.`,
        });
      }
    }
    for (const ref of e.conflicts_with || []) {
      if (!(ledger.entries || []).some((other) => other.id === ref)) {
        problems.push({
          entry_id: e.id,
          kind: 'dangling-conflict',
          message: `entry "${e.id}" says it conflicts with "${ref}", which is not an entry`,
        });
      }
    }
  }

  return { ledger, problems, checked: (ledger.entries || []).length, counts };
}

/** Does this entry declare that the source genuinely does not state a field? */
function omits(entry, field) {
  return Array.isArray(entry.source_omits) && entry.source_omits.includes(field);
}

/**
 * Entries whose MISSING INFORMATION the PO has to see.
 *
 * An entry recording "the minutes do not say who owns this" is not a defect -
 * it is a fact about the meeting, and exactly the kind of hole the next
 * agenda should close. The agenda gate requires each one to be raised, so the
 * answer to a missing owner is a question to the room rather than a name the
 * agent made up. Forcing the field to be filled is what these gates exist to
 * prevent.
 *
 * @param {any} ledger
 */
export function withMissingInformation(ledger) {
  return (ledger.entries || []).filter((e) => (e.source_omits || []).length > 0);
}

/**
 * Entries that MUST be accounted for on the agenda or explicitly excluded.
 * @param {any} ledger
 */
export function mustBeAccountedFor(ledger) {
  return (ledger.entries || []).filter(
    (e) => (e.kind === 'decision' && e.status === 'unresolved')
      || (e.kind === 'action' && e.status === 'pending')
      || e.kind === 'open_question',
  );
}
