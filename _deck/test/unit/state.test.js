import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DECK_HOME, rm, tempDir } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const { PHASE_ORDER, findWorkspace, paths, readState, setPhase, stateRoot, transitionAllowed, writeState } = await import('../../src/workspace.js');
const { writeReport } = await import('../../src/util/report.js');
const { readJson } = await import('../../src/util/fs.js');

test('the state root honours DECK_STATE_ROOT, then XDG_STATE_HOME', () => {
  const saved = { d: process.env.DECK_STATE_ROOT, x: process.env.XDG_STATE_HOME };
  try {
    process.env.DECK_STATE_ROOT = '/tmp/explicit root';
    assert.equal(stateRoot(), '/tmp/explicit root');
    delete process.env.DECK_STATE_ROOT;
    process.env.XDG_STATE_HOME = '/tmp/xdg state';
    assert.equal(stateRoot(), path.join('/tmp/xdg state', 'deck'));
  } finally {
    if (saved.d === undefined) delete process.env.DECK_STATE_ROOT; else process.env.DECK_STATE_ROOT = saved.d;
    if (saved.x === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved.x;
  }
});

test('a workspace is found by walking up, so commands work from a subdirectory', () => {
  const dir = tempDir('deck-ws');
  try {
    fs.writeFileSync(path.join(dir, 'deck.yaml'), 'x: 1\n');
    const deep = path.join(dir, 'out', 'png');
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(fs.realpathSync(findWorkspace(deep)), fs.realpathSync(dir));
  } finally {
    rm(dir);
  }
});

test('findWorkspace returns null outside any deck rather than guessing', () => {
  const dir = tempDir('deck-nows');
  try {
    // Walking up from a temp dir could in principle hit a deck.yaml higher up;
    // asserting on a path with none above it would be flaky, so this asserts
    // the contract shape instead.
    const found = findWorkspace(dir);
    assert.ok(found === null || fs.existsSync(path.join(found, 'deck.yaml')));
  } finally {
    rm(dir);
  }
});

test('per-deck state lives in <deck>/.deck so it travels with the deck', () => {
  const p = paths('/decks/mine');
  assert.equal(p.state, '/decks/mine/.deck');
  assert.equal(p.approvals, '/decks/mine/.deck/approvals');
  assert.ok(!p.state.startsWith(stateRoot()));
});

test('legal phase transitions', () => {
  assert.equal(transitionAllowed('drafting', 'agenda-approved'), true);
  assert.equal(transitionAllowed('drafting', 'content-approved'), true);
  assert.equal(transitionAllowed('content-approved', 'rendered'), true);
  assert.equal(transitionAllowed('rendered', 'released'), true);
  // Going back is always legal: editing a deck after approving it is normal,
  // and the approval digest - not the phase - is what guards a release.
  assert.equal(transitionAllowed('released', 'drafting'), true);
});

test('illegal phase transitions are refused BY NAME', () => {
  assert.equal(transitionAllowed('drafting', 'released'), false);
  assert.equal(transitionAllowed('drafting', 'rendered'), false);
  assert.equal(transitionAllowed('agenda-approved', 'released'), false);
  assert.equal(transitionAllowed('nonsense', 'drafting'), false);
});

test('setPhase refuses an illegal transition and says what IS allowed', () => {
  const dir = tempDir('deck-phase');
  try {
    const p = paths(dir);
    fs.mkdirSync(p.state, { recursive: true });
    writeState(p, { ...readState(p), phase: 'drafting' });
    assert.throws(() => setPhase(p, 'released'), (err) => {
      assert.match(err.message, /illegal phase transition: drafting -> released/);
      assert.match(err.details.join(' '), /Allowed from drafting/);
      return true;
    });
    assert.equal(readState(p).phase, 'drafting', 'a refused transition must not be written');
  } finally {
    rm(dir);
  }
});

test('every phase in PHASE_ORDER has a transition table entry', () => {
  for (const phase of PHASE_ORDER) {
    assert.equal(transitionAllowed(phase, phase), true, `${phase} should allow itself`);
  }
});

test('a report separates PROCESS status from SEMANTIC verdict', () => {
  const dir = tempDir('deck-report');
  try {
    const w = writeReport({
      dir, name: 'lint', command: 'lint', process: 'ok', verdict: 'fail',
      summary: '3 blocking findings', body: { counts: { blocking: 3 } },
    });
    const json = readJson(w.json);
    // A completed run that found violations: the PROCESS succeeded.
    assert.equal(json.process, 'ok');
    assert.equal(json.verdict, 'fail');
    assert.equal(fs.readFileSync(w.status, 'utf8').trim(), '0');
    assert.equal(json.summary, '3 blocking findings');
  } finally {
    rm(dir);
  }
});

test('A PROCESS FAILURE THAT PRODUCED PASS-SHAPED OUTPUT CANNOT PUBLISH A PASS', () => {
  // squad's hard-won rule: a lens can write pass-shaped JSON and still exit
  // non-zero, and anything reading only the verdict saw a clean pass for a run
  // that never completed. writeReport forces the verdict rather than trusting
  // the caller, so this is the last line of defence and it is tested.
  const dir = tempDir('deck-report-fail');
  try {
    const w = writeReport({
      dir, name: 'lint', command: 'lint',
      process: 'failed',
      verdict: 'pass',            // the caller claims a pass...
      summary: 'everything looked fine',
      body: { counts: { blocking: 0 } },
    });
    const json = readJson(w.json);
    assert.equal(json.process, 'failed');
    assert.equal(json.verdict, 'fail', 'a crashed run has no verdict and must never publish "pass"');
    assert.equal(w.verdict, 'fail');
    assert.equal(fs.readFileSync(w.status, 'utf8').trim(), '4');
    assert.match(json.summary, /FAILED to complete/);
    assert.match(json.summary, /NOT because it inspected anything/);
  } finally {
    rm(dir);
  }
});

test('the status file holds only the process status, never the verdict', () => {
  const dir = tempDir('deck-report-status');
  try {
    const a = writeReport({ dir, name: 'a', command: 'lint', process: 'ok', verdict: 'pass', summary: 's' });
    const b = writeReport({ dir, name: 'b', command: 'lint', process: 'ok', verdict: 'fail', summary: 's' });
    // Same process status for a passing and a failing verdict: the two axes
    // are independent and the file proves it.
    assert.equal(fs.readFileSync(a.status, 'utf8'), fs.readFileSync(b.status, 'utf8'));
    assert.equal(fs.readFileSync(a.status, 'utf8').trim(), '0');
  } finally {
    rm(dir);
  }
});

test('reports are written atomically, leaving no .tmp- files behind', () => {
  const dir = tempDir('deck-report-atomic');
  try {
    writeReport({ dir, name: 'r', command: 'lint', process: 'ok', verdict: 'pass', summary: 's', humanText: 'hi' });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['r-status.txt', 'r.json', 'r.txt']);
  } finally {
    rm(dir);
  }
});
