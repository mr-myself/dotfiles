import fs from 'node:fs';
import path from 'node:path';
import { releaseGate } from '../approvals.js';
import {
  loadDeck, resolveAssets, slotFillState, validateSemantics,
} from '../deck.js';
import { contentDigest, renderFingerprint, renderOptions } from '../digest.js';
import { readCoverage, missingGlyphs } from '../font/cmap.js';
import { renderAndMeasure } from '../render/browser.js';
import { buildHtml, fileUrl } from '../render/html.js';
import { rasterize } from '../render/raster.js';
import { checkFonts } from '../theme/load.js';
import { DeckError, EXIT, usage } from '../util/fail.js';
import { ensureDir, readJsonIfExists, writeAtomic, writeJson } from '../util/fs.js';
import { acquireRenderLock, createStage, discardStage, publish, sweepStages, writeArtifactManifest } from '../publish.js';
import { pathToFileURL } from 'node:url';
import { writeReport } from '../util/report.js';
import { readState, setPhase, writeState } from '../workspace.js';

/**
 * `deck render [--release]`
 *
 * storyboard -> HTML -> PDF -> PNGs, plus geometry.json for the linter.
 *
 * A plain render is a PREVIEW and is always allowed: the PO has to be able to
 * look at the thing before approving it, and a tool that demands approval
 * first is a tool that gets approval rubber-stamped.
 *
 * `--release` refuses to run when the current content digest does not match
 * the approved one, and says WHAT changed.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function renderCommand(argv) {
  let release = false;
  let keepHtmlOnly = false;
  for (const a of argv) {
    if (a === '--release') release = true;
    else if (a === '--html-only') keepHtmlOnly = true;
    else usage(`unknown option for deck render: ${a}`);
  }

  const { root, p, storyboard, theme, manifest, request } = loadDeck();

  const problems = validateSemantics(storyboard, theme);
  if (problems.length > 0) {
    throw new DeckError(`refusing to render a storyboard that does not validate (${problems.length} problem(s))`,
      EXIT.VERDICT_FAILED, [...problems.map((x) => `  - ${x}`), '', 'Run `deck validate`.']);
  }

  if (release) {
    const gate = releaseGate(p, storyboard);
    if (!gate.ok) {
      // A refused release is a VERDICT failure, not a process failure: the
      // command ran correctly and the answer is no.
      throw new DeckError(`deck render --release refused: ${gate.message}`, EXIT.VERDICT_FAILED, gate.details);
    }
  }

  // --- fonts --------------------------------------------------------------
  const fontState = checkFonts(theme);
  const broken = fontState.filter((f) => !f.ok);
  if (broken.length > 0) {
    throw new DeckError('the theme\'s pinned fonts are not usable', EXIT.ENVIRONMENT,
      broken.map((f) => `${f.family}: ${f.problem}`));
  }
  const glyphProblems = checkGlyphCoverage(theme, storyboard);
  if (glyphProblems.length > 0) {
    // Tofu in a delivered PDF is the failure mode this check exists for, and
    // it is invisible in a thumbnail. Loud is correct.
    throw new DeckError('the pinned font has no glyph for some of the storyboard\'s characters', EXIT.VERDICT_FAILED, [
      ...glyphProblems,
      '',
      'deck refuses rather than rendering tofu (□). Either change the character or pin a font that covers it.',
    ]);
  }

  // --- assets -------------------------------------------------------------
  //
  // `verify: true` checks every active asset's bytes against the SHA-256 the
  // manifest records, and refuses a path that resolves outside assets/. The
  // hash is what geometry.json and the export report publish, so publishing
  // it for different bytes would be stating a provenance that is not true of
  // the image actually in the PDF.
  const assets = resolveAssets(root, manifest, storyboard, { verify: true });

  // A RELEASE WITH NO PICTURES IN IT IS NOT A RELEASE.
  //
  // The release gate checked the approval digest and the font coverage, and a
  // deck with fourteen of fifteen slots empty satisfied both: the words were
  // approved, the glyphs were covered, and `render --release` wrote a
  // finished PDF with nothing but text on the pages. There is no reading of
  // "release" that includes a deck missing its illustrations.
  //
  // Checked AFTER the digest gate, because the digest is the cheaper and more
  // fundamental refusal, and BEFORE anything is staged, because this is a
  // refusal rather than a repair. A plain preview render is untouched - the
  // PO has to be able to look at the layout before the pictures exist, and
  // that is the whole point of the draft render.
  if (release) {
    const fill = slotFillState(storyboard, assets);
    if (fill.empty.length > 0) {
      throw new DeckError(
        `deck render --release refused: ${fill.empty.length} of ${fill.total} illustration slot(s) are empty`,
        EXIT.VERDICT_FAILED,
        [
          ...fill.empty.map((e) => `  - ${e.slide}: slot "${e.slot}" (${e.width_px}x${e.height_px}) has no image`),
          '',
          'Run `deck gate prompts --single`, draw them, drop the files in inbox/',
          'and run `deck gate inbox`. Or delete the slots the deck does not need.',
          '',
          'A plain `deck gate render` (preview) is still allowed and is how you',
          'show the PO a readable page before the illustrations arrive.',
        ],
      );
    }
  }

  const options = renderOptions(request, theme);
  const scale = options.png_scale;
  const themeCss = fs.readFileSync(theme.__css, 'utf8');
  const fingerprint = renderFingerprint({ storyboard, theme, themeCss, assets, scale, options });

  // --- stage ----------------------------------------------------------------
  //
  // Nothing below touches a published path until `publish()` at the end.
  sweepStages(p);
  const releaseLock = acquireRenderLock(p, release ? 'render --release' : 'render');
  /** @type {{dir: string, path: (n: string) => string} | null} */
  let stage = null;
  try {
    stage = createStage(p);
    const stageHtml = ensureDir(stage.path('html'));
    const stagePdf = stage.path('deck.pdf');
    const stagePng = stage.path('png');

    const { document, perSlide } = buildHtml({
      theme,
      storyboard,
      assets,
      baseDir: stageHtml,
      pageNumbers: options.page_numbers,
    });

    for (const [id, html] of Object.entries(perSlide)) {
      writeAtomic(path.join(stageHtml, `${id}.html`), html);
    }
    // The COMBINED document is what is measured and exported. The per-slide
    // files above are standalone copies for inspection and diffing; measuring
    // them separately would make the geometry and the PDF two different
    // layouts, which is the bug this arrangement removes.
    const combined = path.join(stageHtml, '_deck.html');
    writeAtomic(combined, document);

    if (keepHtmlOnly) {
      publish(p, stage, ['html']);
      stage = null;
      process.stdout.write(`deck render --html-only: wrote ${Object.keys(perSlide).length} slide file(s) and ${path.join(p.outHtml, '_deck.html')}\n`);
      return EXIT.OK;
    }

    // --- chrome -------------------------------------------------------------
    //
    // The allowlist is exactly what this document needs: itself, the theme's
    // pinned fonts, and the imported assets. Everything else is refused.
    const allowedUrls = [
      pathToFileURL(combined).href,
      ...theme.fonts.pinned.map((f) => pathToFileURL(path.join(theme.__dir, f.file)).href),
      ...Object.values(assets).map((a) => a.src),
    ];
    const { geometry, warnings } = await renderAndMeasure({
      url: fileUrl(combined),
      pdfPath: stagePdf,
      theme,
      allowedUrls,
    });

    if (geometry.document?.error) {
      throw new DeckError(`nothing could be measured: ${geometry.document.error}`, EXIT.PROCESS_FAILED);
    }
    if (geometry.document.media !== 'print') {
      // The whole point of emulating print media is that the measured layout
      // is the exported one. If the emulation did not take, every number is
      // about a page that will not ship.
      throw new DeckError(
        `the page was measured under "${geometry.document.media}" media, not print`,
        EXIT.PROCESS_FAILED,
        ['Chrome exports the PDF under print media, so a screen-media measurement would not describe the delivered page.'],
      );
    }
    const measuredErrors = geometry.slides.filter((s) => s.error);
    if (measuredErrors.length > 0) {
      throw new DeckError('some slides could not be measured', EXIT.PROCESS_FAILED,
        measuredErrors.map((s) => `${s.slide_id}: ${s.error}`));
    }
    if (geometry.slides.length !== storyboard.slides.length) {
      throw new DeckError(
        `measured ${geometry.slides.length} slide(s) but the storyboard has ${storyboard.slides.length}`,
        EXIT.PROCESS_FAILED,
      );
    }

    // --- pngs -------------------------------------------------------------
    const raster = rasterize({
      pdf: stagePdf,
      outDir: stagePng,
      scale,
      expectedPages: storyboard.slides.length,
      canvasWidth: theme.canvas.width,
      canvasHeight: theme.canvas.height,
      root,
    });

    // --- geometry.json ----------------------------------------------------
    writeJson(stage.path('geometry.json'), {
      schema: 'deck.geometry/1',
      theme: theme.name,
      canvas: { width: theme.canvas.width, height: theme.canvas.height, render_scale: scale },
      media: geometry.document.media,
      fonts_ready: geometry.document.fonts_ready,
      content_digest: contentDigest(storyboard),
      // THE RENDER FINGERPRINT. Content alone was not enough: it deliberately
      // excludes the theme, the CSS, line breaks, slot geometry and which
      // asset fills a slot, so a theme edit left this file looking current
      // while describing a layout that no longer existed. Every later command
      // checks this value, not the content digest.
      render_fingerprint: fingerprint,
      release,
      generated_at: new Date().toISOString(),
      // The asset hashes SURVIVE TO THE OUTPUT. A later reader of
      // geometry.json can prove which file filled which slot without the
      // manifest.
      assets: Object.fromEntries(Object.entries(assets)
        .map(([k, v]) => [k, { sha256: v.sha256, stored_file: v.stored_file }])),
      slides: relativiseResourcePaths(geometry.slides, root),
      warnings,
    });

    // --- bind the delivered bytes ------------------------------------------
    //
    // The fingerprint says what was ASKED FOR. This records what was actually
    // produced, so lint and export can tell a complete set from a mixture of
    // two renders - which the fingerprint alone cannot, because reverting the
    // inputs makes it match again.
    writeArtifactManifest(stage.dir, fingerprint);

    // --- publish ----------------------------------------------------------
    //
    // Only now, with the PDF written, every page rasterized at the right size
    // and the geometry measured, do the published names change.
    publish(p, stage);
    stage = null;

    // A NEW RENDER INVALIDATES THE OLD LINT REPORT. Leaving it meant `deck
    // status` and `deck export` reported a PASS that had inspected a layout
    // which no longer existed.
    invalidateLintReport(p, fingerprint);

    const state = readState(p);
    writeState(p, {
      ...state,
      theme: theme.name,
      last_render: {
        at: new Date().toISOString(),
        release,
        content_digest: contentDigest(storyboard),
        render_fingerprint: fingerprint,
        pages: raster.pages,
        dpi: raster.dpi,
      },
    });
    if (release) {
      try {
        setPhase(p, 'released');
      } catch {
        // The phase machine refuses some transitions; a render that succeeded
        // must not fail because of bookkeeping. `deck status` re-derives the
        // phase from disk anyway.
      }
    }

    writeReport({
      dir: p.out,
      name: 'render',
      command: 'render',
      process: 'ok',
      verdict: warnings.length === 0 ? 'pass' : 'fail',
      summary: warnings.length === 0
        ? `${raster.pages} page(s) rendered at ${raster.dpi} dpi from ${storyboard.slides.length} slide(s)`
        : `${raster.pages} page(s) rendered, but ${warnings.length} warning(s) were raised during the render`,
      body: {
        release,
        pages: raster.pages,
        dpi: raster.dpi,
        scale,
        pdf: path.relative(root, p.pdf),
        png: raster.files.map((f) => path.join('out', 'png', path.basename(f))),
        geometry: path.relative(root, p.geometry),
        content_digest: contentDigest(storyboard),
        render_fingerprint: fingerprint,
        fonts: fontState.map((f) => ({ family: f.family, sha256: f.sha256 })),
        assets: Object.fromEntries(Object.entries(assets)
          .map(([k, v]) => [k, { sha256: v.sha256, stored_file: v.stored_file }])),
        warnings,
      },
      humanText: [
        'deck render',
        '',
        `mode:        ${release ? 'release' : 'preview'}`,
        `pages:       ${raster.pages}`,
        `pdf:         ${p.pdf}`,
        `png:         ${p.outPng} (${raster.dpi} dpi, ${scale}x)`,
        `geometry:    ${p.geometry}`,
        `fingerprint: ${fingerprint}`,
        '',
        ...(warnings.length ? ['Warnings:', ...warnings.map((w) => `  - ${w}`)] : ['No warnings.']),
      ].join('\n'),
    });

    process.stdout.write(`deck render${release ? ' --release' : ''}: ${raster.pages} page(s)\n`);
    process.stdout.write(`  pdf       ${path.relative(process.cwd(), p.pdf) || p.pdf}\n`);
    process.stdout.write(`  png       ${path.relative(process.cwd(), p.outPng) || p.outPng}/001.png ... (${raster.dpi} dpi, ${scale}x)\n`);
    process.stdout.write(`  html      ${path.relative(process.cwd(), p.outHtml) || p.outHtml}/<slide-id>.html\n`);
    process.stdout.write(`  geometry  ${path.relative(process.cwd(), p.geometry) || p.geometry}\n`);
    for (const w of warnings) process.stdout.write(`  WARNING   ${w}\n`);
    process.stdout.write('\nNow run `deck lint` to check the geometry.\n');
    return warnings.length === 0 ? EXIT.OK : EXIT.VERDICT_FAILED;
  } finally {
    // A failed render publishes NOTHING. The previous artifact set stays
    // exactly as it was, which is the whole point of staging.
    discardStage(stage);
    releaseLock();
  }
}

/**
 * Rewrite absolute file:// URLs in measured geometry as workspace-relative.
 *
 * geometry.json is an artifact the PO may hand to someone - it is the input
 * to a lint report and to any later tooling - and an absolute URL carries
 * their username and directory layout. The path is only ever used for
 * identification after the render, never to re-open the file, so the relative
 * form loses nothing.
 *
 * @param {any[]} slides
 * @param {string} root
 */
function relativiseResourcePaths(slides, root) {
  const prefix = pathToFileURL(root.endsWith(path.sep) ? root : `${root}${path.sep}`).href;
  const shorten = (u) => {
    if (typeof u !== 'string' || !u.startsWith('file://')) return u;
    return u.startsWith(prefix) ? decodeURIComponent(u.slice(prefix.length)) : '(outside the workspace)';
  };
  return slides.map((slide) => ({
    ...slide,
    images: (slide.images || []).map((img) => ({ ...img, src: shorten(img.src) })),
  }));
}

/**
 * Drop a lint report that inspected a different render.
 *
 * Deleting is right rather than rewriting: there is no verdict to publish for
 * a render nobody has linted, and an absent report is unambiguous where a
 * stale one is not. `deck export` says "lint: NEVER RUN" for this render.
 *
 * @param {import('../workspace.js').Paths} p
 * @param {string} fingerprint
 */
function invalidateLintReport(p, fingerprint) {
  const file = path.join(p.outLint, 'report.json');
  if (!fs.existsSync(file)) return;
  const existing = readJsonIfExists(file);
  if (existing && existing.render_fingerprint === fingerprint) return;
  fs.rmSync(p.outLint, { recursive: true, force: true });
}


/**
 * Every character the deck will set, against the pinned font's cmap.
 *
 * Checked BEFORE Chrome starts, because a missing glyph renders as tofu and a
 * tofu in a 23-page PDF is something nobody notices until a client does.
 *
 * @param {any} theme
 * @param {any} storyboard
 * @returns {string[]}
 */
export function checkGlyphCoverage(theme, storyboard) {
  /** @type {string[]} */
  const problems = [];
  const text = collectText(storyboard);
  for (const pinned of theme.fonts.pinned) {
    const file = path.join(theme.__dir, pinned.file);
    if (!fs.existsSync(file)) continue;
    let coverage;
    try {
      coverage = readCoverage(file);
    } catch (err) {
      problems.push(`${pinned.family}: the font's cmap could not be read, so coverage is UNKNOWN and deck will not assume it is complete: ${err.message}`);
      continue;
    }
    const missing = missingGlyphs(coverage, text);
    for (const m of missing) {
      problems.push(`${pinned.family} has no glyph for "${m.char}" (U+${m.codepoint.toString(16).toUpperCase().padStart(4, '0')}), which appears in this deck`);
    }
  }
  return problems;
}

/** Every string the renderer will set, folio text included. @param {any} storyboard */
function collectText(storyboard) {
  const parts = [storyboard.title, '0123456789/'];
  for (const s of storyboard.slides) {
    parts.push(s.title, s.subtitle, s.section_label);
    for (const b of s.body || []) {
      parts.push(b.text);
      for (const it of b.items || []) parts.push(it);
      for (const c of b.cards || []) {
        parts.push(c.heading, c.body);
        for (const it of c.items || []) parts.push(it);
      }
    }
    if (s.table) {
      for (const c of s.table.columns) parts.push(c.heading);
      for (const row of s.table.rows) parts.push(...row);
      parts.push(s.table.note);
    }
    if (s.footer) parts.push(s.footer.text, s.footer.label);
    for (const it of s.agenda?.items || []) parts.push(it);
  }
  return parts.filter((x) => typeof x === 'string').join('');
}
