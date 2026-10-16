import fs from 'node:fs';

/**
 * Just enough TrueType/OpenType parsing to answer one question: does this font
 * actually have a glyph for this character?
 *
 * The alternative - render and hope - produces tofu (□) in a delivered PDF,
 * and tofu in a raster is exactly the class of defect this tool exists to make
 * impossible. So the font's `cmap` is read directly and a missing glyph is a
 * loud failure before Chrome is ever started.
 *
 * Only `cmap` is parsed, and only formats 4 and 12, which is what every real
 * Japanese font ships. An unparseable font is reported as unsupported rather
 * than treated as covering everything.
 *
 * THE FONT IS UNTRUSTED INPUT. A theme ships its own font and its own recorded
 * hash, so hash verification proves the file is the one the theme intended -
 * it proves nothing about whether that file is well formed. A 68-byte font
 * declaring a single format-12 group covering 1..0xFFFFFFFF used to be
 * expanded codepoint by codepoint into a Set, which burned seconds and
 * hundreds of megabytes before dying with "Set maximum size exceeded".
 *
 * Coverage is therefore stored as sorted RANGES, not as an expanded set.
 * Lookup is a binary search, membership tests cost the same as before, and no
 * declared range can make deck allocate in proportion to its width. Every
 * offset is bounds-checked against the buffer, and every codepoint against
 * the Unicode maximum, before it is used.
 */

/** Unicode's last codepoint. Anything above this cannot be a character. */
const MAX_CODEPOINT = 0x10ffff;

/**
 * A hard ceiling on how many ranges a cmap may declare.
 *
 * Noto Sans JP, one of the larger fonts in use, declares a few thousand. 1e6
 * is far above anything legitimate and far below anything that costs real
 * memory.
 */
const MAX_RANGES = 1e6;

/**
 * @typedef {object} FontCoverage
 * @property {{start: number, end: number}[]} ranges sorted, non-overlapping
 * @property {number} size total codepoints covered
 * @property {(cp: number) => boolean} has
 * @property {string[]} notes
 */

/**
 * @param {string} file
 * @returns {FontCoverage}
 */
export function readCoverage(file) {
  const buf = fs.readFileSync(file);
  /** @type {string[]} */
  const notes = [];
  const codepoints = new Set();

  if (buf.length < 12) throw new Error(`${file}: too short to be a font`);
  const tag = buf.readUInt32BE(0);
  // 0x00010000 = TrueType outlines, 'OTTO' = CFF outlines, 'ttcf' = collection.
  if (tag === 0x74746366) {
    throw new Error(`${file}: TrueType collections (.ttc) are not supported; extract a single face`);
  }
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) {
    throw new Error(`${file}: not a recognised sfnt font (tag 0x${tag.toString(16)})`);
  }

  const numTables = buf.readUInt16BE(4);
  /** @type {Record<string, {off: number, len: number}>} */
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const o = 12 + i * 16;
    if (o + 16 > buf.length) break;
    tables[buf.toString('latin1', o, o + 4)] = {
      off: buf.readUInt32BE(o + 8),
      len: buf.readUInt32BE(o + 12),
    };
  }
  const cmap = tables.cmap;
  if (!cmap) throw new Error(`${file}: has no cmap table`);

  const base = cmap.off;
  // Every offset below comes out of the file. Checked before use, so a
  // truncated or crafted font produces a clear error rather than a RangeError
  // from deep inside a read.
  need(buf, base, 4, file, 'the cmap header');
  const n = buf.readUInt16BE(base + 2);
  /** @type {{platform: number, encoding: number, offset: number, format: number}[]} */
  const subtables = [];
  for (let i = 0; i < n; i += 1) {
    const o = base + 4 + i * 8;
    if (o + 8 > buf.length) break;
    const offset = base + buf.readUInt32BE(o + 4);
    if (offset + 2 > buf.length || offset < 0) continue;
    subtables.push({
      platform: buf.readUInt16BE(o),
      encoding: buf.readUInt16BE(o + 2),
      offset,
      format: buf.readUInt16BE(offset),
    });
  }

  // Prefer a full-Unicode subtable (format 12); fall back to the BMP-only
  // format 4. Picking the widest available avoids reporting an astral
  // character as missing just because the BMP table does not list it.
  const preferred = subtables.filter((s) => s.format === 12)
    .concat(subtables.filter((s) => s.format === 4));
  if (preferred.length === 0) {
    throw new Error(`${file}: cmap has no format 4 or 12 subtable (formats present: ${subtables.map((s) => s.format).join(', ')})`);
  }

  /** @type {{start: number, end: number}[]} */
  const raw = [];
  for (const sub of preferred) {
    if (sub.format === 12) {
      readFormat12(buf, sub.offset, raw, file);
      notes.push(`format 12 subtable (platform ${sub.platform}, encoding ${sub.encoding})`);
      break;
    }
    readFormat4(buf, sub.offset, raw, file);
    notes.push(`format 4 subtable (platform ${sub.platform}, encoding ${sub.encoding})`);
    break;
  }
  return makeCoverage(raw, notes);
}

/**
 * Sort, clamp and merge overlapping ranges into a searchable coverage object.
 * @param {{start: number, end: number}[]} raw
 * @param {string[]} notes
 * @returns {FontCoverage}
 */
function makeCoverage(raw, notes) {
  const clamped = raw
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(MAX_CODEPOINT, r.end) }))
    .filter((r) => r.end >= r.start)
    .sort((a, b) => a.start - b.start);

  /** @type {{start: number, end: number}[]} */
  const ranges = [];
  for (const r of clamped) {
    const last = ranges[ranges.length - 1];
    // Overlapping and adjacent groups are merged rather than kept apart, so a
    // font that declares the same range a thousand times costs nothing.
    if (last && r.start <= last.end + 1) {
      if (r.end > last.end) last.end = r.end;
    } else {
      ranges.push({ ...r });
    }
  }
  const size = ranges.reduce((n, r) => n + (r.end - r.start + 1), 0);

  return {
    ranges,
    size,
    notes,
    /** Binary search. O(log n) per lookup, no allocation. */
    has(cp) {
      let lo = 0;
      let hi = ranges.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cp < ranges[mid].start) hi = mid - 1;
        else if (cp > ranges[mid].end) lo = mid + 1;
        else return true;
      }
      return false;
    },
  };
}

/** Assert the buffer actually holds `len` bytes at `off`. */
function need(buf, off, len, file, what) {
  if (!Number.isInteger(off) || off < 0 || off + len > buf.length) {
    throw new Error(`${file}: ${what} points outside the file (offset ${off}, need ${len} bytes, file is ${buf.length})`);
  }
}

/**
 * Format 4, the BMP table.
 *
 * Every value here is a uint16, so one segment can span at most 65536
 * codepoints and no single segment can be made expensive. The cost that CAN
 * be made large is the TOTAL: a 262 KB font declaring thousands of maximal
 * overlapping segments induced over two billion iterations, about 1.3
 * seconds, because each segment was walked codepoint by codepoint before any
 * merging happened. The format-12 fix did not cover this branch.
 *
 * So: the declared subtable length is checked against the file, segments
 * must be sorted and non-overlapping as the specification requires, and the
 * total number of codepoints examined is capped.
 *
 * @param {Buffer} buf @param {number} off @param {{start:number,end:number}[]} out @param {string} file
 */
function readFormat4(buf, off, out, file) {
  need(buf, off, 14, file, 'the format 4 cmap header');
  const declaredLength = buf.readUInt16BE(off + 2);
  if (declaredLength > 0 && off + declaredLength > buf.length) {
    throw new Error(`${file}: the format 4 cmap declares a length of ${declaredLength} bytes at offset ${off}, but the file is only ${buf.length} bytes`);
  }
  const segCountX2 = buf.readUInt16BE(off + 6);
  if (segCountX2 % 2 !== 0) {
    throw new Error(`${file}: the format 4 cmap declares an odd segCountX2 (${segCountX2})`);
  }
  const segCount = segCountX2 / 2;
  const endBase = off + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;
  need(buf, rangeBase, segCountX2, file, 'the format 4 cmap segment arrays');
  if (segCount > MAX_RANGES) {
    throw new Error(`${file}: the format 4 cmap declares ${segCount} segments; refusing to continue`);
  }

  // The specification requires segments sorted by endCode and
  // non-overlapping. Enforcing it is what bounds the total work at 65536
  // codepoints for the whole table rather than 65536 PER SEGMENT.
  let previousEnd = -1;
  let examined = 0;

  for (let i = 0; i < segCount; i += 1) {
    const end = buf.readUInt16BE(endBase + i * 2);
    const start = buf.readUInt16BE(startBase + i * 2);
    if (start === 0xffff && end === 0xffff) continue;
    if (start > end) {
      throw new Error(`${file}: format 4 segment ${i} runs backwards (start ${start} > end ${end})`);
    }
    if (start <= previousEnd) {
      throw new Error(`${file}: format 4 segment ${i} starts at ${start}, overlapping or out of order after a segment ending at ${previousEnd}. Segments must be sorted and disjoint.`);
    }
    previousEnd = end;

    examined += end - start + 1;
    if (examined > 0x10000) {
      throw new Error(`${file}: the format 4 cmap covers more than 65536 codepoints, which a BMP table cannot; refusing to continue`);
    }

    const delta = buf.readInt16BE(deltaBase + i * 2);
    const rangeOffset = buf.readUInt16BE(rangeBase + i * 2);
    // A contiguous run of mapped codepoints becomes one range.
    let runStart = -1;
    for (let c = start; c <= end; c += 1) {
      let gid;
      if (rangeOffset === 0) {
        gid = (c + delta) & 0xffff;
      } else {
        const gi = rangeBase + i * 2 + rangeOffset + (c - start) * 2;
        gid = gi + 2 > buf.length ? 0 : buf.readUInt16BE(gi);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      if (gid !== 0) {
        if (runStart === -1) runStart = c;
      } else if (runStart !== -1) {
        out.push({ start: runStart, end: c - 1 });
        runStart = -1;
      }
    }
    if (runStart !== -1) out.push({ start: runStart, end });
    if (out.length > MAX_RANGES) {
      throw new Error(`${file}: the cmap declares more than ${MAX_RANGES} ranges; refusing to continue`);
    }
  }
}

/** @param {Buffer} buf @param {number} off @param {{start:number,end:number}[]} out @param {string} file */
function readFormat12(buf, off, out, file) {
  need(buf, off, 16, file, 'the format 12 cmap header');
  const nGroups = buf.readUInt32BE(off + 12);
  // nGroups is a uint32 out of the file. The buffer must actually contain
  // that many 12-byte groups, or the font is lying about its own size.
  const available = Math.floor((buf.length - (off + 16)) / 12);
  if (nGroups > available) {
    throw new Error(`${file}: the format 12 cmap declares ${nGroups} groups but the file holds room for ${available}`);
  }
  if (nGroups > MAX_RANGES) {
    throw new Error(`${file}: the format 12 cmap declares ${nGroups} groups; refusing to continue`);
  }
  for (let i = 0; i < nGroups; i += 1) {
    const g = off + 16 + i * 12;
    if (g + 12 > buf.length) break;
    const start = buf.readUInt32BE(g);
    const end = buf.readUInt32BE(g + 4);
    const startGid = buf.readUInt32BE(g + 8);
    if (startGid === 0 && start === 0) continue;
    if (end < start) continue;
    // THE RANGE IS RECORDED, NOT EXPANDED. This is the line that used to make
    // a 68-byte font allocate until Node's Set hit its maximum size: the
    // declared width is bounded only by uint32, so the work has to be
    // independent of it. Out-of-Unicode ends are clamped in makeCoverage.
    if (start > MAX_CODEPOINT) continue;
    out.push({ start, end });
  }
}

/**
 * Which characters of `text` the font cannot render.
 *
 * Variation selectors, ZWJ and the like are skipped: they legitimately have no
 * visible glyph and flagging them would make the check cry wolf.
 *
 * @param {FontCoverage} coverage
 * @param {string} text
 * @returns {{char: string, codepoint: number}[]}
 */
export function missingGlyphs(coverage, text) {
  /** @type {{char: string, codepoint: number}[]} */
  const missing = [];
  const seen = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || seen.has(cp)) continue;
    seen.add(cp);
    if (isInvisible(cp)) continue;
    if (!coverage.has(cp)) missing.push({ char: ch, codepoint: cp });
  }
  return missing;
}

/** @param {number} cp */
function isInvisible(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;      // ZWSP..RLM
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;      // variation selectors
  if (cp === 0xfeff) return true;                      // BOM
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true;    // ideographic variation
  return false;
}
