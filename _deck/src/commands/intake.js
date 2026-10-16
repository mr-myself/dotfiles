import fs from 'node:fs';
import path from 'node:path';
import { loadDeck, slotFileToken, slotKey } from '../deck.js';
import { assetsCommand } from './assets.js';
import { checkAgenda } from '../intake/agenda.js';
import { copySheet } from '../intake/copy.js';
import { checkFidelity } from '../intake/fidelity.js';
import { checkLedger } from '../intake/ledger.js';
import { checkSources, sealSources } from '../intake/sources.js';
import { EXIT, usage } from '../util/fail.js';
import { ensureDir, writeAtomic } from '../util/fs.js';
import { writeReport } from '../util/report.js';
import { paths, requireWorkspace } from '../workspace.js';

/**
 * THE INTAKE GATES: source -> ledger -> agenda -> copy -> fidelity.
 *
 * Five commands in one file because they are one contract read five ways, and
 * splitting them would invite the five to drift. Each is a GATE the agent
 * runs on itself, in the same shape as every other deck command: exit 0 when
 * the verdict passes, 1 when it fails, a <name>.json report and a
 * <name>-status.txt holding the process status.
 *
 * None of them talks to Notion. The agent fetches through the notion-personal
 * MCP tools in its own session and SAVES what it got; these commands check
 * what is on disk. That split is deliberate: a gate that did its own fetching
 * could not be run twice with the same answer, and could not be tested without
 * a network.
 */

/** Everything the intake gates write goes next to the other reports. */
function reportDir(p) {
  ensureDir(p.out);
  return p.out;
}

/**
 * `deck gate source` - was the material fully retrieved?
 * @param {string[]} argv
 */
export async function sourceCommand(argv) {
  const json = argv.includes('--json');
  const root = requireWorkspace();
  const p = paths(root);
  const { problems, sources } = checkSources(p);
  const verdict = problems.length === 0 ? 'pass' : 'fail';

  writeReport({
    dir: reportDir(p),
    name: 'source',
    command: 'gate source',
    process: 'ok',
    verdict,
    summary: verdict === 'pass'
      ? `${sources.length} source(s) retrieved in full`
      : `${problems.length} problem(s) across ${sources.length} source(s); a partial fetch blocks approval`,
    body: { counts: { sources: sources.length, problems: problems.length }, problems, sources: sources.map(describeSource) },
    humanText: [
      'deck gate source', '', `verdict: ${verdict}`, '',
      ...(problems.length === 0
        ? [`${sources.length} source(s), all complete.`]
        : ['Problems:', ...problems.map((x) => `  - [${x.kind}] ${x.message}`)]),
    ].join('\n'),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ verdict, problems }, null, 2)}\n`);
  } else if (verdict === 'pass') {
    process.stdout.write(`deck gate source: ${sources.length} source(s) retrieved in full\n`);
    for (const s of sources) {
      process.stdout.write(`  ${s.id}  ${s.kind}  ${s.retrieved_at}  ${s.block_count ?? '?'} block(s)\n`);
    }
    // WHAT EVIDENCE THIS GATE ACCEPTS, SAID AT INTAKE.
    //
    // A deck shipped with ZERO approvals because the retrieval evidence was
    // only discussed at the moment of approval - the most expensive possible
    // moment to find out that something about the fetch was not acceptable.
    // The same list of accepted shapes is now printed when the source is
    // recorded, which is when it can still be re-fetched cheaply.
    //
    // No Notion API token is required, and saying so matters: the belief that
    // one was needed is what stopped the PO re-fetching.
    if (sources.some((s) => s.kind === 'notion')) {
      process.stdout.write('\nNotion evidence: a saved notion-fetch PAGE object (metadata + text) is\n');
      process.stdout.write('accepted, as is a block-children LIST response, as is an array of either.\n');
      process.stdout.write('No Notion API token is needed - the MCP response is the evidence. This is\n');
      process.stdout.write('the same check `deck gate approve` runs, so a source that passes here\n');
      process.stdout.write('cannot fail at approval.\n');
    }
  } else {
    process.stdout.write(`deck gate source: ${problems.length} problem(s)\n\n`);
    for (const x of problems) process.stdout.write(`  - [${x.kind}] ${x.message}\n`);
    process.stdout.write('\nA partial fetch blocks agenda approval. Finish the fetch or record what is\nmissing and tell the PO before proposing an agenda.\n');
  }
  return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
}

/** @param {any} s */
function describeSource(s) {
  return {
    id: s.id, kind: s.kind, ref: s.ref, retrieved_at: s.retrieved_at,
    complete: s.complete === true, block_count: s.block_count ?? null,
    has_more: s.pagination ? s.pagination.has_more === true : null,
    missing: (s.missing || []).length,
  };
}

/**
 * `deck gate ledger` - does every quote really occur in the source?
 * @param {string[]} argv
 */
export async function ledgerCommand(argv) {
  const json = argv.includes('--json');
  const root = requireWorkspace();
  const p = paths(root);

  // The sources must be sound first: verifying quotes against a text file
  // that is missing would pass every quote for the wrong reason.
  const src = checkSources(p);
  const { problems, checked, counts } = src.problems.length > 0
    ? { problems: [], checked: 0, counts: {} }
    : checkLedger(p);

  /** @type {{entry_id: string, kind: string, message: string}[]} */
  const all = src.problems.length > 0
    ? src.problems.map((x) => ({ entry_id: '(source)', kind: x.kind, message: x.message }))
    : problems;

  // Seal only a ledger that verified, so the seal always describes text some
  // ledger was really checked against.
  const seal = all.length === 0 ? sealSources(p) : { changed: [] };
  for (const c of seal.changed) {
    all.push({ entry_id: '(source)', kind: 'source-changed', message: c.message });
  }

  const verdict = all.length === 0 ? 'pass' : 'fail';
  writeReport({
    dir: reportDir(p),
    name: 'ledger',
    command: 'gate ledger',
    process: 'ok',
    verdict,
    summary: verdict === 'pass'
      ? `${checked} ledger entry/entries, every quote found in its cited source`
      : `${all.length} problem(s) in the ledger`,
    body: { counts: { entries: checked, problems: all.length, by_kind: counts }, problems: all },
    humanText: [
      'deck gate ledger', '', `verdict: ${verdict}`, `entries: ${checked}`, '',
      ...(all.length === 0
        ? ['Every quote was found verbatim in its cited source.']
        : ['Problems:', ...all.map((x) => `  - [${x.kind}] ${x.message}`)]),
    ].join('\n'),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ verdict, problems: all, counts }, null, 2)}\n`);
  } else if (verdict === 'pass') {
    process.stdout.write(`deck gate ledger: ${checked} entry/entries verified against source text\n`);
    for (const [kind, n] of Object.entries(counts)) process.stdout.write(`  ${kind}: ${n}\n`);
  } else {
    process.stdout.write(`deck gate ledger: ${all.length} problem(s)\n\n`);
    for (const x of all) process.stdout.write(`  - [${x.kind}] ${x.message}\n`);
    process.stdout.write('\n');
  }
  return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
}

/**
 * `deck gate agenda` - is every open item either on the agenda or excluded?
 * @param {string[]} argv
 */
export async function agendaCommand(argv) {
  const json = argv.includes('--json');
  const root = requireWorkspace();
  const p = paths(root);
  const { agenda, problems, accounted, open } = checkAgenda(p);
  const verdict = problems.length === 0 ? 'pass' : 'fail';

  writeReport({
    dir: reportDir(p),
    name: 'agenda-check',
    command: 'gate agenda',
    process: 'ok',
    verdict,
    summary: verdict === 'pass'
      ? `${(agenda?.items || []).length} agenda item(s); all ${open} open ledger item(s) accounted for`
      : `${problems.length} problem(s) in the proposed agenda`,
    body: {
      counts: { items: (agenda?.items || []).length, excluded: (agenda?.excluded || []).length, open, accounted, problems: problems.length },
      problems,
    },
    humanText: [
      'deck gate agenda', '', `verdict: ${verdict}`, '',
      ...(problems.length === 0
        ? [`${open} open ledger item(s), all either on the agenda or explicitly excluded.`]
        : ['Problems:', ...problems.map((x) => `  - [${x.kind}] ${x.message}`)]),
    ].join('\n'),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ verdict, problems }, null, 2)}\n`);
  } else if (verdict === 'pass') {
    process.stdout.write(`deck gate agenda: ${(agenda.items || []).length} item(s); ${open} open ledger item(s) all accounted for\n`);
  } else {
    process.stdout.write(`deck gate agenda: ${problems.length} problem(s)\n\n`);
    for (const x of problems) process.stdout.write(`  - [${x.kind}] ${x.message}\n`);
    process.stdout.write('\n');
  }
  return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
}

/**
 * `deck gate copy` - the readable Japanese copy sheet for gate 5.
 *
 * Writes out/copy-sheet.md and prints it, so the agent can paste it into the
 * pane and the PO can read the exact words without opening storyboard.yaml.
 *
 * @param {string[]} argv
 */
export async function copyCommand(argv) {
  const json = argv.includes('--json');
  const { p, storyboard } = loadDeck();
  const sheet = copySheet(p, storyboard);
  const file = path.join(p.out, 'copy-sheet.md');
  ensureDir(p.out);
  writeAtomic(file, sheet.text);

  writeReport({
    dir: reportDir(p),
    name: 'copy',
    command: 'gate copy',
    process: 'ok',
    // The copy sheet is a VIEW. It has no opinion, so it always passes; its
    // job is to be read by a person.
    verdict: 'pass',
    summary: `${sheet.slides.length} slide(s); ${sheet.totals.quoted} quoted fragment(s), ${sheet.totals.written} written by the agent`,
    body: { file: path.relative(p.root, file), totals: sheet.totals, slides: sheet.slides },
    humanText: sheet.text,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ verdict: 'pass', file: path.relative(p.root, file), totals: sheet.totals, slides: sheet.slides }, null, 2)}\n`);
  } else {
    process.stdout.write(sheet.text);
    process.stdout.write(`\n(${path.relative(p.root, file)} に同じ内容を書き出しました)\n`);
  }
  return EXIT.OK;
}

/**
 * `deck gate fidelity` - do the storyboard's numbers and dates trace to source?
 * @param {string[]} argv
 */
export async function fidelityCommand(argv) {
  const json = argv.includes('--json');
  const { p, storyboard } = loadDeck();
  const { findings, checked } = checkFidelity(p, storyboard);
  const blocking = findings.filter((f) => f.severity === 'block');
  const warnings = findings.filter((f) => f.severity === 'warn');
  const verdict = blocking.length === 0 ? 'pass' : 'fail';

  writeReport({
    dir: reportDir(p),
    name: 'fidelity',
    command: 'gate fidelity',
    process: 'ok',
    verdict,
    summary: verdict === 'pass'
      ? `${checked.numbers} number(s), ${checked.dates} date(s) and ${checked.cells} table cell(s) all trace to a source${warnings.length > 0 ? `; ${warnings.length} warning(s)` : ''}`
      : `${blocking.length} fragment(s) carry a number, date or table cell that appears in no source`,
    body: { counts: { ...checked, blocking: blocking.length, warnings: warnings.length }, findings },
    humanText: [
      'deck gate fidelity', '', `verdict: ${verdict}`,
      `checked: ${checked.fragments} fragment(s), ${checked.numbers} number(s), ${checked.dates} date(s), ${checked.cells} table cell(s)`, '',
      ...(findings.length === 0 ? ['Everything traces to a source.'] : findings.map(
        (f) => `  - [${f.severity}] ${f.slide_id} ${f.field}: ${f.message}${f.excerpt ? `\n      「${f.excerpt}」` : ''}`,
      )),
    ].join('\n'),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ verdict, findings, counts: checked }, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write(`deck gate fidelity: ${checked.numbers} number(s) and ${checked.dates} date(s) all trace to a source\n`);
  } else {
    process.stdout.write(`deck gate fidelity: ${blocking.length} blocking, ${warnings.length} warning(s)\n\n`);
    for (const f of findings) {
      process.stdout.write(`  - [${f.severity}] ${f.slide_id} ${f.field}: ${f.message}\n`);
      if (f.excerpt) process.stdout.write(`      「${f.excerpt}」\n`);
    }
    process.stdout.write('\n');
  }
  return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
}

/**
 * `deck gate inbox` - import whatever the PO dropped, without asking them to
 * match file names to slot ids by hand.
 *
 * The illustration handover is the one place in the flow where the PO has to
 * do something outside the pane. It fails when it is vague: "import the images
 * when they come back" leaves them holding seven files and a list of slot ids.
 * So the brief `deck prompts --single` emits already names each image
 * NN-<slide-id>-<slot-id>.png, and this command reads those names back.
 *
 * THE SLIDE ID IS IN THE NAME because `col-1-art` is a POSITION on a page
 * type, not one picture. A deck with four three-column slides wants twelve
 * illustrations and three of them are "the first column's"; matching on the
 * slot id alone would hand all three to whichever slide sorted first, and an
 * illustration on the wrong page renders perfectly cleanly - no rule here can
 * see it.
 *
 * MATCHING, in order, stopping at the first that is unambiguous:
 *   1. NN-<slide-id>-<slot-id>.<ext>  - exactly what the brief asked for
 *   2. <slide-id>-<slot-id>.<ext>     - the brief's name, number dropped
 *   3. NN-<slot-id>.<ext>             - the name briefs emitted before slots
 *                                       were addressed by slide. Accepted so
 *                                       a PO holding an older brief is not
 *                                       stranded; it can only be matched when
 *                                       exactly one slot in the deck has that
 *                                       id, like every other bare reference.
 *   4. <slot-id>.<ext>
 *   5. a file name CONTAINING the slide-and-slot token, when exactly one does
 *
 * Anything it cannot place is listed, with the slot ids still empty, rather
 * than guessed at. A wrong illustration in the right slot is worse than a
 * missing one: lint cannot see it.
 *
 * @param {string[]} argv
 */
export async function inboxCommand(argv) {
  const json = argv.includes('--json');
  const dirArg = argv.indexOf('--dir');
  const { root, p, storyboard } = loadDeck();
  const dir = dirArg >= 0 ? path.resolve(argv[dirArg + 1] || '') : p.inbox;
  if (dirArg >= 0 && !argv[dirArg + 1]) usage('deck gate inbox --dir needs a directory');

  const slots = storyboard.slides.flatMap((s) => (s.slots || []).map((sl) => ({ slide: s.id, ...sl })));
  ensureDir(dir);
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .filter((f) => fs.statSync(path.join(dir, f)).isFile());

  /** @type {{slot: string, file: string, how: string}[]} */
  const matched = [];
  /** @type {string[]} */
  const unplaced = [];
  const taken = new Set();

  /** @type {{slot: string, candidates: string[]}[]} */
  const ambiguous = [];
  for (const slot of slots) {
    if (slot.reuse_unchanged === true) continue;
    // EVERY match at each level, not the first one. find() silently took an
    // arbitrary file when two matched - so 01-hero.png and 02-hero.png would
    // import whichever readdir happened to return first, and the wrong
    // illustration in the right slot renders cleanly: lint cannot see it.
    const token = slotFileToken(slot.slide, slot.id);
    // A BARE SLOT ID IS ONLY A SAFE MATCH WHEN ONE SLOT HAS IT. Two slides
    // with a col-1-art each must not race for `01-col-1-art.png`.
    const uniqueBare = slots.filter((o) => o.id === slot.id).length === 1;
    const levels = [
      ['brief-name', files.filter((f) => new RegExp(`^\\d+-${escapeRe(token)}\\.`, 'i').test(f))],
      ['slide-and-slot', files.filter((f) => new RegExp(`^${escapeRe(token)}\\.`, 'i').test(f))],
      ['legacy-brief-name', uniqueBare ? files.filter((f) => new RegExp(`^\\d+-${escapeRe(slot.id)}\\.`, 'i').test(f)) : []],
      ['legacy-slot-id', uniqueBare ? files.filter((f) => new RegExp(`^${escapeRe(slot.id)}\\.`, 'i').test(f)) : []],
      ['contains-slide-and-slot', files.filter((f) => f.toLowerCase().includes(token.toLowerCase()))],
    ];
    const hit = levels.find(([, fs2]) => fs2.length > 0) || ['none', []];
    const how = hit[0];
    const level = hit[1];
    const free = level.filter((f) => !taken.has(f));
    if (free.length === 0) continue;
    if (free.length > 1) {
      // Refused, not guessed. The PO is told which files collided so they can
      // delete the one they did not mean.
      ambiguous.push({ slot: slotKey(slot.slide, slot.id), candidates: free });
      for (const f of free) taken.add(f);
      continue;
    }
    taken.add(free[0]);
    matched.push({ slot: slotKey(slot.slide, slot.id), file: free[0], how });
  }
  for (const f of files) if (!taken.has(f)) unplaced.push(f);

  /** @type {{slot: string, file: string, status: number}[]} */
  const results = [];
  for (const m of matched) {
    // Through the real import command, so the sha256 recording, the
    // containment check and the manifest update are the same code path a hand
    // import takes.
    const status = await assetsCommand(['import', m.slot, path.join(dir, m.file)]);
    results.push({ slot: m.slot, file: m.file, status });
  }

  const failed = results.filter((r) => r.status !== EXIT.OK);
  const ambiguousNote = ambiguous.map(
    (a) => `slot "${a.slot}" matches ${a.candidates.length} files (${a.candidates.join(', ')}) - deck will not choose between them`,
  );
  const stillEmpty = slots
    .filter((s) => s.reuse_unchanged !== true)
    .filter((s) => !results.some((r) => r.slot === slotKey(s.slide, s.id) && r.status === EXIT.OK))
    .map((s) => slotKey(s.slide, s.id));
  const verdict = failed.length === 0 && unplaced.length === 0 && ambiguous.length === 0 ? 'pass' : 'fail';

  writeReport({
    dir: reportDir(p),
    name: 'inbox',
    command: 'gate inbox',
    process: 'ok',
    verdict,
    summary: `${results.length - failed.length} image(s) imported from ${path.relative(root, dir) || '.'}; ${stillEmpty.length} slot(s) still empty; ${unplaced.length} file(s) could not be placed`,
    body: { dir: path.relative(root, dir), imported: results, unplaced, ambiguous, still_empty: stillEmpty },
    humanText: [
      'deck gate inbox', '', `verdict: ${verdict}`, `directory: ${dir}`, '',
      ...results.map((r) => `  ${r.status === 0 ? 'imported' : 'FAILED  '} ${r.slot} <- ${r.file}`),
      ...(ambiguousNote.length > 0 ? ['', 'AMBIGUOUS - refused rather than guessed:', ...ambiguousNote.map((x) => `  - ${x}`)] : []),
      ...(unplaced.length > 0 ? ['', 'Could not be placed (no slot id in the name):', ...unplaced.map((f) => `  - ${f}`)] : []),
      ...(stillEmpty.length > 0 ? ['', 'Slots still empty:', ...stillEmpty.map((s) => `  - ${s}`)] : []),
    ].join('\n'),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ verdict, imported: results, unplaced, ambiguous, still_empty: stillEmpty }, null, 2)}\n`);
  } else {
    process.stdout.write(`deck gate inbox: ${dir}\n`);
    for (const r of results) process.stdout.write(`  ${r.status === 0 ? 'imported' : 'FAILED  '} ${r.slot} <- ${r.file}\n`);
    for (const x of ambiguousNote) process.stdout.write(`  AMBIGUOUS: ${x}\n`);
    for (const f of unplaced) process.stdout.write(`  unplaced: ${f} (no slot id in the name)\n`);
    if (stillEmpty.length > 0) process.stdout.write(`  still empty: ${stillEmpty.join(', ')}\n`);
  }
  return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `deck gate <name>` dispatch.
 *
 * The deterministic commands moved behind this verb so the new top-level
 * launcher verbs cannot collide with them: `deck "来週のMTG資料"` is a task,
 * and `deck gate render` is a gate. See the launcher's usage.
 *
 * @type {Record<string, (argv: string[]) => Promise<number>>}
 */
export const INTAKE_COMMANDS = {
  source: sourceCommand,
  ledger: ledgerCommand,
  agenda: agendaCommand,
  copy: copyCommand,
  fidelity: fidelityCommand,
  inbox: inboxCommand,
};

/** @param {string[]} argv */
export async function intakeDispatch(argv) {
  const [name, ...rest] = argv;
  const fn = INTAKE_COMMANDS[name];
  if (!fn) usage(`unknown intake gate "${name || ''}"`, [`Known: ${Object.keys(INTAKE_COMMANDS).join(', ')}`]);
  return fn(rest);
}
