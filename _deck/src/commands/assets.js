import fs from 'node:fs';
import path from 'node:path';
import {
  briefDigest, loadDeck, resolveAssets, resolveSlotRef, slotFileToken, slotKey,
} from '../deck.js';
import { pngSize } from '../render/raster.js';
import { DeckError, EXIT, usage } from '../util/fail.js';
import { assertInside, copyInto, ensureDir, sha256File, writeJson } from '../util/fs.js';

/**
 * `deck assets import <slot-id> <file>` and `deck assets list`.
 *
 * THE PO'S FILE IS NEVER MUTATED. It is copied into assets/ and recorded with
 * its SHA-256; the hash of the file they handed over is what travels through
 * the manifest into the rendered output. Fitting happens at render time with
 * aspect-preserving containment, so the bytes that go in are the bytes that
 * come out.
 *
 * Manifest entries are APPENDED, never edited in place. Re-importing a slot
 * marks the previous entry `superseded_by` and adds a new one, so the history
 * of a slot survives - which is what makes "this image was approved against
 * that brief" answerable months later.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function assetsCommand(argv) {
  const sub = argv[0];
  if (!sub) usage('deck assets requires a subcommand', ['  deck assets import <slot-id> <file>', '  deck assets list']);
  if (sub === 'list') return list(argv.slice(1));
  if (sub === 'import') return importAsset(argv.slice(1));
  usage(`deck assets has no subcommand "${sub}"`, ['Known: import, list']);
}

/** @param {string[]} argv */
function importAsset(argv) {
  if (argv.length !== 2) {
    usage('deck assets import takes exactly a slot id and a file', ['  deck assets import <slot-id> <file>']);
  }
  const [wanted, file] = argv;
  const { root, p, storyboard, manifest } = loadDeck();

  // ADDRESSED BY SLIDE AND SLOT, with the bare id still accepted.
  //
  // `col-1-art` names a position on a page type, so several slides can have
  // one. A bare id works when exactly one slide does; when more than one does
  // it is REFUSED with the qualified ids listed, because choosing for the
  // author puts an illustration on the wrong page - which renders cleanly and
  // which no rule here can see.
  const ref = resolveSlotRef(storyboard, wanted);
  if (ref && ref.ambiguous) {
    throw new DeckError(`"${wanted}" is a slot on ${ref.ambiguous.length} slides`, EXIT.USAGE, [
      'Name the slide too:',
      ...ref.ambiguous.map((k) => `  deck gate assets import ${k} <file>`),
    ]);
  }
  if (!ref) {
    const known = storyboard.slides.flatMap((sl) => (sl.slots || []).map((x) => `${sl.id}:${x.id}`));
    throw new DeckError(`this deck has no slot "${wanted}"`, EXIT.USAGE, [
      `Slots: ${known.join(', ') || '(none)'}`,
    ]);
  }
  const found = { slide: ref.slide, slot: ref.slot };
  const slotId = ref.key;

  const src = path.resolve(file);
  if (!fs.existsSync(src)) {
    throw new DeckError(`no such file: ${src}`, EXIT.ENVIRONMENT);
  }
  const stat = fs.statSync(src);
  if (!stat.isFile()) {
    throw new DeckError(`${src} is not a regular file`, EXIT.ENVIRONMENT);
  }

  const ext = path.extname(src).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    throw new DeckError(`deck does not know how to place a "${ext}" file`, EXIT.USAGE, [
      'Accepted: .png, .jpg, .jpeg, .webp',
    ]);
  }

  const digest = sha256File(src);
  // CONTAINMENT BEFORE ANYTHING IS WRITTEN. `assets` may itself be a symlink
  // out of the workspace, in which case every import would land in someone
  // else's directory; and the destination may already exist AS a symlink, in
  // which case copyFileSync writes THROUGH it. assertInside resolves the
  // deepest existing ancestor, so a symlinked parent is caught, and copyInto
  // replaces a symlinked destination rather than following it.
  assertInside(p.assets, root, 'the deck\'s assets directory');
  ensureDir(p.assets);
  // The stored name carries the slot id and the first 12 hex of the hash, so
  // two imports of the same slot cannot collide and the file on disk is
  // traceable to its manifest entry by name alone.
  const storedName = `${slotFileToken(found.slide.id, found.slot.id)}-${digest.slice(0, 12)}${ext}`;
  const stored = copyInto(src, path.join(p.assets, storedName), root);

  const verify = sha256File(stored);
  if (verify !== digest) {
    // Reported rather than assumed: the copy is the thing the render reads,
    // and a copy that does not match the original is a corrupted asset.
    throw new DeckError('the copied asset does not match the original', EXIT.PROCESS_FAILED, [
      `original: ${digest}`,
      `copy:     ${verify}`,
    ]);
  }

  // AN UNREADABLE FILE IS NOT AN ILLUSTRATION.
  //
  // Two 0-byte PNGs from a failed download were imported in silence and
  // recorded with the SHA-256 of the empty string
  // (e3b0c442...b7852b855), and the slot then counted as FILLED - so
  // `slot-fill` passed, `render --release` was allowed, and the page shipped
  // with nothing in the frame. The gate was already reading the header to
  // report the pixel size; it just never acted on what it read.
  //
  // Checked on the STORED copy, after the hash round-trip, so what is
  // verified is the bytes the renderer will actually load.
  const stat2 = fs.statSync(stored);
  if (stat2.size === 0) {
    fs.rmSync(stored, { force: true });
    throw new DeckError(`${path.basename(src)} is empty (0 bytes), so there is no illustration in it`, EXIT.USAGE, [
      'A download that failed silently leaves a file of exactly this shape.',
      'Fetch it again and re-run the import.',
    ]);
  }
  const size = ext === '.png' ? pngSize(stored) : null;
  if (size && size.problem) {
    fs.rmSync(stored, { force: true });
    throw new DeckError(`${path.basename(src)} has a .png extension but is not a PNG (${size.problem})`, EXIT.USAGE, [
      'deck refuses it rather than recording a hash for bytes no renderer can draw.',
      'Check the file, or re-save it as a real PNG.',
    ]);
  }
  if (size && (!(size.width > 0) || !(size.height > 0))) {
    fs.rmSync(stored, { force: true });
    throw new DeckError(`${path.basename(src)} is a PNG of ${size.width}x${size.height} pixels`, EXIT.USAGE, [
      'An image with no pixels in it cannot fill a slot.',
    ]);
  }

  for (const a of manifest.assets) {
    // SUPERSEDE BY THE RESOLVED KEY, not by the literal string. An entry
    // written before slots were qualified carries a bare `cover-art`; a
    // re-import now records `cover:cover-art`, and comparing the strings
    // would leave the old entry live beside the new one - two assets claiming
    // one slot, with whichever the loop reached last silently winning.
    if (!a.superseded_by) {
      const was = resolveSlotRef(storyboard, a.slot_id);
      if (was && !was.ambiguous && was.key === slotId) a.superseded_by = storedName;
    }
  }
  const record = {
    slot_id: slotId,
    slide_id: found.slide.id,
    stored_file: path.relative(root, stored),
    original_path: src,
    sha256: digest,
    bytes: stat.size,
    imported_at: new Date().toISOString(),
    pixel_size: size && size.width ? { width: size.width, height: size.height } : null,
    // The brief AS IT IS NOW. Later, a brief whose digest still matches means
    // the asset is current however much its container has moved.
    brief_digest: briefDigest(found.slot),
    reuse_unchanged: found.slot.reuse_unchanged === true,
    superseded_by: null,
  };
  manifest.assets.push(record);
  writeJson(p.assetManifest, manifest);

  process.stdout.write(`deck assets import ${slotId}\n`);
  process.stdout.write(`  from:   ${src}\n`);
  process.stdout.write(`  stored: ${record.stored_file}\n`);
  process.stdout.write(`  sha256: ${digest}\n`);
  if (record.pixel_size) {
    const want = `${found.slot.width_px}x${found.slot.height_px}`;
    const got = `${record.pixel_size.width}x${record.pixel_size.height}`;
    process.stdout.write(`  pixels: ${got} (slot asks for ${want})\n`);
    if (got !== want) {
      // Not an error. The image is fitted with containment, so a different
      // size is placed correctly; it is reported because a very different
      // aspect ratio will leave visible empty space.
      const slotRatio = found.slot.width_px / found.slot.height_px;
      const imgRatio = record.pixel_size.width / record.pixel_size.height;
      const drift = Math.abs(slotRatio - imgRatio) / slotRatio;
      process.stdout.write(`          deck will fit it with aspect-preserving containment; the file is not altered.\n`);
      if (drift > 0.1) {
        process.stdout.write(`          NOTE: the aspect ratios differ by ${Math.round(drift * 100)}%, so there will be visible empty space inside the frame.\n`);
      }
    }
  }
  process.stdout.write(`  slide:  ${found.slide.id}\n`);
  process.stdout.write('\nThe original file was not modified. Re-run `deck render` to place it.\n');
  return EXIT.OK;
}

/** @param {string[]} argv */
function list(argv) {
  const json = argv.includes('--json');
  const { root, storyboard, manifest } = loadDeck();
  const assets = resolveAssets(root, manifest, storyboard);
  const rows = [];
  for (const slide of storyboard.slides) {
    for (const slot of slide.slots || []) {
      const a = assets[slotKey(slide.id, slot.id)];
      rows.push({
        slot_id: slot.id,
        slide_id: slide.id,
        reuse_unchanged: slot.reuse_unchanged === true,
        filled: Boolean(a),
        stale: Boolean(a?.stale),
        sha256: a?.sha256 || null,
        stored_file: a?.stored_file || null,
      });
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ assets: rows }, null, 2)}\n`);
    return EXIT.OK;
  }
  process.stdout.write('deck assets\n\n');
  if (rows.length === 0) process.stdout.write('  this deck declares no slots\n');
  for (const r of rows) {
    const state = r.filled ? (r.stale ? 'STALE (brief changed since import)' : 'filled') : 'empty';
    process.stdout.write(`  ${r.slot_id.padEnd(20)} ${r.slide_id.padEnd(16)} ${state.padEnd(34)} ${r.sha256 ? r.sha256.slice(0, 16) : ''}${r.reuse_unchanged ? '  [reuse_unchanged]' : ''}\n`);
  }
  process.stdout.write('\n');
  return EXIT.OK;
}
