import fsSync from 'node:fs';
import path from 'node:path';
import { assertInside, writeAtomic, writeJson } from './fs.js';

/**
 * squad keeps the PROCESS status and the SEMANTIC verdict in two different
 * files, because a helper can write pass-shaped JSON and still exit non-zero -
 * the runner died after writing the result - and anything that read only the
 * JSON published a clean pass for a run that never completed.
 *
 * deck does the same. Every deterministic command writes:
 *
 *   <name>-status.txt   one line: the process exit status. 0 means "this
 *                   command ran to completion", and nothing more. The name
 *                   follows squad's <step>-status.txt.
 *   <name>.json     the machine-readable report, whose `verdict` field is the
 *                   semantic answer.
 *
 * The report also carries `process` so a single file is self-describing, and
 * `verdict` is forced to "fail" whenever the process did not complete. A
 * reader that looks only at `verdict` can never mistake a crashed run for an
 * approving one.
 *
 * @typedef {'ok' | 'failed'} ProcessState
 * @typedef {'pass' | 'fail' | 'none'} Verdict
 */

/**
 * @param {object} opts
 * @param {string} opts.dir            directory to write into
 * @param {string} opts.name           base name, e.g. "report" or "validate"
 * @param {string} opts.command        the deck subcommand that produced this
 * @param {ProcessState} opts.process
 * @param {Verdict} opts.verdict
 * @param {string} opts.summary        one human line
 * @param {object} [opts.body]         command-specific payload
 * @param {string} [opts.humanText]    readable summary written next to the JSON
 * @returns {{json: string, status: string, human: string | null, verdict: Verdict, process: ProcessState}}
 */
export function writeReport(opts) {
  const { dir, name, command, summary, body = {}, humanText = null } = opts;
  const processState = opts.process;
  // A process that did not complete has no verdict to publish. Forcing it here
  // rather than trusting the caller is deliberate: this is the last line of
  // defence before a reader keys off the file.
  const verdict = processState === 'ok' ? opts.verdict : 'fail';
  const jsonFile = path.join(dir, `${name}.json`);
  const statusFile = path.join(dir, `${name}-status.txt`);
  const humanFile = humanText === null ? null : path.join(dir, `${name}.txt`);

  const payload = {
    schema: 'deck.report/1',
    command,
    // Distinct on purpose. `process` answers "did this command run?" and
    // `verdict` answers "did the thing it inspected pass?".
    process: processState,
    verdict,
    summary: processState === 'ok'
      ? summary
      : `[deck ${command} FAILED to complete] ${summary} The verdict below is "fail" because the command did not finish, NOT because it inspected anything and rejected it.`,
    generated_at: new Date().toISOString(),
    ...body,
  };
  writeJson(jsonFile, payload);
  writeAtomic(statusFile, `${processState === 'ok' ? 0 : 4}\n`);
  if (humanFile) writeAtomic(humanFile, humanText.endsWith('\n') ? humanText : `${humanText}\n`);
  return { json: jsonFile, status: statusFile, human: humanFile, verdict, process: processState };
}

/**
 * Record that a command FAILED, and invalidate the success it is replacing.
 *
 * The gap this closes: the CLI used to print an exception and return an exit
 * code, and nothing else. So after a successful `deck lint`, a later run that
 * died - malformed geometry, a load failure, a crash - left the PREVIOUS
 * report.json saying `verdict: pass` and the previous report-status.txt saying
 * `0`. Anything reading those files, which is exactly what they exist for,
 * saw a clean pass for a run that had just failed.
 *
 * squad protects against the same thing by clearing a status file before the
 * step runs and writing it exactly once on the way out. deck's equivalent is
 * this: on any failure, publish a report that says the process failed, with
 * the verdict forced to "fail" by writeReport.
 *
 * Best effort by construction - the workspace may be unwritable, which is
 * often WHY the command failed - but it never masks the original error.
 *
 * @param {object} opts
 * @param {string} opts.outDir       the deck's out/ directory
 * @param {string} opts.command
 * @param {string} [opts.reportName] the report this invocation owns, when the
 *   command writes more than one. `prompts --single` writes
 *   prompts-single.json, and a failure that replaced prompts.json instead
 *   left the previous prompts-single.json saying pass with status 0.
 * @param {string} opts.message
 * @param {string[]} [opts.details]
 * @param {number} [opts.code]
 * @returns {string | null} the report written, or null
 */
export function recordFailure({ outDir, root, command, reportName, message, details = [], code }) {
  try {
    if (!outDir) return null;
    // CONTAINMENT APPLIES TO FAILURE HANDLING TOO.
    //
    // This used to write unconditionally, so a render refused BECAUSE out/
    // was a symlink out of the workspace then had its failure report written
    // through that very symlink. The error path must obey the same rule as
    // the success path, or the rule is not a rule.
    if (root) assertInside(outDir, root, 'the output directory');
    fsSync.mkdirSync(outDir, { recursive: true });

    // The command's OWN report name, so a failed lint replaces the lint
    // report rather than leaving it next to a generic failure file.
    const name = REPORT_NAMES[command];
    if (name) {
      const base = reportName || name.base;
      const dir = name.dir === 'lint' ? path.join(outDir, 'lint') : outDir;
      if (root) assertInside(dir, root, 'the failure report directory');
      fsSync.mkdirSync(dir, { recursive: true });
      writeReport({
        dir,
        name: base,
        command,
        process: 'failed',
        verdict: 'fail',
        summary: message,
        body: { details, exit_code: code ?? null },
        humanText: [`deck ${command}`, '', 'THIS RUN DID NOT COMPLETE.', '', message, ...details.map((d) => `  ${d}`)].join('\n'),
      });
      return path.join(dir, `${base}.json`);
    }
    return null;
  } catch {
    // Never let failure bookkeeping replace the real error.
    return null;
  }
}

/**
 * Which report each command owns, so a failure replaces the right one.
 * A command with no report here writes none - `deck init` has no out/ yet.
 */
const REPORT_NAMES = {
  lint: { dir: 'lint', base: 'report' },
  render: { dir: 'out', base: 'render' },
  validate: { dir: 'out', base: 'validate' },
  export: { dir: 'out', base: 'export' },
  prompts: { dir: 'out', base: 'prompts' },
};
