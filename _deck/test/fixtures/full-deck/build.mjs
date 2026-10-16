/**
 * BUILD THE FIXTURE DECK into a working directory.
 *
 *   node test/fixtures/full-deck/build.mjs /tmp/fixture-deck
 *
 * Copies deck.yaml and storyboard.yaml, generates a stand-in illustration for
 * every slot the storyboard declares, imports each one, and leaves a workspace
 * ready for `deck gate render` and `deck gate lint`.
 *
 * WHY THE PICTURES ARE GENERATED HERE rather than committed.
 *
 * The repository holds no binaries, and a committed PNG is a thing nobody can
 * review in a diff. These are built from the slot's id, so they are
 * deterministic - the same slot always gets the same bytes, and the asset
 * manifest's SHA-256 is stable across machines - and they are plainly
 * stand-ins rather than artwork: a soft two-colour wash. They exist so that
 * "every slot filled" is a state the fixture can actually be in, which is the
 * state no fixture was in when the column-art slots shipped broken.
 *
 * They contain NO TEXT, which is the same rule every real slot image is held
 * to: HTML/CSS renders every word on the slide.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = HERE;

/** FNV-1a, so a slot id gives a stable colour. */
function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A minimal PNG: a vertical two-colour gradient, no text, no alpha.
 *
 * Written by hand because deck has no image library and must not grow one for
 * a test fixture. 8-bit truecolour, one filter byte per row, deflated.
 *
 * @param {number} w
 * @param {number} h
 * @param {string} seed
 */
export function washPng(w, h, seed) {
  // IN THE THEME'S OWN PALETTE, and only narrowly varied.
  //
  // The channels used to vary independently, which walked the hue right across
  // the wheel: one stand-in came out mauve and another pink, and on a contact
  // sheet of the fixture they read as colour swatches rather than as a deck.
  // The fixture is documentation - someone looks at it to see what a page type
  // renders like - so a stand-in that fights the page is a stand-in that
  // misinforms. These stay in the watercolour's blue-green range and vary by a
  // few steps, which is enough to tell two of them apart.
  const n = seedOf(seed);
  const top = [150 + (n % 22), 184 + ((n >> 5) % 20), 206 + ((n >> 10) % 18)];
  const bottom = [226 + ((n >> 15) % 14), 236 + ((n >> 19) % 10), 232 + ((n >> 23) % 12)];
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    const t = h === 1 ? 0 : y / (h - 1);
    const px = [0, 1, 2].map((c) => Math.round(top[c] + (bottom[c] - top[c]) * t));
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x += 1) {
      row[1 + x * 3] = px[0];
      row[2 + x * 3] = px[1];
      row[3 + x * 3] = px[2];
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Level 9 with a fixed strategy, so the bytes do not depend on the zlib
    // version's default heuristics and the recorded SHA-256 stays stable.
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every slot the fixture storyboard declares, with its size. */
export function fixtureSlots() {
  const sb = YAML.parse(fs.readFileSync(path.join(HERE, 'storyboard.yaml'), 'utf8'));
  return sb.slides.flatMap((s) => (s.slots || []).map((sl) => ({
    slide: s.id,
    id: sl.id,
    // The qualified key `assets import` takes, and the filename token
    // `prompts --single` asks the PO to use. Both carry the slide, because a
    // slot id alone no longer identifies one picture.
    key: `${s.id}:${sl.id}`,
    token: `${s.id}-${sl.id}`,
    width: sl.width_px,
    height: sl.height_px,
  })));
}

/**
 * @param {string} dest        where to build the workspace
 * @param {object} [opts]
 * @param {string} [opts.deckBin]  the `deck` launcher, for `gate assets import`
 * @param {string[]} [opts.leaveEmpty]  slot ids to deliberately leave empty
 */
export function buildFixture(dest, { deckBin, leaveEmpty = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['deck.yaml', 'storyboard.yaml']) {
    fs.copyFileSync(path.join(HERE, f), path.join(dest, f));
  }
  const art = path.join(dest, '.fixture-art');
  fs.mkdirSync(art, { recursive: true });
  fs.mkdirSync(path.join(dest, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(dest, 'assets', 'manifest.json'),
    `${JSON.stringify({ schema: 'deck.assets/1', assets: [] }, null, 2)}\n`,
  );

  // ADDRESSED BY SLIDE AND SLOT.
  //
  // The fixture now has TWO standard-3col slides, and both declare col-1-art -
  // because that id names the first column's picture, which every such slide
  // has. A bare id is ambiguous between them and `assets import` refuses it,
  // correctly. The seed and the stand-in's filename carry the pair too, so the
  // two slides get visibly different pictures rather than the same one twice.
  const imported = [];
  for (const slot of fixtureSlots()) {
    if (leaveEmpty.includes(slot.id) || leaveEmpty.includes(slot.key)) continue;
    const file = path.join(art, `${slot.token}.png`);
    fs.writeFileSync(file, washPng(slot.width, slot.height, slot.token));
    if (deckBin) {
      execFileSync(deckBin, ['gate', 'assets', 'import', slot.key, file], {
        cwd: dest, stdio: 'pipe',
      });
    }
    imported.push(slot.key);
  }
  return { dest, imported };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dest = process.argv[2];
  if (!dest) {
    process.stderr.write('usage: node build.mjs <destination-dir> [deck-binary]\n');
    process.exit(2);
  }
  const deckBin = process.argv[3] || path.resolve(HERE, '../../../..', 'deck');
  const { imported } = buildFixture(path.resolve(dest), { deckBin });
  process.stdout.write(`fixture built in ${path.resolve(dest)}\n`);
  process.stdout.write(`${imported.length} slot(s) filled: ${imported.join(', ')}\n`);
  process.stdout.write('\nNow:\n  cd ' + path.resolve(dest) + '\n  deck gate render\n  deck gate lint\n');
}
