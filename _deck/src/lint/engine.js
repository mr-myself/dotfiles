import fs from 'node:fs';
import path from 'node:path';
import { annotate } from './annotate.js';
import { isBlocking } from './finding.js';
import { setRuleSet } from './geometry-check.js';
import { READS as alignmentReads, alignmentRule } from './rules/alignment.js';
import { READS as contentIntegrityReads, contentIntegrityRule } from './rules/content-integrity.js';
import { READS as centringReads, centringRule } from './rules/centring.js';
import { READS as collisionReads, collisionRule } from './rules/collision.js';
import { READS as contrastReads, contrastRule } from './rules/contrast.js';
import { READS as occupancyReads, occupancyRule } from './rules/occupancy.js';
import { READS as overflowReads, overflowRule } from './rules/overflow.js';
import { READS as proximityReads, proximityRule } from './rules/proximity.js';
import { READS as repetitionReads, repetitionRule } from './rules/repetition.js';
import { READS as safeMarginsReads, safeMarginsRule } from './rules/safe-margins.js';
import { READS as slotFillReads, slotFillRule } from './rules/slot-fill.js';
import { READS as typeSizeReads, typeSizeRule } from './rules/type-size.js';

/**
 * The rules, in report order.
 *
 * The two PRESENCE rules come first and the geometry rules after them,
 * because "is anything on this page" precedes "is it in the right place". The
 * order is the PO's diagnosis made structural: ten blocking findings about
 * subtitles 32 px apart, on a deck where fourteen of fifteen illustration
 * slots were empty and the bottom four tenths of every three-column page was
 * blank. Consistency measured on a page with nothing on it.
 */
export const RULES = [
  // FIRST, because "is it there at all" precedes "is it in the right place".
  { id: 'content-integrity', run: contentIntegrityRule, reads: contentIntegrityReads },
  { id: 'slot-fill', run: slotFillRule, reads: slotFillReads },
  { id: 'occupancy', run: occupancyRule, reads: occupancyReads },
  { id: 'centring', run: centringRule, reads: centringReads },
  { id: 'overflow', run: overflowRule, reads: overflowReads },
  { id: 'collision', run: collisionRule, reads: collisionReads },
  { id: 'safe-margins', run: safeMarginsRule, reads: safeMarginsReads },
  { id: 'alignment', run: alignmentRule, reads: alignmentReads },
  { id: 'type-size', run: typeSizeRule, reads: typeSizeReads },
  { id: 'contrast', run: contrastRule, reads: contrastReads },
  { id: 'repetition', run: repetitionRule, reads: repetitionReads },
  { id: 'proximity', run: proximityRule, reads: proximityReads },
];

// Each rule declares the measurements it consumes; the validator checks
// exactly that union before any of them runs.
setRuleSet(RULES);

/**
 * WHAT THIS LINTER CANNOT DO.
 *
 * Stated in the code, printed in the report and documented in the README,
 * because a gate that overstates its coverage is worse than no gate: the PO
 * stops looking.
 *
 * Rectangles and computed styles cannot prove:
 *   - optical balance. Two columns with identical boxes can still look wrong.
 *   - glyph ink. The measured line box is the font's metrics, not the shape of
 *     the characters, so optical alignment of a large heading is out of reach.
 *   - anything inside a raster illustration. A slot image is opaque to every
 *     rule here; if it contains text, deck cannot see it. That is why slot
 *     prompts forbid text in the image rather than checking for it afterwards.
 *   - whether the composition is any good. The occupancy rule measures how
 *     much of the region has anything on it, which is a different and much
 *     cruder question: a well-filled page can still be badly arranged, and a
 *     deliberately empty half-page is reported as a suggestion, never failed.
 *   - the WORDS. Five errors reached a real page - a slide asserting the
 *     opposite of what the meeting concluded, an internal note to the PO
 *     rendered as a slide, a percentage attached to the wrong population, a
 *     name garbled by a transcript - and no rule here could have caught any
 *     of them. All five were plainly visible in the copy sheet. That is the
 *     argument for rendering a draft and showing it EARLY, not for another
 *     rule.
 *
 * Those belong to a human or a vision reviewer.
 */
export const HONEST_LIMITS = [
  'Rectangle geometry cannot prove optical balance: identical boxes can still look wrong.',
  'Content integrity checks that required text is painted and says the right words; it cannot tell whether the words are the RIGHT words for the slide.',
  'Line boxes are font metrics, not glyph ink, so optical alignment of large display type is out of reach.',
  'Nothing inside a slot illustration is visible to any rule here. Slot prompts forbid text in the image rather than checking for it afterwards.',
  'Occupancy is a coarse grid over the content region, not a judgement about composition: a page can be well filled and badly arranged, and a deliberately sparse page is reported as a suggestion rather than failed.',
  'Nothing here reads the WORDS. Every one of the five errors that reached a real page - a slide saying the opposite of the meeting\'s conclusion, an internal note rendered as a slide, a figure attached to the wrong population, an unverifiable name - was visible in the copy sheet and invisible to every rule in this list. Showing the PO a readable page early is the only defence, which is why a draft render comes before the content gate.',
];

/**
 * @param {object} opts
 * @param {any[]} opts.slides     measured geometry, one entry per slide
 * @param {any} opts.theme
 * @param {any} [opts.storyboard] needed by the content-integrity rule, which
 *   is the only one that asks what SHOULD be on a slide rather than where
 *   what is there has landed
 * @param {string} [opts.pngDir]  rendered pages, for annotation
 * @param {string} [opts.annotationDir]
 * @param {Record<string, string>} [opts.pngBySlide]
 * @returns {{findings: any[], summary: any}}
 */
export function runLint({ slides, theme, storyboard, annotationDir, pngBySlide = {} }) {
  /** @type {any[]} */
  let findings = [];
  /** @type {Record<string, {ran: boolean, error: string | null, findings: number}>} */
  const ruleStatus = {};

  for (const rule of RULES) {
    try {
      const produced = rule.run({ slides, theme, storyboard });
      findings.push(...produced);
      ruleStatus[rule.id] = { ran: true, error: null, findings: produced.length };
    } catch (err) {
      // A rule that throws has not passed. It is recorded as a blocking
      // `unsupported` finding, exactly as squad turns a non-zero lens status
      // into must_fix: a check that did not complete must never read as a
      // clean result.
      ruleStatus[rule.id] = { ran: false, error: String(err && err.message ? err.message : err), findings: 1 };
      findings.push({
        rule: rule.id,
        severity: 'unsupported',
        slide: '(all)',
        element: null,
        axis: null,
        reference: null,
        message: `the ${rule.id} rule FAILED to run, so nothing was checked by it: ${err && err.message ? err.message : err}`,
        expected: null,
        measured: null,
        boxes: [],
      });
    }
  }

  // Stable order so two runs of the same deck produce the same report.
  const ruleOrder = new Map(RULES.map((r, i) => [r.id, i]));
  const slideOrder = new Map(slides.map((s, i) => [s.slide_id, i]));
  findings.sort((a, b) => (ruleOrder.get(a.rule) ?? 99) - (ruleOrder.get(b.rule) ?? 99)
    || (slideOrder.get(a.slide) ?? 999) - (slideOrder.get(b.slide) ?? 999)
    || String(a.element).localeCompare(String(b.element))
    || String(a.axis).localeCompare(String(b.axis)));

  // --- annotated evidence -------------------------------------------------
  if (annotationDir) {
    findings = findings.map((f, i) => {
      if (f.boxes.length === 0) return { ...f, evidence: null };
      const source = pngBySlide[f.slide];
      if (!source || !fs.existsSync(source)) {
        // Unreadable evidence is itself a reported problem, not something to
        // pass over quietly.
        return {
          ...f,
          evidence: null,
          evidence_error: `no rendered PNG was available for slide ${f.slide}, so this finding has no annotated image`,
        };
      }
      const name = `${String(i + 1).padStart(3, '0')}-${f.rule}-${f.slide}${f.axis ? `-${f.axis}` : ''}.png`;
      const outPng = path.join(annotationDir, name);
      try {
        annotate({
          sourcePng: source,
          outPng,
          canvasWidth: theme.canvas.width,
          boxes: f.boxes,
        });
        return { ...f, evidence: path.relative(path.dirname(annotationDir), outPng) };
      } catch (err) {
        return { ...f, evidence: null, evidence_error: `annotation failed: ${err.message}` };
      }
    });
  }

  const blocking = findings.filter(isBlocking);
  const suggestions = findings.filter((f) => f.severity === 'suggestion');

  return {
    findings,
    summary: {
      slides: slides.length,
      rules_run: Object.keys(ruleStatus).filter((k) => ruleStatus[k].ran).length,
      rules_total: RULES.length,
      rule_status: ruleStatus,
      blocking: blocking.length,
      suggestions: suggestions.length,
      by_rule: Object.fromEntries(RULES.map((r) => [
        r.id,
        {
          blocking: blocking.filter((f) => f.rule === r.id).length,
          suggestions: suggestions.filter((f) => f.rule === r.id).length,
        },
      ])),
      honest_limits: HONEST_LIMITS,
    },
  };
}

/**
 * The readable twin of report.json.
 * @param {any} result
 * @param {'pass' | 'fail'} verdict
 */
export function formatHumanReport(result, verdict) {
  const lines = [];
  lines.push('deck lint');
  lines.push('');
  lines.push(`verdict: ${verdict}`);
  lines.push(`slides checked: ${result.summary.slides}`);
  lines.push(`rules run: ${result.summary.rules_run}/${result.summary.rules_total}`);
  lines.push(`blocking findings: ${result.summary.blocking}`);
  lines.push(`suggestions: ${result.summary.suggestions}`);
  lines.push('');
  for (const [id, counts] of Object.entries(result.summary.by_rule)) {
    const status = result.summary.rule_status[id];
    const note = status && !status.ran ? '  RULE FAILED TO RUN' : '';
    lines.push(`  ${id.padEnd(14)} ${String(counts.blocking).padStart(3)} blocking, ${String(counts.suggestions).padStart(3)} suggestions${note}`);
  }
  lines.push('');

  const blocking = result.findings.filter(isBlocking);
  const suggestions = result.findings.filter((f) => f.severity === 'suggestion');

  if (blocking.length > 0) {
    lines.push('--- blocking -----------------------------------------------------------');
    for (const f of blocking) {
      lines.push('');
      lines.push(`[${f.rule}${f.axis ? `/${f.axis}` : ''}] ${f.slide}${f.element ? ` -> ${f.element}` : ''}${f.severity === 'unsupported' ? '  (UNSUPPORTED: not checked, so not passed)' : ''}`);
      lines.push(`  ${f.message}`);
      if (f.expected) lines.push(`  expected: ${JSON.stringify(f.expected)}`);
      if (f.measured) lines.push(`  measured: ${JSON.stringify(f.measured)}`);
      if (f.evidence) lines.push(`  evidence: ${f.evidence}`);
      if (f.evidence_error) lines.push(`  evidence: UNAVAILABLE - ${f.evidence_error}`);
    }
    lines.push('');
  }
  if (suggestions.length > 0) {
    lines.push('--- suggestions (never fail the gate) ---------------------------------');
    for (const f of suggestions) {
      lines.push(`  [${f.rule}] ${f.slide} -> ${f.element}: ${f.message}`);
    }
    lines.push('');
  }

  lines.push('--- what this gate cannot prove ---------------------------------------');
  for (const l of HONEST_LIMITS) lines.push(`  - ${l}`);
  return lines.join('\n');
}
