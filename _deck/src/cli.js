#!/usr/bin/env node

/**
 * deck - AI-assisted slide production.
 *
 * Dispatch and nothing else. Every subcommand lives in src/commands and
 * returns its exit code rather than calling process.exit, so a command is a
 * function a test can call directly.
 */

import { approveCommand } from './commands/approve.js';
import { assetsCommand } from './commands/assets.js';
import { doctorCommand } from './commands/doctor.js';
import { exportCommand } from './commands/export.js';
import { initCommand } from './commands/init.js';
import {
  agendaCommand, copyCommand, fidelityCommand, inboxCommand, ledgerCommand, sourceCommand,
} from './commands/intake.js';
import { lintCommand } from './commands/lint.js';
import { promptsCommand } from './commands/prompts.js';
import { renderCommand } from './commands/render.js';
import { schemaCommand } from './commands/schema.js';
import { statusCommand } from './commands/status.js';
import { validateCommand } from './commands/validate.js';
import { DeckError, EXIT } from './util/fail.js';
import { recordFailure } from './util/report.js';
import { findWorkspace, paths } from './workspace.js';

const USAGE = `Usage: deck gate init <dir> [--theme <name>]
       deck gate doctor [--json]
       deck gate source [--json]
       deck gate ledger [--json]
       deck gate agenda [--json]
       deck gate copy [--json]
       deck gate fidelity [--json]
       deck gate inbox [--dir <path>] [--json]
       deck gate schema [<name>] [--example | --schema] [--json]
       deck gate validate [--json]
       deck gate approve agenda|content
       deck gate status [--json]
       deck gate prompts [--out <file>]
       deck gate prompts --single [--out <file>]
       deck gate prompts --slot <id>
       deck gate assets import <slot-id> <file>
       deck gate assets list [--json]
       deck gate render [--release] [--html-only]
       deck gate lint [--json]
       deck gate export [--json]

Authoritative text and layout live in HTML/CSS on a fixed 16:9 pixel canvas,
rendered by the installed Google Chrome to PDF and rasterized to PNG.
Illustrations are images dropped into declared SLOTS and must contain no text.
Because the layout is real DOM, every geometry check is a measurement rather
than an opinion. That is the product.

THIS IS THE GATE LAYER, reached as "deck gate <name>" from the launcher. The
PO's own interface is deck "<title>", which launches an agent that drives
these gates and never asks the PO to open storyboard.yaml.

Commands:
  deck gate init <dir>   Scaffold a deck workspace. --theme picks a theme from
                         _deck/themes; the default is watercolor.
  deck gate source            Was the source material fully retrieved? Checks
                         sources/manifest.json: a complete:false entry, an
                         unfollowed Notion pagination cursor, or a named
                         missing piece each BLOCK, because an agenda built on
                         half the minutes looks exactly like one built on all
                         of them.
  deck gate ledger            Does every ledger quote really occur in the source?
                         Each entry's exact wording is looked for in the saved
                         source text, and an entry whose quote is absent is
                         refused by id. This is the one check that can catch an
                         invented decision. It cannot catch a real quote that
                         was MISREAD - only the PO can, at the agenda gate.
  deck gate agenda            Is every still-open ledger item either on the proposed
                         agenda or in the exclusion list with a reason? An
                         agenda that quietly drops an unresolved decision looks
                         complete; nobody can see an absence.
  deck gate copy              The readable Japanese copy sheet for the content gate:
                         every title, subtitle, body line and table cell, each
                         marked 【引用】 or 【作成】. The provenance is COMPUTED
                         from the source text, not declared by the agent.
  deck gate fidelity          Do the storyboard's numbers, dates and table cells
                         trace back to a source? The other half of
                         content-integrity: that rule checks storyboard ->
                         rendered DOM, this one checks source -> storyboard.
  deck gate inbox             Import every returned illustration the PO dropped in
                         <deck>/inbox, mapping the file names the single brief
                         asked for back to slot ids. Lists what it could not
                         place rather than guessing: a wrong illustration in
                         the right slot is worse than a missing one, because
                         lint cannot see it.
  deck gate doctor            Report Chrome, pdftoppm, pdfinfo, fonts and node
                         versions, and the theme's declared exceptions.
                         INSTALLS NOTHING. Exits 3 if something required is
                         missing, so it works as a preflight.
  deck gate schema            The shape of a file deck reads, with a worked example
                         that has every optional field in it. Named: sources,
                         ledger, agenda, storyboard, deck, assets. The error
                         messages name an unknown key, which is enough to
                         converge on the right shape by trial; this is the way
                         to just ask. No argument lists them.
  deck gate validate          Schema-check deck.yaml and storyboard.yaml, then check
                         what a schema cannot: that the page type is
                         implemented, the theme has geometry for it, slot ids
                         are unique and positioned, and the body blocks are
                         ones that page type can lay out.
  deck gate approve agenda    Record the SHA-256 of the exact revision whose SPINE
                         is approved: slide ids, order, page types, titles.
  deck gate approve content   Record the SHA-256 of the exact revision whose WORDS
                         are approved. Changing wording, slide order or slide
                         count invalidates this; changing only the theme or
                         layout does not.
  deck gate status            Phase, approved revision, slot state. The phase is
                         re-derived from what is on disk, not read back from
                         state.json.
  deck gate prompts           Emit ready-to-paste ChatGPT illustration prompts, one
                         per slot, to out/prompts.md. There is no
                         image-generation API here by decision: you draw the
                         illustrations and deck emits the prompts.
  deck gate prompts --single  ONE brief covering the whole deck, to out/prompts-single.md:
                         the style stated once, then every image in deck order
                         with where it goes, its exact size and what it must
                         depict, and a filename that maps each returned file
                         back to its slot. Paste it into a single ChatGPT
                         conversation and work down it. That one conversation
                         is what keeps the style consistent between images,
                         which matters most when the theme ships no reference
                         images. Slots marked reuse_unchanged are listed as
                         yours to supply, never as things to generate.
  deck gate prompts --slot ID One entry to stdout, for regenerating a single image
                         later. Mutually exclusive with --single.
  deck gate assets import     Place a returned image into a slot. The original file
                         is COPIED, never modified; its SHA-256 is recorded and
                         survives to the output. An imported asset is reused
                         when its container merely moves or resizes, and is
                         only re-requested when the slot's brief changes.
  deck gate render            storyboard -> HTML -> PDF -> PNGs, plus
                         out/geometry.json for the linter. A plain render is a
                         PREVIEW and is always allowed.
  deck gate render --release  Refuses to run when the storyboard's content digest
                         does not match the approved one, and says what changed.
  deck gate render --html-only
                         Write out/html and stop. Starts no browser, so it is
                         the way to inspect what deck would render.
  deck gate lint              The layout gate, on measured geometry. Two
                         PRESENCE rules first - whether every declared
                         illustration slot has its picture, and how much of
                         the content region the page actually uses - because
                         "is anything on this page" precedes "is it in the
                         right place". Then two-axis centring, overflow and
                         clipping, collision and occlusion, safe margins, the
                         alignment grid, type size, contrast against the
                         composited backing, cross-slide repetition, and
                         declared proximity groups. Writes
                         out/lint/report.json, a readable summary, and an
                         annotated PNG per finding.
  deck gate export            Verify and list the rendered PDF and PNGs. Renders
                         nothing: an export that rendered could hand over a PDF
                         nobody has linted.

Exit codes:
  0  the command completed AND its verdict passed
  1  the command completed AND its verdict failed - lint violations, a schema
     problem, a refused release. A successful process with a failing answer.
  2  usage error: a bad flag, a missing argument, an unknown subcommand
  3  environment error: no Chrome, no poppler, no deck workspace
  4  the command itself FAILED and has no verdict to report at all

  1 and 4 are deliberately different. A lint run that completed and found
  violations is not the same event as a lint run that died, and every
  deterministic command writes both a <name>-status.txt holding the PROCESS
  status and a <name>.json whose "verdict" field is the SEMANTIC answer.

Environment:
  DECK_HOME          Where deck's Node sources, schemas and themes live.
                     Default: the _deck directory beside the resolved real
                     path of the deck executable.
  DECK_STATE_ROOT    Cross-deck state. Default
                     \${XDG_STATE_HOME:-$HOME/.local/state}/deck.
                     Per-deck state lives in <deck>/.deck so it travels with
                     the deck.
  DECK_NODE          The node binary to use. Default: node from PATH.

Not in this increment, and refused by name rather than ignored: PPTX export,
the ivory-forest theme, any image-generation API, and the page types standard,
media and background-only. The page types comparison, process, ecosystem and
timeline ARE implemented; "deck gate validate" prints a composition note when
a deck turns every relationship into a table.
`;

/** @type {Record<string, (argv: string[]) => Promise<number>>} */
const COMMANDS = {
  init: initCommand,
  doctor: doctorCommand,
  source: sourceCommand,
  ledger: ledgerCommand,
  agenda: agendaCommand,
  copy: copyCommand,
  fidelity: fidelityCommand,
  inbox: inboxCommand,
  validate: validateCommand,
  approve: approveCommand,
  status: statusCommand,
  prompts: promptsCommand,
  assets: assetsCommand,
  render: renderCommand,
  schema: schemaCommand,
  lint: lintCommand,
  export: exportCommand,
};

/**
 * Which report file an invocation OWNS, so a crash replaces that one.
 *
 * `prompts --single` writes prompts-single.json rather than prompts.json, and
 * `agenda` writes agenda-check.json so it cannot collide with the agent's own
 * agenda.json input. Both would otherwise leave a stale `verdict: pass` on
 * disk after a failed run, which is the trap the report split exists to avoid.
 *
 * @param {string} verb
 * @param {string[]} rest
 * @returns {string | undefined}
 */
function failureReportName(verb, rest) {
  if (verb === 'prompts' && rest.includes('--single')) return 'prompts-single';
  if (verb === 'agenda') return 'agenda-check';
  return undefined;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const [verb, ...rest] = argv;

  if (!verb || verb === '-h' || verb === '--help' || verb === 'help') {
    process.stdout.write(USAGE);
    // A bare `deck` is a usage error; an explicit --help is not.
    return verb ? EXIT.OK : EXIT.USAGE;
  }
  if (verb === '--version' || verb === 'version') {
    process.stdout.write('deck 0.1.0\n');
    return EXIT.OK;
  }

  const command = COMMANDS[verb];
  if (!command) {
    process.stderr.write(`Error: unknown subcommand "${verb}"\n`);
    process.stderr.write(`       Known: ${Object.keys(COMMANDS).join(', ')}\n`);
    process.stderr.write('       See: deck gate --help\n');
    return EXIT.USAGE;
  }

  try {
    return await command(rest);
  } catch (err) {
    const isDeckError = err instanceof DeckError;
    const code = isDeckError ? err.code : EXIT.PROCESS_FAILED;
    const message = isDeckError
      ? err.message
      : `deck ${verb} failed unexpectedly and produced no verdict`;
    const details = isDeckError ? err.details : [String(err && err.stack ? err.stack : err)];

    process.stderr.write(`Error: ${message}\n`);
    for (const line of details) process.stderr.write(`       ${line}\n`);

    // PUBLISH THE FAILURE AND INVALIDATE THE PREVIOUS SUCCESS.
    //
    // Printing to stderr and returning a code is not enough: the report files
    // are the machine-readable surface, and leaving a previous `verdict: pass`
    // and `report-status.txt` of 0 on disk after a failed run is precisely the
    // stale-success trap squad is built to avoid. A usage error is excluded -
    // nothing ran, so there is nothing to invalidate.
    if (code !== EXIT.USAGE) {
      const root = findWorkspace();
      if (root) {
        recordFailure({
          outDir: paths(root).out,
          root,
          command: verb,
          // Which report this invocation owns. `prompts --single` writes
          // prompts-single.json, so a failure must replace THAT one.
          reportName: failureReportName(verb, rest),
          message,
          details,
          code,
        });
      }
    }
    return code;
  }
}

// `import.meta.main` is not available on every supported Node, so the entry
// point is detected from argv[1] instead.
const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('/deck'));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
