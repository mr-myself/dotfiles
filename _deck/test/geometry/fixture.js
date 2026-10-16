import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pw from 'playwright-core';
import { collectGeometry } from '../../src/render/collect.js';

/**
 * Measure a hand-written fixture page in REAL Chrome, under PRINT media.
 *
 * These fixtures exist because the lint rules consume geometry, and geometry
 * produced by hand is geometry that agrees with the rule by construction. A
 * centring error injected into CSS and then measured by the same collector the
 * product uses is the only way to know the rule fires on a real browser
 * layout.
 */

const CANVAS = { w: 1672, h: 941 };
const MARGINS = { left: 60, right: 50, top: 42, bottom: 35 };

/** The font the real theme pins, so fixtures lay out with the real metrics. */
const FONT = path.resolve(new URL('../../themes/watercolor/fonts/NotoSansJP-Variable.ttf', import.meta.url).pathname);

/**
 * @param {string} body  HTML placed inside the canvas
 * @param {object} [opts]
 * @param {string} [opts.extraCss]
 * @param {string} [opts.slideId]
 * @param {string} [opts.pageType]
 * @returns {string} a complete document
 */
export function page(body, { extraCss = '', slideId = 'fx', pageType = 'statement' } = {}) {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><style>
@font-face {
  font-family: "Noto Sans JP deck";
  src: url("file://${FONT}") format("truetype-variations");
  font-weight: 100 900;
  font-display: block;
}
@page { size: ${CANVAS.w}px ${CANVAS.h}px; margin: 0 }
* { margin: 0; padding: 0; box-sizing: border-box }
html, body { background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact }
.deck-page { width: ${CANVAS.w}px; height: ${CANVAS.h}px; position: relative; overflow: hidden }
.deck-canvas {
  position: relative; width: ${CANVAS.w}px; height: ${CANVAS.h}px;
  background: #FDFDFB; color: #132C64; overflow: hidden;
  font-family: "Noto Sans JP deck", sans-serif;
}
.region { position: absolute; pointer-events: none }
.region--content {
  left: ${MARGINS.left}px; top: ${MARGINS.top}px;
  width: ${CANVAS.w - MARGINS.left - MARGINS.right}px;
  height: ${CANVAS.h - MARGINS.top - MARGINS.bottom}px;
}
.stack {
  position: absolute;
  left: ${MARGINS.left}px; top: ${MARGINS.top}px;
  width: ${CANVAS.w - MARGINS.left - MARGINS.right}px;
  height: ${CANVAS.h - MARGINS.top - MARGINS.bottom}px;
  display: flex; align-items: center; justify-content: center; text-align: center;
}
.title { font-size: 84px; font-weight: 700; line-height: 1.3 }
${extraCss}
</style></head><body>
<section class="deck-page">
  <div class="deck-canvas" data-deck-canvas
       data-deck-canvas-width="${CANVAS.w}" data-deck-canvas-height="${CANVAS.h}"
       data-deck-slide-id="${slideId}" data-deck-page-type="${pageType}">
    <div class="region region--content" data-deck-region="content-region"></div>
${body}
  </div>
</section>
</body></html>`;
}

/** The placement contract, as the templates write it. */
export function contract(extra = {}) {
  return JSON.stringify({
    reference: 'content-region',
    align_x: 'center',
    align_y: 'center',
    measure: 'content-union',
    tolerance_px: 2,
    ...extra,
  }).replace(/"/g, '&quot;');
}

let browser = null;

/** One browser for the whole file; Chrome start-up dominates otherwise. */
export async function getBrowser() {
  if (!browser) {
    browser = await pw.chromium.launch({
      channel: 'chrome',
      args: ['--allow-file-access-from-files', '--disable-background-networking'],
    });
  }
  return browser;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Render one fixture document and return the measured slide, exactly as
 * geometry.json would carry it.
 * @param {string} html
 * @returns {Promise<any>}
 */
export async function measure(html) {
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: { width: CANVAS.w, height: CANVAS.h },
    deviceScaleFactor: 1,
  });
  const p = await ctx.newPage();
  // The fixture is written to a real file so the font's file:// URL resolves
  // the same way it does in a render.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fixture-'));
  const file = path.join(dir, 'fixture.html');
  fs.writeFileSync(file, html);
  try {
    await p.emulateMedia({ media: 'print' });
    await p.goto(`file://${file}`, { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    const loaded = await p.evaluate(() => document.fonts.check('700 84px "Noto Sans JP deck"'));
    if (!loaded) {
      throw new Error('the pinned font did not load in the fixture, so its metrics would be wrong');
    }
    const geometry = await p.evaluate(collectGeometry);
    if (geometry.document.media !== 'print') {
      throw new Error(`fixture measured under ${geometry.document.media} media, not print`);
    }
    return geometry.slides[0];
  } finally {
    await ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export { CANVAS, MARGINS };
