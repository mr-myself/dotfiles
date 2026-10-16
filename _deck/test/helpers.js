import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { washPng } from './fixtures/full-deck/build.mjs';

export const DECK_HOME = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DECK_BIN = path.join(path.dirname(DECK_HOME), 'deck');

/**
 * A disposable directory under the OS temp dir.
 *
 * Paths deliberately carry a SPACE and a JAPANESE character where the test is
 * about path handling - the author's own worktrees live under both, and a tool
 * that only works on an ASCII path with no spaces is a tool that works on
 * nobody's machine.
 *
 * @param {string} [label]
 */
export function tempDir(label = 'deck-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

/** @param {string} dir */
export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A minimal valid storyboard object, with overrides merged in.
 * @param {object} [patch]
 */
export function storyboard(patch = {}) {
  return {
    schema: 'deck.storyboard/1',
    title: 'テスト資料',
    slides: [
      {
        id: 'cover',
        page_type: 'cover',
        purpose: '表紙',
        title: 'タイトル',
        subtitle: '副題',
      },
    ],
    ...patch,
  };
}

/** @param {object} [patch] */
export function request(patch = {}) {
  return {
    schema: 'deck.request/1',
    request: {
      project_name: 'テスト',
      purpose: 'テストのため',
      audience: 'テスト読者',
      theme: 'watercolor',
      ...patch,
    },
  };
}

/**
 * A fake measured slide, in the shape geometry.json carries, so the lint
 * rules can be unit-tested without starting a browser.
 * @param {object} [patch]
 */
export function measuredSlide(patch = {}) {
  return {
    slide_id: 'slide-1',
    page_type: 'statement',
    variant: null,
    canvas: { authored_w: 1672, authored_h: 941, rendered_scale: 1 },
    media: 'print',
    fonts_ready: 'loaded',
    regions: {
      canvas: rect(0, 0, 1672, 941),
      'content-region': rect(60, 42, 1562, 864),
    },
    elements: [],
    images: [],
    ...patch,
  };
}

/** A rect with the centre fields the collector adds. */
export function rect(x, y, w, h) {
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

/**
 * A measured element. Defaults are a visible, plain, non-decorative box, so a
 * test only states the thing it is about.
 * @param {object} patch
 */
export function element(patch = {}) {
  const r = patch.rect || rect(0, 0, 100, 40);
  return {
    id: 'el',
    role: null,
    group: null,
    decorative: false,
    background_of: null,
    anchor: null,
    zone: null,
    slot: null,
    placement: null,
    proximity: null,
    visible: true,
    tag: 'div',
    text: '',
    own_text: true,
    ancestry: [],
    effective_opacity: 1,
    color_alpha: 1,
    rect: r,
    content_union: r,
    text_lines: [],
    overflow: {
      scroll_w: Math.round(r.w),
      scroll_h: Math.round(r.h),
      client_w: Math.round(r.w),
      client_h: Math.round(r.h),
      overflow_x: 'visible',
      overflow_y: 'visible',
      text_overflow: 'clip',
      line_clamp: 'none',
      white_space: 'normal',
    },
    style: {
      font_family: '"Noto Sans JP deck", sans-serif',
      font_size_px: 24,
      font_weight: '400',
      line_height: '32px',
      color: 'rgb(19, 44, 100)',
      background_color: 'rgba(0, 0, 0, 0)',
      display: 'block',
      position: 'static',
      transform: 'none',
      opacity: '1',
      letter_spacing: 'normal',
      text_align: 'start',
    },
    backing: { textured: false, composited: { r: 253, g: 253, b: 251 }, layers: [] },
    clipping_ancestors: [],
    ...patch,
  };
}

/** The real watercolor theme, loaded once. */
export async function theme() {
  process.env.DECK_HOME = DECK_HOME;
  const { loadTheme } = await import('../src/theme/load.js');
  return loadTheme('watercolor');
}

/**
 * The GATE spelling of a deterministic command.
 *
 * The deterministic commands moved behind `deck gate <name>` when the agent
 * launcher took over the bare verbs: `deck render` is now a deck titled
 * "render", and the launcher refuses it by name rather than starting an agent.
 *
 * These tests drive the REAL executable on purpose - that is the point of
 * them - so they go through the real gate spelling too. This wrapper exists so
 * that is one line per test file instead of a rewrite of every call site, and
 * so a test written as ['render', '--release'] keeps reading like the command
 * a person would think of.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function gateArgs(args) {
  const GATES = new Set([
    'init', 'doctor', 'source', 'ledger', 'agenda', 'copy', 'fidelity', 'inbox',
    'validate', 'approve', 'status', 'prompts', 'assets', 'render', 'lint', 'export',
    'schema',
  ]);
  return args.length > 0 && GATES.has(args[0]) ? ['gate', ...args] : args;
}


/**
 * FILL EVERY SLOT a workspace's storyboard declares.
 *
 * A scaffolded deck has a cover-art slot and no picture in it, which is now a
 * BLOCKING slot-fill finding and a refused `render --release` - correctly, and
 * it is what the rule exists for. A test about freshness, or about report
 * schemas, is not about that: it needs a deck in the state a real deck is in
 * by the time it is delivered. So they fill the slots instead of being
 * exempted from the rule, which also means these tests would notice if
 * filling a slot stopped working.
 *
 * @param {string} dir  the deck workspace
 * @param {string} deckBin
 */
export function fillSlots(dir, deckBin = DECK_BIN) {
  const sb = YAML.parse(fs.readFileSync(path.join(dir, 'storyboard.yaml'), 'utf8'));
  const art = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-slot-art-'));
  const filled = [];
  for (const slide of sb.slides || []) {
    for (const slot of slide.slots || []) {
      const file = path.join(art, `${slot.id}.png`);
      fs.writeFileSync(file, washPng(slot.width_px, slot.height_px, slot.id));
      execFileSync(deckBin, gateArgs(['assets', 'import', slot.id, file]), { cwd: dir, stdio: 'pipe' });
      filled.push(slot.id);
    }
  }
  return filled;
}
