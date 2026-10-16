import fs from 'node:fs';
import path from 'node:path';
import { loadDeck, resolveAssets } from '../deck.js';
import { contentDigest, renderFingerprint, renderOptions } from '../digest.js';
import { verifyArtifacts } from '../publish.js';
import { pdfPageCount, pngSize } from '../render/raster.js';
import { DeckError, EXIT, usage } from '../util/fail.js';
import { readJson, readJsonIfExists } from '../util/fs.js';
import { writeReport } from '../util/report.js';

/**
 * `deck export` - PDF plus per-page PNGs.
 *
 * It renders nothing. It verifies that what `deck render` produced is
 * complete, current and internally consistent, and then lists it. The
 * separation matters: an export that re-rendered could hand over a PDF nobody
 * has linted.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function exportCommand(argv) {
  const json = argv.includes('--json');
  for (const a of argv) {
    if (a !== '--json') usage(`unknown option for deck export: ${a}`);
  }

  const { root, p, storyboard, theme, request, manifest } = loadDeck();
  /** @type {string[]} */
  const problems = [];

  if (!fs.existsSync(p.pdf)) {
    throw new DeckError('there is nothing to export', EXIT.ENVIRONMENT, [
      `Expected: ${p.pdf}`,
      'Run `deck render` first. `deck export` deliberately does not render: an export that rendered could hand over a PDF nobody has linted.',
    ]);
  }
  if (!fs.existsSync(p.geometry)) {
    problems.push('out/geometry.json is missing, so deck cannot confirm the PDF matches the current storyboard');
  }

  const geometry = fs.existsSync(p.geometry) ? readJson(p.geometry) : null;
  const current = contentDigest(storyboard);
  const options = renderOptions(request, theme);
  const scaleForFp = options.png_scale;
  const expectedFingerprint = renderFingerprint({
    storyboard,
    theme,
    themeCss: fs.readFileSync(theme.__css, 'utf8'),
    assets: resolveAssets(root, manifest, storyboard),
    scale: scaleForFp,
    options,
  });
  if (geometry && geometry.content_digest !== current) {
    problems.push(`the rendered output is from content digest ${geometry.content_digest}, but the storyboard is now ${current} - re-run deck render`);
  }
  if (geometry && geometry.render_fingerprint !== expectedFingerprint) {
    problems.push(`the rendered output is from render ${geometry.render_fingerprint || '(none recorded)'}, but this deck would now render as ${expectedFingerprint}. A theme, layout, slot-geometry or asset change moves boxes without changing content - re-run deck render.`);
  }

  // THE DELIVERED BYTES. A page count and a set of dimensions do not
  // distinguish a complete render from a half-published mixture of two.
  problems.push(...verifyArtifacts(p, expectedFingerprint));

  const pages = pdfPageCount(p.pdf);
  if (pages !== storyboard.slides.length) {
    problems.push(`out/deck.pdf has ${pages} page(s) but the storyboard has ${storyboard.slides.length} slide(s)`);
  }

  const scale = options.png_scale;
  const expected = { w: Math.round(theme.canvas.width * scale), h: Math.round(theme.canvas.height * scale) };
  // Width is exact; height carries a few pixels of slack because Chrome
  // quantises the PDF page height - see the long note in render/raster.js.
  // What matters for a deliverable is that every page is the SAME size, and
  // that is checked exactly.
  const HEIGHT_SLACK = 4;
  /** @type {{file: string, width: number, height: number, slide_id: string}[]} */
  const pngs = [];
  storyboard.slides.forEach((slide, i) => {
    const f = path.join(p.outPng, `${String(i + 1).padStart(3, '0')}.png`);
    if (!fs.existsSync(f)) {
      problems.push(`out/png/${String(i + 1).padStart(3, '0')}.png is missing (slide "${slide.id}")`);
      return;
    }
    const size = pngSize(f);
    if (size.width !== expected.w || Math.abs(size.height - expected.h) > HEIGHT_SLACK) {
      problems.push(`out/png/${String(i + 1).padStart(3, '0')}.png is ${size.width}x${size.height}, expected ${expected.w}x${expected.h} (height may differ by up to ${HEIGHT_SLACK} px: Chrome quantises the PDF page height)`);
    }
    pngs.push({ file: path.relative(root, f), width: size.width, height: size.height, slide_id: slide.id });
  });
  const distinctSizes = [...new Set(pngs.map((x) => `${x.width}x${x.height}`))];
  if (distinctSizes.length > 1) {
    problems.push(`the page PNGs are not all the same size (${distinctSizes.join(', ')}); the design kit requires every page image at one uniform size`);
  }

  // The lint verdict is reported, not enforced. Whether to ship a deck with
  // known findings is the PO's call, and an export that refused would just get
  // worked around. What it must not do is stay quiet about it.
  const lint = readJsonIfExists(path.join(p.outLint, 'report.json'));
  // WHICH RENDER DID THAT VERDICT INSPECT? Reporting a pass without checking
  // was how a stale report vouched for output it had never seen.
  if (lint && lint.render_fingerprint !== expectedFingerprint) {
    problems.push(`out/lint/report.json inspected render ${lint.render_fingerprint || '(none recorded)'}, not the current ${expectedFingerprint}. Its verdict says nothing about this output - re-run deck lint.`);
  }
  if (lint && lint.process !== 'ok') {
    problems.push(`the last lint run did not complete (process "${lint.process}"), so there is no verdict for this output`);
  }

  const verdict = problems.length === 0 ? 'pass' : 'fail';
  const written = writeReport({
    dir: p.out,
    name: 'export',
    command: 'export',
    process: 'ok',
    verdict,
    summary: verdict === 'pass'
      ? `${pages} page PDF and ${pngs.length} PNG(s), matching the current storyboard`
      : `${problems.length} problem(s) with the rendered output`,
    body: {
      pdf: { file: path.relative(root, p.pdf), pages, bytes: fs.statSync(p.pdf).size },
      png: pngs,
      png_scale: scale,
      content_digest: current,
      render_fingerprint: expectedFingerprint,
      release: geometry ? geometry.release === true : null,
      // Asset hashes survive from the manifest, through geometry.json, to here.
      assets: geometry ? geometry.assets : null,
      lint: lint
        ? {
          process: lint.process,
          verdict: lint.verdict,
          blocking: lint.counts?.blocking,
          render_fingerprint: lint.render_fingerprint ?? null,
          inspected_this_render: lint.render_fingerprint === expectedFingerprint,
        }
        : null,
      problems,
    },
    humanText: [
      'deck export',
      '',
      `verdict: ${verdict}`,
      `pdf:     ${p.pdf} (${pages} pages)`,
      `png:     ${pngs.length} files at ${expected.w}x${expected.h}`,
      `lint:    ${lint ? `process ${lint.process}, verdict ${lint.verdict}, ${lint.counts?.blocking} blocking` : 'never run'}`,
      '',
      ...(problems.length ? ['Problems:', ...problems.map((x) => `  - ${x}`)] : ['No problems.']),
    ].join('\n'),
  });

  if (json) {
    process.stdout.write(fs.readFileSync(written.json, 'utf8'));
    return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
  }

  process.stdout.write('deck export\n\n');
  process.stdout.write(`  pdf   ${path.relative(process.cwd(), p.pdf) || p.pdf}  (${pages} page(s), ${fs.statSync(p.pdf).size} bytes)\n`);
  process.stdout.write(`  png   ${pngs.length} file(s) at ${distinctSizes.join(', ') || '(none)'} in ${path.relative(process.cwd(), p.outPng) || p.outPng}\n`);
  for (const png of pngs) {
    process.stdout.write(`        ${path.basename(png.file)}  ${png.slide_id}\n`);
  }
  if (!lint) {
    process.stdout.write('\n  lint  NEVER RUN. Nothing has checked this deck\'s geometry.\n');
  } else {
    process.stdout.write(`\n  lint  process ${lint.process}, verdict ${lint.verdict}, ${lint.counts?.blocking ?? '?'} blocking finding(s)\n`);
    if (lint.verdict !== 'pass') {
      process.stdout.write('        Exported anyway: whether to ship a deck with known findings is your call.\n');
      process.stdout.write(`        The findings are in ${path.relative(process.cwd(), path.join(p.outLint, 'report.json'))}.\n`);
    }
  }
  if (problems.length > 0) {
    process.stdout.write('\n  problems\n');
    for (const x of problems) process.stdout.write(`    - ${x}\n`);
  }
  process.stdout.write('\n');
  return verdict === 'pass' ? EXIT.OK : EXIT.VERDICT_FAILED;
}
