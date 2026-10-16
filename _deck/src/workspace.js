import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeckError, EXIT, environment } from './util/fail.js';
import { readJsonIfExists, writeJson } from './util/fs.js';

/**
 * Where deck keeps things.
 *
 * Two roots, like squad:
 *
 *   the WORKSPACE   the deck itself - deck.yaml, storyboard.yaml, assets,
 *                   out/. Discovered by walking up from the cwd looking for
 *                   deck.yaml, so `deck lint` works from a subdirectory.
 *   the STATE ROOT  cross-deck state: the registry of known decks. Honours
 *                   DECK_STATE_ROOT, then XDG_STATE_HOME, exactly as squad and
 *                   vet do, so a test can point it somewhere disposable.
 *
 * Per-deck state lives in <deck>/.deck/ rather than under the state root. A
 * deck is a directory the PO can move, copy or hand to someone else, and its
 * approvals have to travel with it.
 */

/** @returns {string} */
export function stateRoot() {
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return process.env.DECK_STATE_ROOT || path.join(xdg, 'deck');
}

/** @returns {string} the directory holding deck's bundled themes and schemas */
export function deckHome() {
  if (process.env.DECK_HOME) return process.env.DECK_HOME;
  // src/workspace.js -> src -> _deck
  return path.resolve(new URL('..', import.meta.url).pathname);
}

/** @param {string} [start] @returns {string | null} */
export function findWorkspace(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'deck.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** @returns {string} @throws {DeckError} when the cwd is not inside a deck */
export function requireWorkspace(start = process.cwd()) {
  const found = findWorkspace(start);
  if (!found) {
    environment('not inside a deck workspace', [
      `No deck.yaml was found in ${path.resolve(start)} or any parent.`,
      'Run `deck init <dir>` to scaffold one.',
    ]);
  }
  return found;
}

/**
 * @typedef {object} Paths
 * @property {string} root
 * @property {string} deckYaml
 * @property {string} storyboard
 * @property {string} sources
 * @property {string} inbox
 * @property {string} assets
 * @property {string} assetManifest
 * @property {string} state      <deck>/.deck
 * @property {string} stateJson
 * @property {string} approvals
 * @property {string} out
 * @property {string} outHtml
 * @property {string} outPng
 * @property {string} outLint
 * @property {string} pdf
 * @property {string} geometry
 * @property {string} promptsMd
 */

/** @param {string} root @returns {Paths} */
export function paths(root) {
  const out = path.join(root, 'out');
  const state = path.join(root, '.deck');
  return {
    root,
    deckYaml: path.join(root, 'deck.yaml'),
    storyboard: path.join(root, 'storyboard.yaml'),
    sources: path.join(root, 'sources'),
    // WHERE THE PO DROPS RETURNED IMAGES. One fixed, named directory, so the
    // illustration handover is "put the files here" rather than "tell me each
    // path"; `deck gate inbox` maps the file names back to slot ids itself.
    inbox: path.join(root, 'inbox'),
    assets: path.join(root, 'assets'),
    assetManifest: path.join(root, 'assets', 'manifest.json'),
    state,
    stateJson: path.join(state, 'state.json'),
    approvals: path.join(state, 'approvals'),
    out,
    outHtml: path.join(out, 'html'),
    outPng: path.join(out, 'png'),
    outLint: path.join(out, 'lint'),
    pdf: path.join(out, 'deck.pdf'),
    geometry: path.join(out, 'geometry.json'),
    promptsMd: path.join(out, 'prompts.md'),
  };
}

/**
 * The deck lifecycle. Phases are advisory - `deck status` reports where the
 * deck is - but the TRANSITIONS are checked, because a deck that goes
 * backwards silently is how a stale approval ends up on a release render.
 *
 * drafting      storyboard exists, nothing approved
 * agenda-approved   the spine is signed off; wording may still move
 * content-approved  the exact words are signed off
 * rendered      a preview or release render exists for the current digest
 * released      a release render exists and matched the content approval
 *
 * @type {Record<string, string[]>}
 */
export const PHASES = {
  drafting: ['drafting', 'agenda-approved', 'content-approved'],
  'agenda-approved': ['drafting', 'agenda-approved', 'content-approved'],
  'content-approved': ['drafting', 'agenda-approved', 'content-approved', 'rendered'],
  rendered: ['drafting', 'agenda-approved', 'content-approved', 'rendered', 'released'],
  released: ['drafting', 'agenda-approved', 'content-approved', 'rendered', 'released'],
};

export const PHASE_ORDER = ['drafting', 'agenda-approved', 'content-approved', 'rendered', 'released'];

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function transitionAllowed(from, to) {
  const allowed = PHASES[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** @param {Paths} p @returns {any} */
export function readState(p) {
  const s = readJsonIfExists(p.stateJson);
  if (s) return s;
  return {
    schema: 'deck.state/1',
    phase: 'drafting',
    created_at: null,
    updated_at: null,
    theme: null,
    last_render: null,
  };
}

/**
 * @param {Paths} p
 * @param {any} next
 */
export function writeState(p, next) {
  writeJson(p.stateJson, { ...next, updated_at: new Date().toISOString() });
}

/**
 * Move the deck to a new phase, refusing an illegal transition out loud.
 * @param {Paths} p
 * @param {string} to
 */
export function setPhase(p, to) {
  const state = readState(p);
  if (state.phase === to) return state;
  if (!transitionAllowed(state.phase, to)) {
    throw new DeckError(`illegal phase transition: ${state.phase} -> ${to}`, EXIT.PROCESS_FAILED, [
      `Allowed from ${state.phase}: ${(PHASES[state.phase] || []).join(', ') || '(none)'}`,
    ]);
  }
  const next = { ...state, phase: to };
  writeState(p, next);
  return next;
}

/** Register this deck in the cross-deck state root, best effort. @param {string} root */
export function registerDeck(root) {
  try {
    const file = path.join(stateRoot(), 'decks.json');
    const existing = readJsonIfExists(file) || { schema: 'deck.registry/1', decks: [] };
    const abs = path.resolve(root);
    if (!existing.decks.some((d) => d.path === abs)) {
      existing.decks.push({ path: abs, registered_at: new Date().toISOString() });
      writeJson(file, existing);
    }
  } catch {
    // The registry is a convenience. A read-only state root must not stop a
    // render.
  }
}
