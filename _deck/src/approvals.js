import fs from 'node:fs';
import path from 'node:path';
import {
  agendaArtifactDigest, agendaArtifactProjection, agendaDigest, contentDigest, contentProjection,
  describeAgendaChanges, describeContentChanges,
} from './digest.js';
import { DeckError, EXIT } from './util/fail.js';
import { ensureDir, readJsonIfExists, writeJson } from './util/fs.js';

/** The two things that can be approved. */
export const APPROVABLE = ['agenda', 'content'];

/** @param {import('./workspace.js').Paths} p @param {string} kind */
function file(p, kind) {
  return path.join(p.approvals, `${kind}.json`);
}

/**
 * Record approval of an EXACT revision.
 *
 * The digest is over a canonical projection, not the file bytes, so
 * re-indenting the YAML does not invalidate an approval while changing one
 * character of a title does. The projection is stored alongside the digest so
 * a later mismatch can say WHAT changed rather than only that something did -
 * "the storyboard has changed" sends the PO diffing; "slide s-03: title
 * changed" does not.
 *
 * @param {import('./workspace.js').Paths} p
 * @param {'agenda' | 'content'} kind
 * @param {any} storyboard
 * @returns {any} the approval record
 */
export function approve(p, kind, storyboard, agenda = null) {
  if (!APPROVABLE.includes(kind)) {
    throw new DeckError(`cannot approve "${kind}"`, EXIT.USAGE, [`Approvable: ${APPROVABLE.join(', ')}`]);
  }
  ensureDir(p.approvals);
  const subject = subjectFor(kind, agenda);
  const record = {
    schema: 'deck.approval/2',
    kind,
    // WHICH ARTIFACT THIS APPROVAL IS ABOUT.
    //
    // Added because an agenda approval used to be recorded against the
    // storyboard spine, and the agenda gate runs before the storyboard
    // exists - so the approval was against the scaffold and died as soon as
    // the agent wrote a real title. A record that does not say what it
    // covers cannot be compared with anything later.
    subject,
    digest: digestFor(kind, subject, storyboard, agenda),
    approved_at: new Date().toISOString(),
    slide_count: (storyboard?.slides || []).length,
    slide_ids: (storyboard?.slides || []).map((s) => s.id),
    projection: projectionFor(kind, subject, storyboard, agenda),
  };
  writeJson(file(p, kind), record);
  appendHistory(p, record);
  return record;
}

/**
 * WHAT AN APPROVAL OF THIS KIND IS ABOUT.
 *
 * `agenda-artifact` when agenda.json exists - the agent flow, where the PO
 * reviews the proposed agenda itself. `storyboard-spine` when it does not,
 * which is the gate layer used directly on a hand-written storyboard: there
 * is no agenda artifact to approve, and the spine is the nearest honest
 * subject. The record says which, so nothing has to guess later.
 *
 * @param {'agenda' | 'content'} kind
 * @param {any} agenda
 */
function subjectFor(kind, agenda) {
  if (kind === 'content') return 'storyboard-content';
  return agenda ? 'agenda-artifact' : 'storyboard-spine';
}

function digestFor(kind, subject, storyboard, agenda) {
  if (kind === 'content') return contentDigest(storyboard);
  return subject === 'agenda-artifact' ? agendaArtifactDigest(agenda) : agendaDigest(storyboard);
}

function projectionFor(kind, subject, storyboard, agenda) {
  if (kind === 'content') return contentProjection(storyboard);
  return subject === 'agenda-artifact' ? agendaArtifactProjection(agenda) : null;
}

/**
 * THE APPROVAL AUDIT TRAIL.
 *
 * Every approval ever recorded, appended, never rewritten. The approval FILE
 * holds the current one, which is what the gates compare against; this holds
 * the history, so "when did the PO approve what" is answerable after the
 * fourth revision - including for an approval that was later superseded.
 *
 * @param {import('./workspace.js').Paths} p
 * @param {any} record
 */
function appendHistory(p, record) {
  try {
    ensureDir(p.approvals);
    fs.appendFileSync(
      path.join(p.approvals, 'history.jsonl'),
      `${JSON.stringify({ ...record, projection: undefined })}\n`,
    );
  } catch {
    // The history is an audit convenience. A read-only approvals directory
    // would already have failed the write above.
  }
}

/**
 * @param {import('./workspace.js').Paths} p
 * @returns {any[]} every approval ever recorded, oldest first
 */
export function approvalHistory(p) {
  const f = path.join(p.approvals, 'history.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { malformed: line };
    }
  });
}

/**
 * @param {import('./workspace.js').Paths} p
 * @param {'agenda' | 'content'} kind
 * @returns {any | null}
 */
export function readApproval(p, kind) {
  return readJsonIfExists(file(p, kind));
}

/**
 * @typedef {object} ApprovalState
 * @property {boolean} approved
 * @property {boolean} matches
 * @property {string | null} approved_digest
 * @property {string} current_digest
 * @property {string | null} approved_at
 * @property {string[]} changes
 */

/**
 * @param {import('./workspace.js').Paths} p
 * @param {'agenda' | 'content'} kind
 * @param {any} storyboard
 * @returns {ApprovalState}
 */
export function approvalState(p, kind, storyboard, agenda = null) {
  const record = readApproval(p, kind);
  // COMPARED AGAINST WHAT IT WAS APPROVED AGAINST. A record written before
  // this field existed is a storyboard-spine agenda approval, which is what
  // the old code always produced.
  const subject = record ? (record.subject || subjectFor(kind, null)) : subjectFor(kind, agenda);
  const current = currentDigest(kind, subject, storyboard, agenda);
  if (!record) {
    return {
      approved: false,
      matches: false,
      subject,
      approved_digest: null,
      current_digest: current,
      approved_at: null,
      changes: [],
    };
  }
  const matches = current !== null && record.digest === current;
  /** @type {string[]} */
  let changes = [];
  if (current === null) {
    return {
      approved: true,
      matches: false,
      subject,
      approved_digest: record.digest,
      current_digest: null,
      approved_at: record.approved_at,
      changes: [`this deck's ${kind} was approved as "${subject}", and that artifact is no longer present, so the approval cannot be checked.`],
    };
  }
  if (!matches) {
    if (kind === 'content' && record.projection) {
      changes = describeContentChanges(record.projection, contentProjection(storyboard));
    }
    if (kind === 'agenda' && subject === 'agenda-artifact' && record.projection && agenda) {
      changes = describeAgendaChanges(record.projection, agendaArtifactProjection(agenda));
    }
    if (changes.length === 0) {
      // The digest moved but the recorded projection cannot explain it - an
      // approval from an older schema, say. Saying so is better than
      // reporting "nothing changed" next to a mismatch.
      changes = [
        `the ${kind} digest no longer matches the approved one, but the approval record carries no comparable projection, so deck cannot say which field moved.`,
        `approved digest: ${record.digest}`,
        `current digest:  ${current}`,
      ];
    }
  }
  return {
    approved: true,
    matches,
    subject,
    approved_digest: record.digest,
    current_digest: current,
    approved_at: record.approved_at,
    changes,
  };
}

/** null when the artifact this approval covers is not present to compare. */
function currentDigest(kind, subject, storyboard, agenda) {
  if (kind === 'content') return storyboard ? contentDigest(storyboard) : null;
  if (subject === 'agenda-artifact') return agenda ? agendaArtifactDigest(agenda) : null;
  return storyboard ? agendaDigest(storyboard) : null;
}

/**
 * The gate for `deck render --release`.
 *
 * Changing wording, slide order or slide count invalidates CONTENT approval.
 * Changing only the theme or the layout does not - it invalidates rendered
 * output, which a release render is producing anyway. So this checks the
 * content digest and nothing else.
 *
 * @param {import('./workspace.js').Paths} p
 * @param {any} storyboard
 * @returns {{ok: true} | {ok: false, message: string, details: string[]}}
 */
export function releaseGate(p, storyboard) {
  const state = approvalState(p, 'content', storyboard);
  if (!state.approved) {
    return {
      ok: false,
      message: 'this deck\'s content has never been approved, so there is nothing for a release render to match',
      details: [
        'Run `deck approve content` once the wording is final.',
        'A plain `deck render` (preview) is always allowed - the PO has to be able to look before approving.',
      ],
    };
  }
  if (!state.matches) {
    return {
      ok: false,
      message: 'the storyboard no longer matches the approved content',
      details: [
        `approved at:     ${state.approved_at}`,
        `approved digest: ${state.approved_digest}`,
        `current digest:  ${state.current_digest}`,
        '',
        'What changed:',
        ...state.changes.map((c) => `  - ${c}`),
        '',
        'Either revert the change, or run `deck approve content` to approve the new wording.',
      ],
    };
  }
  return { ok: true };
}

/** @param {import('./workspace.js').Paths} p */
export function listApprovals(p) {
  if (!fs.existsSync(p.approvals)) return [];
  return fs.readdirSync(p.approvals).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
