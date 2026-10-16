import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readCoverage } from '../font/cmap.js';
import { probeChrome } from '../render/browser.js';
import { toolVersion } from '../render/raster.js';
import { checkFonts, loadTheme, listReferenceImages } from '../theme/load.js';
import { EXIT } from '../util/fail.js';
import { loadYaml } from '../util/yaml.js';
import { findWorkspace, deckHome, stateRoot } from '../workspace.js';

/**
 * `deck doctor` - report, INSTALL NOTHING.
 *
 * A doctor that installs things is a doctor that changes the machine while you
 * are trying to work out what is wrong with it. This only looks.
 *
 * It exits 0 when everything deck needs to render is present, and 3 when
 * something is missing - so it can be used as a preflight in a script.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function doctorCommand(argv) {
  const json = argv.includes('--json');
  /** @type {{name: string, ok: boolean, detail: string, required: boolean}[]} */
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });

  // --- node ---------------------------------------------------------------
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 20 || (major === 20 && minor >= 11);
  add('node', nodeOk, `${process.version}${nodeOk ? '' : ' (deck needs 20.11 or newer)'}`);

  // --- chrome -------------------------------------------------------------
  const chrome = await probeChrome();
  add('Google Chrome', chrome.ok,
    chrome.ok
      ? `${chrome.version} via channel "chrome"${chrome.installed_path ? `; installed at ${chrome.installed_path}` : '; no installed Chrome found at a standard path'}${chrome.matches_installed === false ? ` - WARNING: the installed Chrome reports ${chrome.installed_version}, which does not match the launched build` : ''}`
      : `not usable: ${chrome.problem}`);

  // --- poppler ------------------------------------------------------------
  for (const tool of ['pdftoppm', 'pdfinfo']) {
    const v = toolVersion(tool);
    add(tool, v !== null, v || 'not found on PATH (macOS: brew install poppler)');
  }

  // --- deck's own install -------------------------------------------------
  add('deck home', fs.existsSync(path.join(deckHome(), 'src', 'cli.js')), deckHome());
  const nm = path.join(deckHome(), 'node_modules');
  add('node_modules', fs.existsSync(nm), fs.existsSync(nm) ? nm : `missing - run: npm install --prefix ${deckHome()}`);
  add('state root', true, stateRoot(), false);

  // --- theme + fonts ------------------------------------------------------
  const workspace = findWorkspace();
  let themeName = 'watercolor';
  if (workspace) {
    // Read the theme name only, and tolerate a broken deck.yaml: a doctor run
    // is most useful precisely when something is wrong, so a malformed request
    // file must not stop it reporting on Chrome and poppler.
    try {
      const req = loadYaml(path.join(workspace, 'deck.yaml'));
      if (req?.request?.theme) themeName = req.request.theme;
    } catch (err) {
      add('deck.yaml', false, `unreadable, so doctor fell back to the default theme: ${err.message}`, false);
    }
  }
  add('deck workspace', workspace !== null,
    workspace || 'not inside a deck workspace (that is fine for a doctor run)', false);

  /** @type {string[]} */
  const notes = [];
  try {
    const theme = loadTheme(themeName);
    add(`theme "${themeName}"`, true, theme.__dir);
    for (const f of checkFonts(theme)) {
      add(`font ${f.family}`, f.ok, f.ok ? `${f.file} (sha256 verified)` : f.problem);
      if (f.ok) {
        try {
          const cov = readCoverage(f.file);
          add(`font coverage ${f.family}`, cov.size > 10000,
            `${cov.size} codepoints in ${cov.ranges.length} ranges via ${cov.notes.join(', ')}`);
        } catch (err) {
          add(`font coverage ${f.family}`, false, `cmap unreadable: ${err.message}`);
        }
      }
    }
    const refs = listReferenceImages(theme.__referenceDir);
    add('theme reference images', refs.length > 0,
      refs.length > 0
        ? `${refs.length} in ${theme.__referenceDir}: ${refs.join(', ')}`
        : `none in ${theme.__referenceDir} - \`deck prompts\` will say so rather than naming files that do not exist. Add your own style references there; deck ships none, because the deck this theme was measured from is the PO's confidential client material and does not belong in a shared repository.`,
      false);

    // THE DECLARED THEME EXCEPTIONS, reported here as well as in lint, because
    // the PO's decision was that they are visible rather than silent.
    const exceptions = theme.lint.contrast_exceptions || {};
    for (const [role, value] of Object.entries(exceptions)) {
      notes.push(`contrast exception: role "${role}" is allowed ${value}:1 instead of ${theme.lint.contrast_min}:1. ${theme.lint.exception_notes[role]}`);
    }
  } catch (err) {
    add(`theme "${themeName}"`, false, err.message);
  }

  // --- system Japanese fonts, informational only --------------------------
  // Reported so the PO can see that deck does NOT depend on them. Hiragino is
  // installed on this machine, and that is exactly why it cannot be the
  // strategy.
  let systemJp = 'fc-list not available';
  try {
    const out = execFileSync('fc-list', [':lang=ja', 'family'], { encoding: 'utf8' });
    systemJp = `${out.trim().split('\n').length} system families support Japanese (deck does not use any of them; it pins its own)`;
  } catch { /* fontconfig is optional */ }
  add('system Japanese fonts', true, systemJp, false);

  const requiredFailures = checks.filter((c) => c.required && !c.ok);

  if (json) {
    process.stdout.write(`${JSON.stringify({
      schema: 'deck.report/1',
      command: 'doctor',
      process: 'ok',
      verdict: requiredFailures.length === 0 ? 'pass' : 'fail',
      summary: requiredFailures.length === 0
        ? 'everything deck needs to render is present'
        : `${requiredFailures.length} required component(s) missing`,
      generated_at: new Date().toISOString(),
      checks,
      theme_exceptions: notes,
    }, null, 2)}\n`);
  } else {
    process.stdout.write('deck doctor\n\n');
    for (const c of checks) {
      const mark = c.ok ? ' ok  ' : (c.required ? 'FAIL ' : ' --  ');
      process.stdout.write(`  ${mark} ${c.name.padEnd(26)} ${c.detail}\n`);
    }
    if (notes.length > 0) {
      process.stdout.write('\n  declared theme exceptions (reported every run, never silent):\n');
      for (const n of notes) process.stdout.write(`    - ${n.replace(/\s+/g, ' ')}\n`);
    }
    process.stdout.write('\n');
    process.stdout.write(requiredFailures.length === 0
      ? 'All required components are present. deck installs nothing; this run changed nothing.\n'
      : `${requiredFailures.length} required component(s) missing: ${requiredFailures.map((c) => c.name).join(', ')}\ndeck installs nothing. Install them yourself and re-run.\n`);
  }
  return requiredFailures.length === 0 ? EXIT.OK : EXIT.ENVIRONMENT;
}
