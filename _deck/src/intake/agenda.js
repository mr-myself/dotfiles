import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../schema.js';
import { DeckError, EXIT } from '../util/fail.js';
import { mustBeAccountedFor, readLedger, withMissingInformation } from './ledger.js';
import { collapse } from './text.js';

/**
 * THE AGENDA GATE: nothing open gets dropped in silence.
 *
 * Gate 4 is where the PO agrees what the next meeting is about. The failure
 * mode is not a wrong agenda - the PO can see a wrong agenda and say so. It is
 * an agenda that looks complete while an unresolved decision from the minutes
 * simply is not on it. Nobody can see an absence.
 *
 * So the gate is: every ledger entry that is still OPEN - an unresolved
 * decision, a pending action, an open question - must appear either in `items`
 * or in `excluded` with a reason. Not mentioning it is refused. The agent is
 * free to exclude anything it likes, as long as it says so out loud and the PO
 * sees the exclusion list at the gate.
 *
 * `agent_proposed` is an allowed ledger_ref for an item the agent is adding on
 * its own judgement rather than from the source, so that "this was my idea"
 * stays visible instead of hiding behind a citation.
 */

/** The one ledger_ref that is not a ledger id. */
export const AGENT_PROPOSED = 'agent_proposed';

/** @param {import('../workspace.js').Paths} p */
export function agendaPath(p) {
  return path.join(p.root, 'agenda.json');
}

/** @param {import('../workspace.js').Paths} p @returns {any | null} */
export function readAgenda(p) {
  const file = agendaPath(p);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new DeckError('agenda.json is not valid JSON', EXIT.PROCESS_FAILED, [String(err)]);
  }
  const errors = validate('agenda.schema.json', parsed, `${file}: `);
  if (errors.length > 0) {
    throw new DeckError("agenda.json does not match deck's agenda schema", EXIT.VERDICT_FAILED, errors);
  }
  return parsed;
}

/**
 * @typedef {object} AgendaProblem
 * @property {string} kind
 * @property {string} message
 * @property {string} [ref]
 */

/**
 * @param {import('../workspace.js').Paths} p
 * @returns {{agenda: any | null, problems: AgendaProblem[], accounted: number, open: number}}
 */
export function checkAgenda(p) {
  /** @type {AgendaProblem[]} */
  const problems = [];
  const agenda = readAgenda(p);
  if (!agenda) {
    return {
      agenda: null,
      accounted: 0,
      open: 0,
      problems: [{ kind: 'no-agenda', message: 'no agenda.json: there is no proposed agenda to approve' }],
    };
  }

  const ledger = readLedger(p);
  if (!ledger) {
    return {
      agenda,
      accounted: 0,
      open: 0,
      problems: [{
        kind: 'no-ledger',
        message: 'no ledger.json, so the agenda rests on nothing that can be traced to the source',
      }],
    };
  }

  const byId = new Map((ledger.entries || []).map((e) => [e.id, e]));
  const referenced = new Set();
  const itemIds = new Set();

  for (const item of agenda.items || []) {
    if (itemIds.has(item.id)) {
      problems.push({ kind: 'duplicate-item', ref: item.id, message: `agenda item id "${item.id}" appears twice` });
    }
    itemIds.add(item.id);
    for (const ref of item.ledger_refs) {
      if (ref === AGENT_PROPOSED) continue;
      if (!byId.has(ref)) {
        problems.push({
          kind: 'dangling-ref',
          ref,
          message: `agenda item "${item.id}" cites ledger entry "${ref}", which does not exist`,
        });
        continue;
      }
      referenced.add(ref);
    }
    if (collapse(item.why) === collapse(item.heading)) {
      problems.push({
        kind: 'why-restates-heading',
        ref: item.id,
        message: `agenda item "${item.id}" gives a reason identical to its heading, so it says nothing about why it belongs on the next meeting`,
      });
    }
  }

  for (const ex of agenda.excluded || []) {
    for (const ref of ex.ledger_refs) {
      if (!byId.has(ref)) {
        problems.push({
          kind: 'dangling-ref',
          ref,
          message: `the exclusion list cites ledger entry "${ref}", which does not exist`,
        });
        continue;
      }
      if (referenced.has(ref)) {
        problems.push({
          kind: 'both-included-and-excluded',
          ref,
          message: `ledger entry "${ref}" is both on the agenda and in the exclusion list`,
        });
      }
      referenced.add(ref);
    }
  }

  // WHAT THE SOURCE DID NOT SAY HAS TO BE RAISED, not quietly carried.
  //
  // The ledger gate now lets an entry record that the minutes genuinely do
  // not name an owner, or do not state a period, instead of forcing the agent
  // to invent one. That honesty is only worth anything if the hole reaches the
  // PO: a missing owner is a question for the room, and this is the gate where
  // the room's agenda is agreed.
  const declaredMissing = new Set(
    (agenda.missing_evidence || []).flatMap((m) => `${m.what} ${m.why}`.split(/\s+/)),
  );
  for (const e of withMissingInformation(ledger)) {
    const raisedById = (agenda.missing_evidence || []).some((m) => `${m.what} ${m.why}`.includes(e.id));
    const onAgenda = (agenda.items || []).some((it) => (it.ledger_refs || []).includes(e.id));
    if (!raisedById && !onAgenda && !declaredMissing.has(e.id)) {
      problems.push({
        kind: 'missing-information-not-raised',
        ref: e.id,
        message: `entry "${e.id}" records that the source does not state its ${e.source_omits.join(' or ')}, and that is neither on the agenda nor in missing_evidence. A hole in the minutes is a question for the room: raise it, do not carry it silently.`,
      });
    }
  }

  const open = mustBeAccountedFor(ledger);
  for (const e of open) {
    if (!referenced.has(e.id)) {
      problems.push({
        kind: 'open-item-unaccounted',
        ref: e.id,
        message: `${describeKind(e)} "${e.id}" is still open and appears neither on the agenda nor in the exclusion list: 「${collapse(e.quote).slice(0, 60)}」`,
      });
    }
  }

  return { agenda, problems, accounted: referenced.size, open: open.length };
}

/** @param {any} e */
function describeKind(e) {
  if (e.kind === 'decision') return 'unresolved decision';
  if (e.kind === 'action') return 'pending action';
  return 'open question';
}
