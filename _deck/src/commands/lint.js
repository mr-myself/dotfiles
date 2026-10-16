import fs from 'node:fs';
import path from 'node:path';
import { loadDeck, resolveAssets } from '../deck.js';
import { contentDigest, renderFingerprint, renderOptions } from '../digest.js';
import { checkGeometry } from '../lint/geometry-check.js';
import { formatHumanReport, runLint } from '../lint/engine.js';
import { verifyArtifacts } from '../publish.js';
import { isBlocking } from '../lint/finding.js';
import { DeckError, EXIT, usage } from '../util/fail.js';
import { emptyDir, readJson } from '../util/fs.js';
import { writeReport } from '../util/report.js';

/**
 * `deck lint` - the layout gate, on real geometry.
 *
 * PROCESS and VERDICT are separate, following squad exactly. A lint run that
 * completed and found violations is a SUCCESSFUL PROCESS with a FAILING
 * VERDICT: `lint-status.txt` holds 0 and `report.json` says `verdict: fail`.
 * A lint run that crashed writes `lint-status.txt` 4 and a report whose
 * verdict is forced to `fail` with the reason stated, because it has no
 * verdict of its own. Conflating the two is how a crashed gate gets read as a
 * clean one.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function lintCommand(argv) {
  const json = argv.includes('--json');
  for (const a of argv) {
    if (a !== '--json') usage(`unknown option for deck lint: ${a}`);
  }

  const { root, p, storyboard, theme, manifest, request } = loadDeck();

  if (!fs.existsSync(p.geometry)) {
    throw new DeckError('there is no geometry to lint', EXIT.ENVIRONMENT, [
      `Expected: ${p.geometry}`,
      'Run `deck render` first. deck lints MEASURED geometry, never a guess at what the page would look like.',
    ]);
  }
  const geometry = readJson(p.geometry);

  // THE RENDER FINGERPRINT, not the content digest.
  //
  // Content alone was the wrong key: it deliberately excludes the theme, the
  // CSS, layout line breaks, slot geometry and which asset fills a slot, so
  // editing any of those left this check satisfied while every box on every
  // page had moved. The fingerprint covers all of it.
  const options = renderOptions(request, theme);
  const assets = resolveAssets(root, manifest, storyboard);
  const expected = renderFingerprint({
    storyboard,
    theme,
    themeCss: fs.readFileSync(theme.__css, 'utf8'),
    assets,
    scale: options.png_scale,
    options,
  });
  if (geometry.render_fingerprint !== expected) {
    throw new DeckError('the measured geometry is from a different render', EXIT.ENVIRONMENT, [
      `geometry.json was measured from render ${geometry.render_fingerprint || '(none recorded - rendered by an older deck)'}`,
      `this deck would now render as          ${expected}`,
      geometry.content_digest === contentDigest(storyboard)
        ? 'The WORDS are unchanged, so this is a theme, layout, slot-geometry or asset change. Those move boxes without changing content.'
        : 'The storyboard\'s content has changed too.',
      'Run `deck render` again so the geometry matches what you are linting.',
    ]);
  }
  if (geometry.media !== 'print') {
    throw new DeckError(`the geometry was measured under "${geometry.media}" media, not print`, EXIT.ENVIRONMENT, [
      'Chrome exports its PDF under print media, so a screen-media measurement does not describe the delivered page.',
      'Re-run `deck render`.',
    ]);
  }

  // THE MEASUREMENTS ARE CHECKED BEFORE ANY RULE RUNS.
  //
  // Every rule skips what it cannot measure, so malformed geometry produced
  // silence and silence reads as a pass. This refuses instead.
  const structural = checkGeometry(geometry, storyboard);
  if (structural.length > 0) {
    throw new DeckError(
      `out/geometry.json is not usable (${structural.length} problem(s))`,
      EXIT.ENVIRONMENT,
      [...structural, '', 'Re-run `deck render`. deck will not report a verdict on measurements it cannot read.'],
    );
  }

  // The DELIVERED BYTES, not just the inputs. The render fingerprint
  // identifies what was asked for; this confirms that the files on disk are
  // the ones that render actually produced, which is what catches a
  // part-published mixture.
  const artifactProblems = verifyArtifacts(p, expected);
  if (artifactProblems.length > 0) {
    throw new DeckError(
      `the published output does not match the render that produced it (${artifactProblems.length} problem(s))`,
      EXIT.ENVIRONMENT,
      [...artifactProblems, '', 'Re-run `deck render`.'],
    );
  }

  emptyDir(p.outLint, root);
  const annotationDir = path.join(p.outLint, 'annotated');
  /** @type {Record<string, string>} */
  const pngBySlide = {};
  storyboard.slides.forEach((s, i) => {
    const f = path.join(p.outPng, `${String(i + 1).padStart(3, '0')}.png`);
    if (fs.existsSync(f)) pngBySlide[s.id] = f;
  });

  const result = runLint({
    slides: geometry.slides,
    theme,
    storyboard,
    annotationDir,
    pngBySlide,
  });

  const blocking = result.findings.filter(isBlocking);
  const verdict = blocking.length === 0 ? 'pass' : 'fail';

  const written = writeReport({
    dir: p.outLint,
    name: 'report',
    command: 'lint',
    process: 'ok',
    verdict,
    summary: verdict === 'pass'
      ? `${result.summary.slides} slide(s) pass all ${result.summary.rules_total} rules (${result.summary.suggestions} suggestion(s))`
      : `${blocking.length} blocking finding(s) across ${result.summary.slides} slide(s)`,
    body: {
      theme: theme.name,
      content_digest: contentDigest(storyboard),
      // Binds this verdict to the exact render it inspected, so `deck export`
      // can refuse a report that describes a different one.
      render_fingerprint: expected,
      counts: {
        blocking: blocking.length,
        suggestions: result.summary.suggestions,
        slides: result.summary.slides,
        rules_run: result.summary.rules_run,
        rules_total: result.summary.rules_total,
      },
      rule_status: result.summary.rule_status,
      by_rule: result.summary.by_rule,
      honest_limits: result.summary.honest_limits,
      findings: result.findings,
    },
    humanText: formatHumanReport(result, verdict),
  });

  if (json) {
    process.stdout.write(`${fs.readFileSync(written.json, 'utf8')}`);
  } else {
    process.stdout.write(`${formatHumanReport(result, verdict)}\n\n`);
    process.stdout.write(`report:   ${path.relative(process.cwd(), written.json) || written.json}\n`);
    process.stdout.write(`readable: ${path.relative(process.cwd(), written.human) || written.human}\n`);
    process.stdout.write(`status:   ${path.relative(process.cwd(), written.status) || written.status}  (the PROCESS exit code, not the verdict)\n`);
    if (fs.existsSync(annotationDir)) {
      const n = fs.readdirSync(annotationDir).length;
      if (n > 0) process.stdout.write(`evidence: ${path.relative(process.cwd(), annotationDir) || annotationDir}  (${n} annotated PNG(s))\n`);
    }
  }

  return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
}
