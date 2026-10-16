import { loadDeck, validateSemantics } from '../deck.js';
import { approve } from '../approvals.js';
import { readAgenda } from '../intake/agenda.js';
import { prerequisitesFor } from '../intake/prerequisites.js';
import { DeckError, EXIT, usage } from '../util/fail.js';
import { setPhase } from '../workspace.js';

/**
 * `deck approve agenda|content`
 *
 * Records the SHA-256 of the exact artifact approved, plus a timestamp.
 *
 * WHICH ARTIFACT, and why it matters. An agenda approval used to be recorded
 * against the storyboard's SPINE - slide ids, order, page types, titles. But
 * the agenda gate runs before the agent writes the storyboard, so in every
 * normal run the spine at that moment was the scaffold `deck init` produced:
 * the PO approved their agenda, the agent wrote the first real title, and the
 * approval was instantly invalid. It now records agenda.json - the items,
 * the reasons, the exclusions and the missing evidence - which is what the PO
 * actually read.
 *
 * A deck with no agenda.json (the gate layer used directly on a hand-written
 * storyboard) still approves the spine. The record says which subject it
 * covers, so nothing downstream has to guess.
 *
 * THE PREREQUISITES ARE CHECKED. An approval is a statement that this is the
 * revision to ship, and a revision whose own gates fail is not shippable:
 * recording it would create an approval that can never be satisfied, and -
 * worse - an approval the PO believes means the checks passed.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function approveCommand(argv) {
  const kind = argv[0];
  if (!kind) usage('deck approve requires "agenda" or "content"');
  if (!['agenda', 'content'].includes(kind)) {
    usage(`deck approve does not know how to approve "${kind}"`, ['Approvable: agenda, content']);
  }
  const force = argv.includes('--force');
  const rest = argv.slice(1).filter((a) => a !== '--force');
  if (rest.length > 0) usage(`deck approve takes exactly one argument (got: ${argv.join(' ')})`);

  const { p, storyboard, theme } = loadDeck();
  const agenda = readAgenda(p);

  // The storyboard has to be renderable for a CONTENT approval, which is a
  // statement about the words that will be on the page. An AGENDA approval is
  // about the agenda artifact and does not depend on the storyboard at all -
  // which is the point: at that moment the storyboard is still a scaffold.
  if (kind === 'content' || !agenda) {
    const problems = validateSemantics(storyboard, theme);
    if (problems.length > 0) {
      throw new DeckError(
        `refusing to approve a storyboard that does not validate (${problems.length} problem(s))`,
        EXIT.VERDICT_FAILED,
        [...problems.map((x) => `  - ${x}`), '', 'Run `deck gate validate` and fix these first.'],
      );
    }
  }

  const prereqs = prerequisitesFor(p, kind, storyboard);
  const failed = prereqs.filter((x) => !x.ok);
  if (failed.length > 0 && !force) {
    throw new DeckError(
      `refusing to record an approval (${kind}) while ${failed.length} prerequisite gate(s) fail`,
      EXIT.VERDICT_FAILED,
      [
        ...failed.flatMap((x) => [`  - ${x.gate}: ${x.message}`, ...x.details.map((d) => `      ${d}`)]),
        '',
        'An approval says "this is the revision to ship". Recording one over a',
        'failing gate produces an approval the PO believes means the checks passed.',
        '',
        `Fix these, or re-run with --force if the PO has decided to accept them knowingly`,
        '(the override is recorded in the approval history either way).',
      ],
    );
  }

  const record = approve(p, /** @type {'agenda' | 'content'} */ (kind), storyboard, agenda);

  // Approving content implies the agenda is settled too - the content digest
  // covers slide ids, order and count. Approving the agenda does NOT imply
  // content: that is the whole point of having two.
  setPhase(p, kind === 'content' ? 'content-approved' : 'agenda-approved');

  process.stdout.write(`deck approve ${kind}\n`);
  process.stdout.write(`  subject:     ${record.subject}\n`);
  process.stdout.write(`  digest:      ${record.digest}\n`);
  process.stdout.write(`  approved at: ${record.approved_at}\n`);
  if (record.subject === 'agenda-artifact') {
    process.stdout.write(`  items:       ${(agenda.items || []).length}\n`);
    process.stdout.write(`  excluded:    ${(agenda.excluded || []).length} (with reasons, and in the digest)\n`);
  } else {
    process.stdout.write(`  slides:      ${record.slide_count} (${record.slide_ids.join(', ')})\n`);
  }
  for (const x of prereqs) {
    process.stdout.write(`  ${x.ok ? 'gate ok ' : 'GATE FAIL'}    ${x.gate}${x.ok ? '' : ` - ${x.message}`}\n`);
  }
  if (failed.length > 0) {
    process.stdout.write(`\nRecorded over ${failed.length} FAILING gate(s) because --force was given.\n`);
  }
  if (kind === 'content') {
    process.stdout.write('\n`deck gate render --release` will now refuse to run if the wording, slide order or slide count changes.\n');
  } else if (record.subject === 'agenda-artifact') {
    process.stdout.write('\nThe agenda is approved as the PO read it, exclusions included. Writing the\nstoryboard does NOT invalidate it; editing agenda.json does.\n');
  } else {
    process.stdout.write('\nThe spine is approved. Wording may still move; `deck gate approve content` signs that off separately.\n');
  }
  return EXIT.OK;
}
