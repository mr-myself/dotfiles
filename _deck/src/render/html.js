import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pageTypes } from '../schema.js';
import { DeckError, EXIT } from '../util/fail.js';
import { assertInertStylesheet } from '../theme/css-safe.js';
import { fontFaces, themeVariables } from '../theme/css.js';
import { TEMPLATES, esc } from './templates.js';

/**
 * Build the HTML.
 *
 * ONE document holds every slide, each canvas its own printed page, because
 * the PDF and the measured geometry then come from literally the same layout.
 * Per-slide files are also written, as standalone copies for inspection and
 * diffing; they are not what is measured.
 *
 * @param {object} opts
 * @param {any} opts.theme
 * @param {any} opts.storyboard
 * @param {Record<string, any>} opts.assets slot id -> asset record
 * @param {string} opts.baseDir directory the HTML will be written to, for
 *   resolving relative file:// URLs
 * @param {boolean} [opts.pageNumbers] deck.yaml's output.page_numbers
 * @returns {{document: string, perSlide: Record<string, string>}}
 */
export function buildHtml({ theme, storyboard, assets, baseDir, pageNumbers = true }) {
  const { implemented, unimplemented } = pageTypes();

  const head = buildHead(theme, baseDir);
  /** @type {string[]} */
  const pages = [];
  /** @type {Record<string, string>} */
  const perSlide = {};

  storyboard.slides.forEach((slide, index) => {
    if (!implemented.has(slide.page_type)) {
      const reason = unimplemented.get(slide.page_type);
      throw new DeckError(
        `slide "${slide.id}" uses page_type "${slide.page_type}", which deck does not implement`,
        EXIT.VERDICT_FAILED,
        [
          reason || 'This name is not in deck\'s page-type vocabulary at all.',
          `Implemented in this increment: ${[...implemented].join(', ')}.`,
          'deck refuses rather than falling back to a different layout: a page silently rendered as something else is worse than a page not rendered.',
        ],
      );
    }
    const inner = TEMPLATES[slide.page_type]({
      theme,
      slide,
      index,
      total: storyboard.slides.length,
      assets,
      pageNumbers,
    });
    const page = pageWrapper(slide, inner, theme);
    pages.push(page);
    perSlide[slide.id] = `<!DOCTYPE html>
<html lang="${esc(theme.language || 'ja-JP')}">
${head}
<body>
${page}
</body>
</html>
`;
  });

  const document = `<!DOCTYPE html>
<html lang="${esc(theme.language || 'ja-JP')}">
${head}
<body>
${pages.join('\n')}
</body>
</html>
`;
  return { document, perSlide };
}

/** @param {any} slide @param {string} inner @param {any} theme */
function pageWrapper(slide, inner, theme) {
  return `<section class="deck-page">
  <div class="deck-canvas"
       data-deck-canvas
       data-deck-canvas-width="${theme.canvas.width}"
       data-deck-canvas-height="${theme.canvas.height}"
       data-deck-slide-id="${esc(slide.id)}"
       data-deck-page-type="${esc(slide.page_type)}"${slide.variant ? `\n       data-deck-variant="${esc(slide.variant)}"` : ''}>
    <div class="region region--content" data-deck-region="content-region"></div>${inner}
  </div>
</section>`;
}

/** @param {any} theme @param {string} baseDir */
function buildHead(theme, baseDir) {
  const toUrl = (rel) => fileUrl(path.join(theme.__dir, rel));
  // The theme's OWN deck.css goes in here raw. It is a file the theme author
  // wrote, not a token a deck.yaml can override, but it is still the one
  // stylesheet source that never passed through a sanitiser - and a `</style>`
  // in it escaped straight into the published HTML.
  const css = fs.readFileSync(theme.__css, 'utf8');
  const stylesheet = `${fontFaces(theme, toUrl)}
${themeVariables(theme)}
${css}`;

  // THE BACKSTOP RUNS ON THE ASSEMBLED STYLESHEET, not on each source.
  //
  // Checking the generated parts individually missed the one part that was
  // not generated. Running it here covers every source there will ever be,
  // including sources added later by someone who does not know this check
  // exists.
  //
  // Disabling JavaScript protects the AUTOMATED render. It does nothing for
  // a person who opens out/html/<slide>.html in a browser, and that file is
  // an output deck hands over.
  assertInertStylesheet(stylesheet, `the stylesheet assembled for theme "${theme.name}"`);

  return `<head>
<meta charset="utf-8">
<title>deck</title>
<style>
${stylesheet}
</style>
</head>`;
}

/**
 * A file:// URL for a local path.
 *
 * `new URL('file://' + p)` is NOT this: it treats the path as a URL string, so
 * a `#` starts a fragment and a `?` starts a query, and a workspace called
 * "Q3 #2 (draft)" produced a URL pointing at a file that does not exist.
 * pathToFileURL percent-encodes the path as a path.
 *
 * @param {string} abs
 */
export function fileUrl(abs) {
  return pathToFileURL(path.resolve(abs)).href;
}
