import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../schema.js';
import { DeckError, EXIT, environment } from '../util/fail.js';
import { assertInside, sha256File } from '../util/fs.js';
import { loadYaml } from '../util/yaml.js';
import { deckHome } from '../workspace.js';

/**
 * Resolve, load and check a theme.
 *
 * A theme is DATA: theme.yaml for tokens, deck.css for arrangement,
 * style-brief.md for the prose a slot prompt inlines, reference/*.png for the
 * images the PO attaches to ChatGPT. Nothing here is code, so a new theme is
 * a directory rather than a patch.
 *
 * @param {string} nameOrPath
 * @param {object} [overrides] per-deck token overrides from deck.yaml
 * @returns {any}
 */
export function loadTheme(nameOrPath, overrides = {}) {
  const dir = resolveThemeDir(nameOrPath);
  const file = path.join(dir, 'theme.yaml');
  if (!fs.existsSync(file)) {
    environment(`theme "${nameOrPath}" has no theme.yaml`, [`Looked in: ${dir}`]);
  }
  const raw = loadYaml(file);
  const merged = deepMerge(raw, overrides);
  const errors = validate('theme.schema.json', merged, `${file}: `);
  if (errors.length > 0) {
    throw new DeckError(`theme "${nameOrPath}" does not match deck's theme schema`, EXIT.VERDICT_FAILED, errors);
  }

  // Every declared contrast exception must carry a reason. An undocumented
  // exception is indistinguishable from someone having silenced a real
  // failure, so it is refused rather than accepted quietly.
  const exceptions = merged.lint.contrast_exceptions || {};
  const notes = merged.lint.exception_notes || {};
  const undocumented = Object.keys(exceptions).filter((k) => !notes[k] || !String(notes[k]).trim());
  if (undocumented.length > 0) {
    throw new DeckError(
      `theme "${merged.name}" declares contrast exceptions with no recorded reason: ${undocumented.join(', ')}`,
      EXIT.VERDICT_FAILED,
      ['Add an entry under lint.exception_notes for each. An exception nobody wrote down is a silenced failure.'],
    );
  }

  merged.__dir = dir;
  merged.__css = path.join(dir, 'deck.css');
  // CONTAINMENT. `slots.style_brief_file` is overridable from deck.yaml, and
  // `deck prompts` reads it and embeds its CONTENTS into prompts.md and into
  // --slot output - material the PO pastes into a chat with a third party. A
  // traversing path therefore discloses arbitrary local files with no browser
  // involved at all. It is resolved against the theme directory and must stay
  // inside it.
  merged.__styleBrief = merged.slots?.style_brief_file
    ? assertInside(
      path.resolve(dir, merged.slots.style_brief_file),
      dir,
      `the theme's style_brief_file ("${merged.slots.style_brief_file}")`,
    )
    : null;
  merged.__referenceDir = path.join(dir, 'reference');
  merged.__referenceImages = listReferenceImages(merged.__referenceDir);
  return merged;
}

/** @param {string} dir */
export function listReferenceImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();
}

/** @param {string} nameOrPath */
export function resolveThemeDir(nameOrPath) {
  if (nameOrPath.includes('/')) {
    const abs = path.resolve(nameOrPath);
    if (!fs.existsSync(abs)) environment(`theme directory does not exist: ${abs}`);
    return abs;
  }
  const bundled = path.join(deckHome(), 'themes', nameOrPath);
  if (!fs.existsSync(bundled)) {
    const available = fs.existsSync(path.join(deckHome(), 'themes'))
      ? fs.readdirSync(path.join(deckHome(), 'themes')).join(', ')
      : '(none)';
    environment(`unknown theme "${nameOrPath}"`, [`Available: ${available}`]);
  }
  return bundled;
}

/**
 * Verify the pinned fonts are present and unmodified.
 *
 * A font whose bytes changed is not the font the theme was measured against,
 * so every size band and every measured gap is suspect. Reported as an error
 * rather than a warning for that reason.
 *
 * @param {any} theme
 * @returns {{family: string, file: string, ok: boolean, problem: string | null, sha256: string | null}[]}
 */
export function checkFonts(theme) {
  return theme.fonts.pinned.map((f) => {
    const file = path.join(theme.__dir, f.file);
    if (!fs.existsSync(file)) {
      return { family: f.family, file, ok: false, problem: 'the pinned font file is missing', sha256: null };
    }
    const actual = sha256File(file);
    if (actual !== f.sha256) {
      return {
        family: f.family,
        file,
        ok: false,
        problem: `SHA-256 mismatch: theme.yaml records ${f.sha256}, the file on disk is ${actual}. This is not the font the theme's size bands were measured against.`,
        sha256: actual,
      };
    }
    const licence = path.join(theme.__dir, f.license_file);
    if (!fs.existsSync(licence)) {
      return { family: f.family, file, ok: false, problem: `the bundled licence ${f.license_file} is missing, so this font cannot be redistributed with the theme`, sha256: actual };
    }
    return { family: f.family, file, ok: true, problem: null, sha256: actual };
  });
}

/** @param {any} base @param {any} patch */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object')
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}
