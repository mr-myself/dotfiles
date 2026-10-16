import fs from 'node:fs';
import { approvalState } from '../approvals.js';
import { readAgenda } from '../intake/agenda.js';
import {
  loadDeck, resolveAssets, slotFillState, slotKey, validateSemantics,
} from '../deck.js';
import { EXIT } from '../util/fail.js';
import { readJsonIfExists } from '../util/fs.js';
import { PHASE_ORDER, readState } from '../workspace.js';
import { renderFingerprint, renderOptions } from '../digest.js';

/**
 * `deck status` - phase, approved revision, slot state.
 *
 * The phase recorded in state.json is RE-DERIVED here rather than trusted,
 * the way `squad list` recomputes liveness instead of believing RUN_STATUS: a
 * stored "content-approved" next to a storyboard that has since changed is
 * exactly the stale answer that gets something shipped.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function statusCommand(argv) {
  const json = argv.includes('--json');
  const { root, p, storyboard, theme, manifest, request } = loadDeck();
  const stored = readState(p);
  // THE AGENDA ARTIFACT, when there is one. An agenda approval recorded
  // against agenda.json has to be compared with agenda.json; comparing it
  // with the storyboard spine is what made every agenda approval evaporate
  // as soon as the agent wrote a real title.
  const agendaArtifact = (() => {
    try {
      return readAgenda(p);
    } catch {
      // A malformed agenda.json is the agenda gate's problem to report. Here
      // it means "cannot compare", which approvalState renders as such.
      return null;
    }
  })();
  const agenda = approvalState(p, 'agenda', storyboard, agendaArtifact);
  const content = approvalState(p, 'content', storyboard);
  const assets = resolveAssets(root, manifest, storyboard);
  const problems = validateSemantics(storyboard, theme);

  // Asset problems - a file deleted since import, a manifest entry pointing
  // outside assets/ - used to show up only as a slot that looked "empty",
  // which is indistinguishable from one nobody has filled yet.
  const assetProblems = assets.__problems || [];
  const slots = [];
  for (const slide of storyboard.slides) {
    for (const slot of slide.slots || []) {
      const a = assets[slotKey(slide.id, slot.id)];
      const broken = assetProblems.find((x) => x.includes(`slot "${slot.id}"`));
      slots.push({
        slot_id: slot.id,
        slide_id: slide.id,
        state: a ? (a.stale ? 'stale' : 'filled') : (broken ? 'broken' : 'empty'),
        problem: broken || null,
        reuse_unchanged: slot.reuse_unchanged === true,
        sha256: a?.sha256 || null,
      });
    }
  }

  const lastRender = readJsonIfExists(`${p.outLint}/report.json`);
  const pdfExists = fs.existsSync(p.pdf);

  // THE SAME FRESHNESS CALCULATION THE OTHER COMMANDS USE.
  //
  // This derived rendered/released from the content digest alone and
  // reported the last lint verdict without checking which render it
  // inspected, so after a theme, CSS or slot edit it said
  // released / current / pass while lint and export correctly refused. Three
  // commands answering the same question differently is worse than any one
  // of the answers.
  const options = renderOptions(request, theme);
  const currentFingerprint = renderFingerprint({
    storyboard,
    theme,
    themeCss: fs.readFileSync(theme.__css, 'utf8'),
    assets,
    scale: options.png_scale,
    options,
  });
  const geometry = readJsonIfExists(p.geometry);
  const renderIsCurrent = Boolean(geometry) && geometry.render_fingerprint === currentFingerprint;
  const lintIsCurrent = Boolean(lastRender) && lastRender.render_fingerprint === currentFingerprint;

  // The derived phase. Deliberately computed from the facts on disk rather
  // than read from state.json, which is a record of what happened and not of
  // what is true now.
  let phase = 'drafting';
  if (agenda.approved && agenda.matches) phase = 'agenda-approved';
  if (content.approved && content.matches) phase = 'content-approved';
  // `rendered` and `released` mean the OUTPUT ON DISK is current, so they key
  // off the render fingerprint, not the content digest. A theme edit leaves
  // the content digest untouched and the output stale.
  if (phase === 'content-approved' && pdfExists && renderIsCurrent && geometry?.release) {
    phase = 'released';
  } else if (pdfExists && renderIsCurrent) {
    phase = PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf('content-approved') ? 'rendered' : phase;
  }

  const payload = {
    schema: 'deck.report/1',
    command: 'status',
    process: 'ok',
    verdict: problems.length === 0 && assetProblems.length === 0 ? 'pass' : 'fail',
    summary: `phase ${phase}; ${storyboard.slides.length} slide(s); ${slots.filter((s) => s.state === 'filled').length}/${slots.length} slot(s) filled`,
    generated_at: new Date().toISOString(),
    project: request.request.project_name,
    theme: theme.name,
    phase,
    recorded_phase: stored.phase,
    phase_is_derived: true,
    slides: storyboard.slides.length,
    validation_problems: problems,
    asset_problems: assetProblems,
    approvals: { agenda, content },
    slots,
    // THE SAME COUNT `render --release` AND THE `slot-fill` RULE USE.
    //
    // The launcher's build-cycle prints this beside lint_verdict, which was
    // the PO's own suggestion: `lint_verdict=pass  slots_empty=14` would have
    // ended the first deck's problem in one line. It is derived from the
    // shared helper rather than recounted here, so the number next to the
    // verdict cannot drift away from the number the verdict is about.
    slot_fill: slotFillState(storyboard, assets),
    last_render: stored.last_render,
    pdf_present: pdfExists,
    render_fingerprint: currentFingerprint,
    render_is_current: renderIsCurrent,
    last_lint: lastRender
      ? {
        verdict: lastRender.verdict,
        process: lastRender.process,
        blocking: lastRender.counts?.blocking,
        // A verdict about a DIFFERENT render says nothing about this one.
        inspected_this_render: lintIsCurrent,
      }
      : null,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return EXIT.OK;
  }

  process.stdout.write(`deck status: ${request.request.project_name}\n\n`);
  process.stdout.write(`  phase            ${phase}${stored.phase !== phase ? `  (state.json records "${stored.phase}"; the phase above is re-derived from what is on disk)` : ''}\n`);
  process.stdout.write(`  theme            ${theme.name}\n`);
  process.stdout.write(`  slides           ${storyboard.slides.length}\n`);
  process.stdout.write(`  validates        ${problems.length === 0 ? 'yes' : `NO - ${problems.length} problem(s), run deck validate`}\n`);
  process.stdout.write('\n  approvals\n');
  for (const [kind, st] of [['agenda', agenda], ['content', content]]) {
    if (!st.approved) {
      process.stdout.write(`    ${kind.padEnd(8)} not approved\n`);
    } else if (st.matches) {
      process.stdout.write(`    ${kind.padEnd(8)} approved ${st.approved_at}\n`);
      // WHAT IT COVERS. An agenda approval records agenda.json; a deck with
      // no agenda artifact records the storyboard spine instead, and a run
      // created before that distinction existed records the spine too. Saying
      // which is what explains a mismatch to whoever is reading this.
      process.stdout.write(`             covers ${st.subject}\n`);
      process.stdout.write(`             digest ${st.approved_digest}\n`);
    } else {
      process.stdout.write(`    ${kind.padEnd(8)} STALE - approved ${st.approved_at} (covers ${st.subject}), and that artifact has changed since\n`);
      for (const c of st.changes.slice(0, 6)) {
        process.stdout.write(`             ${c.split('\n').join('\n             ')}\n`);
      }
      if (st.changes.length > 6) process.stdout.write(`             ... and ${st.changes.length - 6} more\n`);
    }
  }
  process.stdout.write('\n  slots\n');
  if (slots.length === 0) process.stdout.write('    (none)\n');
  for (const s of slots) {
    process.stdout.write(`    ${s.slot_id.padEnd(20)} ${s.state.padEnd(8)} ${s.slide_id.padEnd(16)}${s.reuse_unchanged ? ' [reuse_unchanged]' : ''}${s.sha256 ? `  ${s.sha256.slice(0, 16)}` : ''}\n`);
    if (s.problem) process.stdout.write(`      ${s.problem}\n`);
  }
  process.stdout.write('\n  output\n');
  process.stdout.write(`    deck.pdf         ${pdfExists ? 'present' : 'not rendered'}\n`);
  process.stdout.write(`    output current   ${renderIsCurrent ? 'yes' : 'NO - the deck has changed since it was rendered; re-run deck render'}\n`);
  if (stored.last_render) {
    process.stdout.write(`    last render      ${stored.last_render.at}${stored.last_render.release ? ' (release)' : ' (preview)'}\n`);
    process.stdout.write(`    rendered digest  ${stored.last_render.content_digest}${stored.last_render.content_digest === content.current_digest ? ' (current)' : ' - STALE, the storyboard has changed since'}\n`);
  }
  if (payload.last_lint) {
    process.stdout.write(`    last lint        process ${payload.last_lint.process}, verdict ${payload.last_lint.verdict}, ${payload.last_lint.blocking} blocking\n`);
    if (!lintIsCurrent) {
      process.stdout.write('                     that verdict inspected a DIFFERENT render and says nothing about the current output\n');
    }
  } else {
    process.stdout.write('    last lint        NEVER RUN for this render\n');
  }
  process.stdout.write('\n');
  return EXIT.OK;
}
