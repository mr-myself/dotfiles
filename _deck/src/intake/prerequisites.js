import fs from 'node:fs';
import { checkAgenda, readAgenda } from './agenda.js';
import { checkFidelity } from './fidelity.js';
import { checkLedger, ledgerPath } from './ledger.js';
import { checkSources, manifestPath } from './sources.js';

/**
 * WHAT HAS TO HOLD BEFORE AN APPROVAL IS WORTH RECORDING.
 *
 * `deck approve` used to record whatever it was asked to. So a run whose
 * source gate was failing, whose ledger contained an unverifiable quote, or
 * whose storyboard carried a number from nowhere could still produce an
 * approval record - and that record is what `render --release` and `status`
 * key off. The failing gate was reported to the agent, which was then trusted
 * not to approve over it. Nothing made it so.
 *
 * These are run at approval time and the failures are named. They are the same
 * functions the gates themselves call, so an approval cannot pass a check the
 * gate would fail.
 *
 * WHAT IS NOT REQUIRED, deliberately:
 *
 *   - a deck with no sources/manifest.json at all is the GATE LAYER used
 *     directly on a hand-written storyboard, which is a supported way to use
 *     deck. The intake gates do not apply to it, so they are reported as
 *     "not applicable" rather than failed.
 *   - `--force` exists because the PO may knowingly accept a failing gate, and
 *     a tool that cannot be overridden gets worked around instead. The
 *     override is recorded in the approval history.
 */

/**
 * @typedef {object} Prerequisite
 * @property {string} gate
 * @property {boolean} ok
 * @property {string} message
 * @property {string[]} details
 */

/**
 * @param {import('../workspace.js').Paths} p
 * @param {'agenda' | 'content'} kind
 * @param {any} storyboard
 * @returns {Prerequisite[]}
 */
export function prerequisitesFor(p, kind, storyboard) {
  /** @type {Prerequisite[]} */
  const out = [];
  const hasIntake = fs.existsSync(manifestPath(p));
  if (!hasIntake) {
    return [{
      gate: 'intake',
      ok: true,
      message: 'no sources/manifest.json: this deck was not built from imported material, so the intake gates do not apply',
      details: [],
    }];
  }

  const safely = (gate, fn) => {
    try {
      const problems = fn();
      out.push({
        gate,
        ok: problems.length === 0,
        message: problems.length === 0 ? 'passes' : `${problems.length} problem(s)`,
        details: problems.slice(0, 5).map((x) => x.message || String(x)),
      });
    } catch (err) {
      // A gate that THROWS has not passed. A malformed ledger.json is exactly
      // the state in which an approval must not be recorded.
      out.push({
        gate, ok: false, message: 'could not run', details: [String(err && err.message ? err.message : err)],
      });
    }
  };

  safely('source', () => checkSources(p).problems);

  // AN ABSENT LEDGER IS NOT A FAILED LEDGER.
  //
  // The ledger is the AGENT's working artifact, and the agent always writes
  // one - the agenda gate refuses an agenda without it, and `approve agenda`
  // requires that gate. But the gate layer is also used directly on a
  // hand-written storyboard with imported sources and no ledger, and newly
  // refusing to approve that would break a supported way of working to
  // enforce something the agent path already enforces.
  if (fs.existsSync(ledgerPath(p))) {
    safely('ledger', () => checkLedger(p).problems);
  } else {
    out.push({
      gate: 'ledger',
      ok: true,
      message: 'no ledger.json: nothing was extracted from the sources, so there is nothing to verify',
      details: [],
    });
  }

  // The agenda gate only applies once there is an agenda to check. A content
  // approval still requires it: the words rest on the agenda the PO agreed.
  if (readAgendaSafely(p)) {
    safely('agenda', () => checkAgenda(p).problems);
  } else if (kind === 'content') {
    out.push({
      gate: 'agenda',
      ok: true,
      message: 'no agenda.json; nothing to check',
      details: [],
    });
  }

  // Fidelity is about the STORYBOARD, so it is required for content and not
  // for an agenda approval - at which point the storyboard is still a
  // scaffold and would fail for the wrong reason.
  if (kind === 'content') {
    safely('fidelity', () => checkFidelity(p, storyboard).findings.filter((f) => f.severity === 'block'));
  }
  return out;
}

/** @param {import('../workspace.js').Paths} p */
function readAgendaSafely(p) {
  try {
    return readAgenda(p);
  } catch {
    // A malformed agenda.json is caught by the agenda gate below with a
    // proper message; returning truthy here routes it there.
    return true;
  }
}
