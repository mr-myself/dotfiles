import path from 'node:path';
import { loadDeck, validateSemantics } from '../deck.js';
import { agendaDigest, contentDigest } from '../digest.js';
import { EXIT } from '../util/fail.js';
import { ensureDir } from '../util/fs.js';
import { writeReport } from '../util/report.js';

/**
 * A DECK MADE MOSTLY OF TABLES IS A SMELL, and this says so.
 *
 * Reported, never enforced. The agent reaches for `table` when it has
 * nowhere else to put a relationship, and the fix for that is the diagram
 * page types plus knowing they exist - not a gate. Blocking on a ratio would
 * teach it to split one table into two slides to get under the threshold,
 * which is worse than the tables.
 *
 * The verdict is untouched: this is a note in the report and a line on
 * stdout, and `deck validate` still passes.
 *
 * @param {any} storyboard
 */
function compositionNotes(storyboard) {
  const slides = storyboard.slides || [];
  /** @type {Record<string, number>} */
  const counts = {};
  for (const s of slides) counts[s.page_type] = (counts[s.page_type] || 0) + 1;
  const notes = [];
  const content = slides.filter((s) => !['cover', 'agenda', 'section-divider'].includes(s.page_type));
  const tables = content.filter((s) => s.page_type === 'table').length;
  const diagrams = content.filter((s) => ['comparison', 'process', 'ecosystem', 'timeline'].includes(s.page_type)).length;
  if (content.length >= 4 && tables / content.length >= 0.5) {
    notes.push(`${tables} of ${content.length} content slides are tables. A table is right when the content is many rows of the same shape, or precise values meant to be read off. For options compared on shared axes, steps in order, who-connects-to-what, or events over time there are page types that draw the relationship: comparison, process, ecosystem, timeline.`);
  }
  if (content.length >= 5 && diagrams === 0) {
    notes.push('no slide in this deck draws a relationship. That is fine if nothing in it is relational - worth a second look if something is.');
  }
  return { counts, tables, diagrams, content: content.length, notes };
}

/**
 * `deck validate`
 *
 * Two layers, because a JSON Schema cannot express the second:
 *
 *   1. SHAPE   - the storyboard and the request match their schemas, with
 *                additionalProperties: false, so a typo'd key is an error and
 *                not a silently dropped line.
 *   2. SEMANTICS - the page type is implemented, the theme has geometry for it,
 *                slot ids are unique and positioned, and the body blocks are
 *                ones that page type can actually lay out.
 *
 * Exit 0 when the storyboard is renderable, 1 when it is not. Either way the
 * process ran, and `validate-status.txt` says so.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function validateCommand(argv) {
  const json = argv.includes('--json');
  const { p, storyboard, theme, request } = loadDeck();

  const problems = validateSemantics(storyboard, theme);
  const verdict = problems.length === 0 ? 'pass' : 'fail';
  const shape = compositionNotes(storyboard);

  const slides = storyboard.slides.map((s) => ({
    id: s.id,
    page_type: s.page_type,
    has_subtitle: s.subtitle !== null && s.subtitle !== undefined,
    // Reported explicitly: an intentionally absent subtitle is a DECISION, and
    // showing it next to the ones that have a subtitle is how the PO notices
    // if one went missing by accident.
    subtitle_intentionally_absent: s.subtitle === null,
    slots: (s.slots || []).map((sl) => sl.id),
  }));

  ensureDir(p.outLint);
  writeReport({
    dir: path.join(p.out),
    name: 'validate',
    command: 'validate',
    process: 'ok',
    verdict,
    summary: verdict === 'pass'
      ? `${storyboard.slides.length} slide(s) validate against the schema and against theme "${theme.name}"`
      : `${problems.length} problem(s) in ${path.basename(p.storyboard)}`,
    body: {
      theme: theme.name,
      project: request.request.project_name,
      counts: { slides: storyboard.slides.length, problems: problems.length },
      digests: { agenda: agendaDigest(storyboard), content: contentDigest(storyboard) },
      problems,
      composition: shape,
      slides,
    },
    humanText: [
      'deck validate',
      '',
      `verdict: ${verdict}`,
      `slides:  ${storyboard.slides.length}`,
      `theme:   ${theme.name}`,
      '',
      ...(problems.length === 0 ? ['No problems.'] : ['Problems:', ...problems.map((x) => `  - ${x}`)]),
      ...(shape.notes.length > 0 ? ['', 'Composition:', ...shape.notes.map((x) => `  - ${x}`)] : []),
    ].join('\n'),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ verdict, problems, digests: { agenda: agendaDigest(storyboard), content: contentDigest(storyboard) } }, null, 2)}\n`);
  } else if (problems.length === 0) {
    process.stdout.write(`deck validate: ${storyboard.slides.length} slide(s) OK against theme "${theme.name}"\n`);
    const absent = slides.filter((s) => s.subtitle_intentionally_absent).map((s) => s.id);
    if (absent.length > 0) {
      process.stdout.write(`  intentionally absent subtitles (never back-filled): ${absent.join(', ')}\n`);
    }
    process.stdout.write(`  agenda digest:  ${agendaDigest(storyboard)}\n`);
    process.stdout.write(`  content digest: ${contentDigest(storyboard)}\n`);
    for (const note of shape.notes) process.stdout.write(`\n  NOTE  ${note}\n`);
  } else {
    process.stdout.write(`deck validate: ${problems.length} problem(s)\n\n`);
    for (const x of problems) process.stdout.write(`  - ${x}\n`);
    process.stdout.write('\n');
  }
  return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
}
