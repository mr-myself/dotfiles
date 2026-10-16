import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { ensureDir } from '../util/fs.js';

/**
 * Draw the offending box onto the rendered page.
 *
 * A finding that says "dy = 9.4 px" is correct and almost useless on its own:
 * the author still has to find the element. A PNG with the box drawn on it
 * turns the report into something you can act on in one glance, which is why
 * every finding carries one.
 *
 * Deliberately pure JS over pngjs rather than a native image library: the
 * annotation must work wherever deck works, and a build-step dependency for
 * drawing four rectangles is a bad trade.
 *
 * @param {object} opts
 * @param {string} opts.sourcePng    the rendered page, at delivery scale
 * @param {string} opts.outPng
 * @param {number} opts.canvasWidth  authored canvas width, for scaling
 * @param {import('./finding.js').Box[]} opts.boxes
 * @returns {{file: string, scale: number}}
 */
export function annotate({ sourcePng, outPng, canvasWidth, boxes }) {
  const png = PNG.sync.read(fs.readFileSync(sourcePng));
  // The delivery PNG is rendered at 2x (or whatever the theme says), while
  // every measurement is in authored canvas pixels. Derive the factor from the
  // image rather than trusting a setting, so a changed render scale cannot
  // silently misplace every box.
  const scale = png.width / canvasWidth;

  const colours = {
    offender: [220, 38, 38],     // red
    reference: [20, 148, 156],   // teal
    context: [120, 120, 120],    // grey
  };

  for (const b of boxes) {
    const colour = colours[b.kind] || colours.offender;
    const x = Math.round(b.x * scale);
    const y = Math.round(b.y * scale);
    const w = Math.round(b.w * scale);
    const h = Math.round(b.h * scale);
    const thickness = b.kind === 'offender' ? Math.max(2, Math.round(2 * scale)) : Math.max(1, Math.round(scale));
    strokeRect(png, x, y, w, h, colour, thickness);
    // Crosshair through the centre of an offender box: for a centring finding
    // the centre IS the measurement, so it is drawn rather than described.
    if (b.kind === 'offender' || b.kind === 'reference') {
      crosshair(png, Math.round(x + w / 2), Math.round(y + h / 2), colour, Math.round(10 * scale));
    }
  }

  ensureDir(path.dirname(outPng));
  fs.writeFileSync(outPng, PNG.sync.write(png));
  return { file: outPng, scale };
}

/** @param {PNG} png */
function strokeRect(png, x, y, w, h, colour, thickness) {
  for (let t = 0; t < thickness; t += 1) {
    hLine(png, x - t, x + w + t, y - t, colour);
    hLine(png, x - t, x + w + t, y + h + t, colour);
    vLine(png, y - t, y + h + t, x - t, colour);
    vLine(png, y - t, y + h + t, x + w + t, colour);
  }
}

/** @param {PNG} png */
function crosshair(png, cx, cy, colour, arm) {
  hLine(png, cx - arm, cx + arm, cy, colour);
  vLine(png, cy - arm, cy + arm, cx, colour);
}

function hLine(png, x0, x1, y, colour) {
  for (let x = x0; x <= x1; x += 1) setPixel(png, x, y, colour);
}
function vLine(png, y0, y1, x, colour) {
  for (let y = y0; y <= y1; y += 1) setPixel(png, x, y, colour);
}
function setPixel(png, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = 255;
}

/**
 * Average colour over a region of a rendered PNG, in canvas pixels.
 *
 * Used by the contrast rule's escape hatch: over a textured backing, a
 * text-hidden backing pass can be rendered and sampled here. Returning the
 * spread as well as the mean matters - a region whose colours span a wide
 * range has no single backing colour, and the caller must not average that
 * away into a confident-looking number.
 *
 * @param {string} file
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {number} canvasWidth
 */
export function sampleRegion(file, rect, canvasWidth) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const scale = png.width / canvasWidth;
  const x0 = Math.max(0, Math.round(rect.x * scale));
  const y0 = Math.max(0, Math.round(rect.y * scale));
  const x1 = Math.min(png.width, Math.round((rect.x + rect.w) * scale));
  const y1 = Math.min(png.height, Math.round((rect.y + rect.h) * scale));
  let r = 0; let g = 0; let b = 0; let n = 0;
  let minL = 255; let maxL = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (png.width * y + x) << 2;
      r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2];
      const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
      n += 1;
    }
  }
  if (n === 0) return null;
  return {
    mean: { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) },
    luminance_spread: Math.round(maxL - minL),
    pixels: n,
  };
}
