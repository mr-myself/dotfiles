import { execFileSync, spawnSync, execFileSync as run } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { environment, processFailed } from '../util/fail.js';
import { emptyDir } from '../util/fs.js';

/**
 * Rasterize the PDF with pdftoppm.
 *
 * The PNGs are made FROM THE PDF rather than from a second browser
 * screenshot, so the delivered images and the delivered PDF cannot disagree.
 * A screenshot would be a third rendering of the same page, and a third
 * rendering is a third chance to differ.
 *
 * CSS pixels are 1/96 inch, so a 2x PNG is simply 192 dpi. Deriving it rather
 * than hard-coding a dpi means a theme that changes render_scale needs no
 * change here.
 *
 * FRACTIONAL SCALES ARE REFUSED, NOT ROUNDED. The DPI used to be
 * Math.round(96 * scale) while the width was checked against the UNROUNDED
 * scale, so a schema-legal scale of 1.1 asked pdftoppm for 106 dpi, got
 * ~1847 px, and was then compared against 1839 px and failed with a confusing
 * message about a raster size. pdftoppm takes an integer -r, so the honest
 * fix is to accept only scales that produce one: the supported set is any
 * scale where 96 x scale is a whole number, which is every sensible value
 * (1, 1.25, 1.5, 2, 2.5, 3, 4) and excludes the ones that cannot work.
 *
 * @param {object} opts
 * @param {string} opts.pdf
 * @param {string} opts.outDir
 * @param {number} opts.scale
 * @param {number} opts.expectedPages
 * @param {number} opts.canvasWidth
 * @param {number} opts.canvasHeight
 * @param {string} [opts.root] workspace, for the containment check
 * @returns {{files: string[], dpi: number, pages: number, sizes: object[], page_height_px: number}}
 */
export const USABLE_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function rasterize({ pdf, outDir, scale, expectedPages, canvasWidth, canvasHeight, root }) {
  const exactDpi = 96 * scale;
  // Tolerate binary-float noise (96 * 1.1 is 105.60000000000001) but refuse a
  // genuinely fractional DPI.
  const dpi = Math.round(exactDpi);
  if (Math.abs(exactDpi - dpi) > 1e-6) {
    environment(`a PNG scale of ${scale} needs ${exactDpi} dpi, which pdftoppm cannot do`, [
      'pdftoppm takes an integer -r, so deck only supports scales where 96 x scale is a whole number.',
      `Usable scales: ${USABLE_SCALES.join(', ')}.`,
      `Nearest usable: ${USABLE_SCALES.reduce((best, c) => (Math.abs(c - scale) < Math.abs(best - scale) ? c : best))}.`,
    ]);
  }
  requireTool('pdftoppm');

  const pages = pdfPageCount(pdf);
  if (pages !== expectedPages) {
    // Page count is the one thing about a deck that must never be wrong, and
    // it is cheap to check. Reported as a process failure, not a verdict: the
    // render did not produce the artifact it was asked for.
    processFailed(
      `the rendered PDF has ${pages} page(s) but the storyboard has ${expectedPages} slide(s)`,
      ['This is deck\'s own bug or a Chrome pagination change, not a content problem. The PNGs were not written.'],
    );
  }

  emptyDir(outDir, root);
  const prefix = path.join(outDir, 'page');
  try {
    run('pdftoppm', ['-png', '-r', String(dpi), pdf, prefix], { stdio: 'pipe' });
  } catch (err) {
    processFailed('pdftoppm failed to rasterize the PDF', [
      String(err && err.stderr ? err.stderr.toString() : err.message),
    ]);
  }

  // pdftoppm zero-pads to the width of the page count; rename to a stable
  // 3-digit sequence so out/png sorts correctly whatever the deck's length.
  const produced = fs.readdirSync(outDir)
    .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
    .sort((a, b) => pageIndex(a) - pageIndex(b));
  if (produced.length !== expectedPages) {
    processFailed(
      `pdftoppm produced ${produced.length} PNG(s) for a ${expectedPages}-page PDF`,
      [`Files: ${produced.join(', ') || '(none)'}`],
    );
  }
  /** @type {string[]} */
  const files = [];
  produced.forEach((f, i) => {
    const target = path.join(outDir, `${String(i + 1).padStart(3, '0')}.png`);
    fs.renameSync(path.join(outDir, f), target);
    files.push(target);
  });

  // Dimensions are an assertion, not a hope: a wrong scale silently misplaces
  // every annotation box, because annotate() derives its factor from the image.
  //
  // WIDTH IS EXACT. HEIGHT IS NOT, AND THAT IS CHROME.
  //
  // Measured on Chrome 154 for a 1672-px-wide canvas: the PDF page width comes
  // out at exactly 1254 pt (1672 x 0.75) for every height tried, but the page
  // HEIGHT is quantised. Requesting 941 px should give 705.75 pt and gives
  // 706.08; 940 px should give 705.00 and gives 705.12; 942 should give 706.50
  // and gives 707.04. Heights of 944, 960 and 1080 px come out exact. The same
  // numbers appear whether the size is set via @page, via page.pdf()'s
  // width/height, in inches, or with preferCSSPageSize either way - so it is
  // not something deck can ask Chrome not to do.
  //
  // The consequence is a page up to ~0.5 px TALLER than the canvas, appearing
  // as a sliver of extra white at the BOTTOM. Content positions measured from
  // the top are unaffected, and annotate() takes its scale from the width, so
  // every box still lands where it was measured. Hence: width checked exactly,
  // height allowed a few pixels, and the measured values recorded in the
  // report rather than rounded away.
  const expectedW = Math.round(canvasWidth * scale);
  const expectedH = Math.round(canvasHeight * scale);
  const HEIGHT_SLACK = 4;
  /** @type {{file: string, width: number, height: number}[]} */
  const sizes = [];
  for (const f of files) {
    const dims = pngSize(f);
    sizes.push({ file: path.basename(f), width: dims.width, height: dims.height });
    if (dims.width !== expectedW) {
      processFailed(
        `${path.basename(f)} is ${dims.width} px wide, but ${scale}x of a ${canvasWidth} px canvas is ${expectedW} px`,
        ['The raster width is exact in Chrome, so a mismatch here is a real bug, and it would misplace every annotated lint box.'],
      );
    }
    // HEIGHT_SLACK used to be declared here and then never used: only `deck
    // export` compared heights, so a render could publish pages of the wrong
    // height and only a later command would notice.
    if (Math.abs(dims.height - expectedH) > HEIGHT_SLACK) {
      processFailed(
        `${path.basename(f)} is ${dims.height} px tall, but ${scale}x of a ${canvasHeight} px canvas is ${expectedH} px (tolerance ${HEIGHT_SLACK} px)`,
        ['Chrome quantises the PDF page height by up to about half a pixel; a larger difference is a real problem.'],
      );
    }
  }
  const heights = [...new Set(sizes.map((s) => s.height))];
  if (heights.length > 1) {
    processFailed(
      `the rasterized pages are not all the same height: ${heights.join(', ')}`,
      ['Every delivered PNG must be the same size.'],
    );
  }

  return { files, dpi, pages, sizes, height_slack_px: HEIGHT_SLACK, page_height_px: heights[0] };
}

function pageIndex(name) {
  const m = name.match(/page-(\d+)\.png$/);
  return m ? Number(m[1]) : 0;
}

/** @param {string} pdf */
export function pdfPageCount(pdf) {
  requireTool('pdfinfo');
  const out = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
  const m = out.match(/^Pages:\s+(\d+)/m);
  if (!m) processFailed(`pdfinfo did not report a page count for ${pdf}`);
  return Number(m[1]);
}

/**
 * PNG dimensions straight out of the IHDR chunk. No decoding, no dependency.
 * @param {string} file
 */
export function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.readUInt32BE(0) !== 0x89504e47) {
      return { width: 0, height: 0, problem: 'not a PNG' };
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The first line of a tool's `-v` output.
 *
 * poppler's tools print their version banner to STDERR and exit 0, so reading
 * only stdout reports a successfully-probed tool as having no version. Both
 * streams are merged for that reason.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function toolVersion(name) {
  try {
    // 2>&1 via stdio is not expressible here, so stderr is read from the
    // thrown error when the tool writes there and exits non-zero, and merged
    // explicitly when it writes there and exits 0.
    const res = spawnSync(name, ['-v'], { encoding: 'utf8' });
    if (res.error) throw res.error;
    return firstLine(res.stdout) || firstLine(res.stderr);
  } catch (err) {
    const stdout = err && err.stdout ? err.stdout.toString() : '';
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    return firstLine(stdout) || firstLine(stderr);
  }
}

function firstLine(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line || null;
}

/**
 * Is the tool on PATH?
 *
 * DELIBERATELY NOT `execFileSync('command', ['-v', name], { shell: ... })`:
 * passing args alongside `shell: true` concatenates them unescaped, which Node
 * warns about (DEP0190) and which would be a real injection seam if a tool
 * name ever came from input. Spawning the tool directly and reading ENOENT
 * answers the same question with no shell at all.
 *
 * @param {string} name
 */
function requireTool(name) {
  const res = spawnSync(name, ['-v'], { stdio: 'ignore' });
  if (res.error && res.error.code === 'ENOENT') {
    environment(`${name} was not found on PATH`, [
      'deck rasterizes its PDF with poppler\'s pdftoppm, so the PNGs and the PDF are the same rendering.',
      'On macOS: brew install poppler',
    ]);
  }
}
