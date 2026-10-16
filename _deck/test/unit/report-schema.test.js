import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  DECK_BIN, DECK_HOME, fillSlots, rm, tempDir, gateArgs,
} from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;

/**
 * THE REPORT SCHEMAS MUST DESCRIBE THE REAL REPORTS.
 *
 * lint-report.schema.json rejected EVERY normal lint report:
 * additionalProperties was false while content_digest, rule_status and
 * by_rule were absent from properties. A schema nothing is validated against
 * drifts silently, so these tests validate ACTUAL EMITTED FILES - produced by
 * running the commands - rather than hand-written samples that would drift
 * the same way.
 */

const ajv = new Ajv2020.default({ allErrors: true });
addFormats.default(ajv);
const validateLint = ajv.compile(JSON.parse(
  fs.readFileSync(path.join(DECK_HOME, 'schemas', 'lint-report.schema.json'), 'utf8'),
));

function deck(cwd, args, state) {
  try {
    return { code: 0, stdout: execFileSync(DECK_BIN, gateArgs(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECK_STATE_ROOT: state } }), stderr: '' };
  } catch (err) {
    return { code: err.status ?? -1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function explain(errors) {
  return (errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message} ${JSON.stringify(e.params)}`).join('\n');
}

test('A REAL PASSING LINT REPORT VALIDATES AGAINST ITS OWN SCHEMA', () => {
  const root = tempDir('deck-schema');
  const state = tempDir('deck-schema-state');
  const dir = path.join(root, 'deck');
  try {
    assert.equal(deck(root, ['init', dir], state).code, 0);
    // The scaffold reserves a cover-art slot and ships no picture, which the
    // slot-fill rule blocks on. This test is about the report SCHEMA, so it
    // starts from the state a real deck is in when it is linted for real.
    fillSlots(dir);
    assert.equal(deck(dir, ['render'], state).code, 0);
    const lint = deck(dir, ['lint'], state);
    assert.equal(lint.code, 0, lint.stdout + lint.stderr);

    const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'lint', 'report.json'), 'utf8'));
    assert.equal(report.verdict, 'pass');
    assert.equal(report.process, 'ok');
    assert.ok(validateLint(report), explain(validateLint.errors));

    // The fields whose absence from the schema was the bug.
    for (const key of ['content_digest', 'rule_status', 'by_rule', 'render_fingerprint']) {
      assert.ok(key in report, `the real report carries "${key}"`);
    }
  } finally {
    rm(root); rm(state);
  }
});

test('A REAL FAILING LINT REPORT ALSO VALIDATES', () => {
  const root = tempDir('deck-schema-fail');
  const state = tempDir('deck-schema-fail-state');
  const dir = path.join(root, 'deck');
  try {
    assert.equal(deck(root, ['init', dir], state).code, 0);
    // Slots filled, so the findings below come from the margin override this
    // test is actually about and not incidentally from an empty slot.
    fillSlots(dir);
    // Push the title off-canvas so lint has something real to find.
    fs.appendFileSync(path.join(dir, 'deck.yaml'),
      '\ntheme_overrides:\n  canvas:\n    safe_margins_px: { left: 1500, right: 50, top: 42, bottom: 35 }\n');
    assert.equal(deck(dir, ['render'], state).code, 0);
    const lint = deck(dir, ['lint'], state);
    assert.equal(lint.code, 1, 'expected findings');

    const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'lint', 'report.json'), 'utf8'));
    assert.equal(report.process, 'ok', 'a completed run that found violations is a SUCCESSFUL process');
    assert.equal(report.verdict, 'fail');
    assert.ok(report.counts.blocking > 0);
    assert.ok(validateLint(report), explain(validateLint.errors));
  } finally {
    rm(root); rm(state);
  }
});

test('A REAL FAILURE REPORT VALIDATES', () => {
  const root = tempDir('deck-schema-crash');
  const state = tempDir('deck-schema-crash-state');
  const dir = path.join(root, 'deck');
  try {
    assert.equal(deck(root, ['init', dir], state).code, 0);
    assert.equal(deck(dir, ['render'], state).code, 0);
    fs.writeFileSync(path.join(dir, 'out', 'geometry.json'), 'not json');
    assert.notEqual(deck(dir, ['lint'], state).code, 0);

    const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'lint', 'report.json'), 'utf8'));
    assert.equal(report.process, 'failed');
    assert.equal(report.verdict, 'fail');
    assert.ok(validateLint(report), explain(validateLint.errors));
  } finally {
    rm(root); rm(state);
  }
});

test('every report deck writes is parseable JSON with both axes present', () => {
  const root = tempDir('deck-schema-all');
  const state = tempDir('deck-schema-all-state');
  const dir = path.join(root, 'deck');
  try {
    assert.equal(deck(root, ['init', dir], state).code, 0);
    fillSlots(dir);
    for (const args of [['validate'], ['prompts'], ['prompts', '--single'], ['render'], ['lint'], ['export']]) {
      assert.equal(deck(dir, args, state).code, 0, `deck ${args.join(' ')}`);
    }
    const out = path.join(dir, 'out');
    // geometry.json and artifacts.json are DATA, not reports: they carry no
    // process/verdict pair and are asserted separately below.
    const DATA = new Set(['geometry.json', 'artifacts.json']);
    const reports = fs.readdirSync(out).filter((f) => f.endsWith('.json') && !DATA.has(f))
      .concat(fs.existsSync(path.join(out, 'lint')) ? ['lint/report.json'] : []);
    assert.ok(reports.length >= 5, `only found ${reports.join(', ')}`);
    for (const f of reports) {
      const r = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
      assert.equal(r.schema, 'deck.report/1', f);
      assert.ok(['ok', 'failed'].includes(r.process), `${f} process: ${r.process}`);
      assert.ok(['pass', 'fail', 'none'].includes(r.verdict), `${f} verdict: ${r.verdict}`);
      // The status file is the PROCESS axis and is a separate file.
      const statusFile = path.join(out, f.replace(/\.json$/, '-status.txt'));
      assert.ok(fs.existsSync(statusFile), `${f} has no status file`);
      assert.equal(fs.readFileSync(statusFile, 'utf8').trim(), r.process === 'ok' ? '0' : '4');
    }

    // THE ARTIFACT MANIFEST binds the delivered bytes to the render that
    // produced them, which is what lets export reject a half-published set.
    const artifacts = JSON.parse(fs.readFileSync(path.join(out, 'artifacts.json'), 'utf8'));
    assert.equal(artifacts.schema, 'deck.artifacts/1');
    assert.match(artifacts.render_fingerprint, /^[0-9a-f]{64}$/);
    for (const key of ['deck.pdf', 'geometry.json']) {
      assert.ok(key in artifacts.artifacts, `the manifest must cover ${key}`);
      assert.match(artifacts.artifacts[key], /^[0-9a-f]{64}$/);
    }
    assert.ok(Object.keys(artifacts.artifacts).some((k) => k.startsWith('png/')), 'and every page PNG');
    assert.ok(Object.keys(artifacts.artifacts).some((k) => k.startsWith('html/')), 'and every HTML file');
    assert.ok(!('artifacts.json' in artifacts.artifacts), 'it cannot contain its own hash');
  } finally {
    rm(root); rm(state);
  }
});


// ---------------------------------------------------------------------------
// T15: FRESHNESS. The render fingerprint must cover everything that changes
// a pixel, and every command must agree about whether the output is current.
// ---------------------------------------------------------------------------

function freshWorkspace() {
  const root = tempDir('fresh');
  const state = tempDir('fresh-state');
  const dir = path.join(root, 'deck');
  const run = (args, cwd = dir) => deck(cwd, args, state);
  assert.equal(run(['init', dir], root).code, 0);
  // The scaffold declares a cover-art slot and ships no picture for it, which
  // the slot-fill rule blocks on and `render --release` refuses. These tests
  // are about FRESHNESS, so they start from a deck in the state a real one is
  // in when it is delivered: slots filled.
  fillSlots(dir);
  return { root, state, dir, run, cleanup: () => { rm(root); rm(state); } };
}

test('TOGGLING page_numbers INVALIDATES THE RENDER', () => {
  // Confirmed by review: page_numbers reached buildHtml but not the
  // fingerprint, so true and false produced different HTML with identical
  // fingerprints and every freshness check accepted the stale output.
  const w = freshWorkspace();
  try {
    assert.equal(w.run(['render']).code, 0);
    assert.equal(w.run(['lint']).code, 0);
    const before = fs.readFileSync(path.join(w.dir, 'out', 'geometry.json'), 'utf8');
    const fp = JSON.parse(before).render_fingerprint;

    const deckYaml = path.join(w.dir, 'deck.yaml');
    fs.writeFileSync(deckYaml,
      fs.readFileSync(deckYaml, 'utf8').replace('page_numbers: true', 'page_numbers: false'));

    // lint must refuse: the pixels have changed.
    const l = w.run(['lint']);
    assert.notEqual(l.code, 0, 'lint must refuse geometry rendered with a different folio setting');
    assert.match(l.stdout + l.stderr, /different render/);

    // export must refuse too.
    const e = w.run(['export']);
    assert.notEqual(e.code, 0);

    // status must agree with both.
    const st = JSON.parse(w.run(['status', '--json']).stdout);
    assert.equal(st.render_is_current, false, 'status must not call the output current');

    // ...and re-rendering really does change the output.
    assert.equal(w.run(['render']).code, 0);
    const after = fs.readFileSync(path.join(w.dir, 'out', 'geometry.json'), 'utf8');
    assert.notEqual(JSON.parse(after).render_fingerprint, fp);
    assert.ok(!after.includes('"id":"page-number"') && !after.includes('"page-number"'),
      'with page_numbers off, no folio element should be measured');
  } finally {
    w.cleanup();
  }
});

test('STATUS AGREES WITH LINT AND EXPORT after a layout-only change', () => {
  // status derived rendered/released from the content digest alone and
  // reported the old lint verdict without checking which render it
  // inspected, so it said released / pass while lint and export refused.
  const w = freshWorkspace();
  try {
    assert.equal(w.run(['render']).code, 0);
    assert.equal(w.run(['approve', 'content']).code, 0);
    assert.equal(w.run(['render', '--release']).code, 0);
    assert.equal(w.run(['lint']).code, 0);

    let st = JSON.parse(w.run(['status', '--json']).stdout);
    assert.equal(st.phase, 'released');
    assert.equal(st.render_is_current, true);
    assert.equal(st.last_lint.inspected_this_render, true);

    // A theme-only edit: the words are untouched, every box moves.
    fs.appendFileSync(path.join(w.dir, 'deck.yaml'),
      '\ntheme_overrides:\n  canvas:\n    safe_margins_px: { left: 140, right: 50, top: 42, bottom: 35 }\n');

    st = JSON.parse(w.run(['status', '--json']).stdout);
    assert.equal(st.render_is_current, false, 'status must see the output is stale');
    assert.notEqual(st.phase, 'released', 'and must not still call the deck released');
    assert.equal(st.last_lint.inspected_this_render, false,
      'and must say the lint verdict is about a different render');
    assert.equal(st.approvals.content.matches, true, 'while the CONTENT approval is untouched');

    assert.notEqual(w.run(['lint']).code, 0, 'lint agrees');
    assert.notEqual(w.run(['export']).code, 0, 'export agrees');
  } finally {
    w.cleanup();
  }
});

test('MALFORMED-BUT-VALID-JSON GEOMETRY BLOCKS, it does not pass', () => {
  const w = freshWorkspace();
  try {
    assert.equal(w.run(['render']).code, 0);
    const geoFile = path.join(w.dir, 'out', 'geometry.json');
    const good = JSON.parse(fs.readFileSync(geoFile, 'utf8'));

    const cases = [
      ['no slides at all', (g) => { g.slides = []; }, /zero slides is not a pass|measured 0 slide/],
      ['a slide removed', (g) => { g.slides.pop(); }, /do not match the storyboard|measured 3 slide/],
      ['slides reordered', (g) => { g.slides.reverse(); }, /do not match the storyboard/],
      ['a slide with no elements', (g) => { g.slides[0].elements = []; }, /measured zero elements/],
      ['a missing centre coordinate', (g) => { delete g.slides[0].elements[0].rect.cx; }, /missing cx/],
      ['a non-finite coordinate', (g) => { g.slides[0].elements[0].rect.cx = null; }, /not a finite number/],
      ['a NaN-ish coordinate', (g) => { g.slides[0].elements[0].rect.cy = 'oops'; }, /not a finite number/],
      ['a missing content-region', (g) => { delete g.slides[0].regions['content-region']; }, /missing the "content-region" region/],
      ['a recorded measurement error', (g) => { g.slides[0].error = 'the canvas had zero width'; }, /records a measurement error/],
    ];

    for (const [label, mutate, expected] of cases) {
      const copy = JSON.parse(JSON.stringify(good));
      mutate(copy);
      fs.writeFileSync(geoFile, JSON.stringify(copy));
      const r = w.run(['lint']);
      assert.notEqual(r.code, 0, `${label}: lint must refuse, not pass`);
      const text = r.stdout + r.stderr;
      assert.match(text, expected, `${label}: ${text.slice(0, 220)}`);
      assert.ok(!/verdict: pass/.test(text), `${label}: a pass must never be reported`);
    }
  } finally {
    w.cleanup();
  }
});


test('A FAILED `prompts --single` REPLACES prompts-single.json, not prompts.json', () => {
  // The failure path looked the report up by COMMAND, so a failed --single
  // wrote prompts.json and left a previous prompts-single.json saying
  // pass / status 0 - a stale success for the thing that just failed.
  const w = freshWorkspace();
  try {
    assert.equal(w.run(['prompts']).code, 0);
    assert.equal(w.run(['prompts', '--single']).code, 0);
    const single = path.join(w.dir, 'out', 'prompts-single.json');
    const plain = path.join(w.dir, 'out', 'prompts.json');
    assert.equal(JSON.parse(fs.readFileSync(single, 'utf8')).verdict, 'pass');
    assert.equal(JSON.parse(fs.readFileSync(plain, 'utf8')).verdict, 'pass');

    // Break the theme's style brief so prompts fails.
    fs.appendFileSync(path.join(w.dir, 'deck.yaml'),
      '\ntheme_overrides:\n  slots:\n    style_brief_file: "../../../../../etc/hosts"\n');
    assert.notEqual(w.run(['prompts', '--single']).code, 0);

    const singleAfter = JSON.parse(fs.readFileSync(single, 'utf8'));
    assert.equal(singleAfter.process, 'failed', 'the --single report must record the failure');
    assert.equal(singleAfter.verdict, 'fail');
    assert.equal(fs.readFileSync(path.join(w.dir, 'out', 'prompts-single-status.txt'), 'utf8').trim(), '4');

    // ...and the plain prompts report is untouched: it did not run.
    assert.equal(JSON.parse(fs.readFileSync(plain, 'utf8')).verdict, 'pass');
  } finally {
    w.cleanup();
  }
});
