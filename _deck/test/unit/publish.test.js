import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { DECK_BIN, DECK_HOME, rm, tempDir, gateArgs } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const { paths } = await import('../../src/workspace.js');
const { createStage, publish, verifyArtifacts, writeArtifactManifest } = await import('../../src/publish.js');

/**
 * PUBLICATION UNDER FAILURE.
 *
 * Reproduced before the fix: injecting a failure while installing deck.pdf
 * left NEW html and png beside the OLD geometry, and destroyed the previous
 * PDF outright - the restore used the same failing operation, its error was
 * swallowed, and the backup directory was deleted in `finally`.
 *
 * Each rename step is failed in turn and the published set is checked for
 * internal consistency afterwards.
 */

const NAMES = ['html', 'png', 'deck.pdf', 'geometry.json', 'artifacts.json'];

function workspaceWith(revision) {
  const root = tempDir('pub');
  const p = paths(fs.realpathSync(root));
  fs.mkdirSync(p.out, { recursive: true });
  fs.mkdirSync(p.state, { recursive: true });
  fs.mkdirSync(path.join(p.out, 'html'), { recursive: true });
  fs.writeFileSync(path.join(p.out, 'html', 'a.html'), `${revision} HTML`);
  fs.mkdirSync(path.join(p.out, 'png'), { recursive: true });
  fs.writeFileSync(path.join(p.out, 'png', '001.png'), `${revision} PNG`);
  fs.writeFileSync(path.join(p.out, 'deck.pdf'), `${revision} PDF`);
  fs.writeFileSync(path.join(p.out, 'geometry.json'), JSON.stringify({ rev: revision }));
  writeArtifactManifest(p.out, `${revision.toLowerCase().repeat(8)}`.slice(0, 64).padEnd(64, '0'));
  return { root, p };
}

function stageRevision(p, revision) {
  const st = createStage(p);
  fs.mkdirSync(path.join(st.dir, 'html'), { recursive: true });
  fs.writeFileSync(path.join(st.dir, 'html', 'a.html'), `${revision} HTML`);
  fs.mkdirSync(path.join(st.dir, 'png'), { recursive: true });
  fs.writeFileSync(path.join(st.dir, 'png', '001.png'), `${revision} PNG`);
  fs.writeFileSync(path.join(st.dir, 'deck.pdf'), `${revision} PDF`);
  fs.writeFileSync(path.join(st.dir, 'geometry.json'), JSON.stringify({ rev: revision }));
  writeArtifactManifest(st.dir, `${revision.toLowerCase().repeat(8)}`.slice(0, 64).padEnd(64, '0'));
  return st;
}

/** Read the revision each published artifact belongs to. */
function revisionsOf(p) {
  const read = (f) => {
    try { return fs.readFileSync(path.join(p.out, f), 'utf8'); } catch { return '(absent)'; }
  };
  return {
    html: read('html/a.html').split(' ')[0],
    png: read('png/001.png').split(' ')[0],
    pdf: read('deck.pdf').split(' ')[0],
    geometry: (() => {
      try { return JSON.parse(read('geometry.json')).rev; } catch { return '(absent)'; }
    })(),
  };
}

for (const failAt of NAMES) {
  test(`a failure installing "${failAt}" leaves ONE revision, not a mixture`, () => {
    const { root, p } = workspaceWith('OLD');
    const st = stageRevision(p, 'NEW');
    const realRename = fs.renameSync;
    const target = path.join(p.out, failAt);
    // Fail only the INSTALL - the move out of the staging directory. A
    // transient failure (a full disk, an interrupted process) does not also
    // prevent the restore, and the permanently-failing case has its own test
    // below.
    fs.renameSync = (a, b) => {
      if (path.resolve(String(b)) === target && String(a).includes('.staging-')) {
        throw new Error(`INJECTED failure installing ${failAt}`);
      }
      return realRename(a, b);
    };
    let threw = null;
    try {
      publish(p, st);
    } catch (err) {
      threw = err;
    } finally {
      fs.renameSync = realRename;
    }

    try {
      assert.ok(threw, 'publication must report the failure');
      const revs = revisionsOf(p);
      const distinct = new Set(Object.values(revs));
      assert.equal(distinct.size, 1,
        `the published set mixes revisions: ${JSON.stringify(revs)}`);
      assert.equal([...distinct][0], 'OLD',
        `a failed publication must leave the PREVIOUS revision, got ${JSON.stringify(revs)}`);
      // Nothing may be destroyed.
      for (const f of ['html/a.html', 'png/001.png', 'deck.pdf', 'geometry.json']) {
        assert.ok(fs.existsSync(path.join(p.out, f)), `${f} was destroyed by a failed publication`);
      }
      // A clean rollback leaves no backup and no staging directory.
      assert.deepEqual(
        fs.readdirSync(p.out).filter((f) => f.startsWith('.replaced-') || f.startsWith('.staging-')),
        [],
        'a successful rollback must clean up after itself',
      );
      // ...and the restored set still verifies as one coherent revision.
      const fingerprint = 'old'.repeat(8).slice(0, 64).padEnd(64, '0');
      assert.deepEqual(verifyArtifacts(p, fingerprint), [],
        'the restored set must be internally consistent');
    } finally {
      rm(root);
    }
  });
}

test('when restoration itself fails, the BACKUP IS KEPT and named', () => {
  const { root, p } = workspaceWith('OLD');
  const st = stageRevision(p, 'NEW');
  const realRename = fs.renameSync;
  // Fail installing deck.pdf AND fail every restore, the worst case.
  fs.renameSync = (a, b) => {
    const to = path.resolve(String(b));
    if (to === path.join(p.out, 'deck.pdf')) throw new Error('INJECTED install failure');
    if (path.dirname(to) === p.out && String(a).includes('.replaced-')) {
      throw new Error('INJECTED restore failure');
    }
    return realRename(a, b);
  };
  let threw = null;
  try { publish(p, st); } catch (err) { threw = err; } finally { fs.renameSync = realRename; }

  try {
    assert.ok(threw);
    assert.match(threw.message, /could not be fully restored/);
    const detail = threw.details.join('\n');
    assert.match(detail, /preserved in:/);
    const kept = fs.readdirSync(p.out).filter((f) => f.startsWith('.replaced-'));
    assert.equal(kept.length, 1, 'the backup must be kept when restoration fails');
    assert.match(detail, new RegExp(kept[0]), 'and the message must name it');
    // The old bytes are still recoverable from it.
    assert.ok(fs.existsSync(path.join(p.out, kept[0], 'deck.pdf')));
    assert.equal(fs.readFileSync(path.join(p.out, kept[0], 'deck.pdf'), 'utf8'), 'OLD PDF');
  } finally {
    rm(root);
  }
});

test('a successful publication leaves one coherent revision and no leftovers', () => {
  const { root, p } = workspaceWith('OLD');
  const st = stageRevision(p, 'NEW');
  try {
    publish(p, st);
    assert.deepEqual(revisionsOf(p), { html: 'NEW', png: 'NEW', pdf: 'NEW', geometry: 'NEW' });
    assert.deepEqual(fs.readdirSync(p.out).filter((f) => f.startsWith('.replaced-') || f.startsWith('.staging-')), []);
  } finally {
    rm(root);
  }
});

test('THE ARTIFACT MANIFEST DETECTS A MIXED SET THE FINGERPRINT CANNOT', () => {
  // The point of the manifest. The fingerprint describes the INPUTS, so
  // reverting the inputs to the previous revision makes it match again while
  // the files on disk are still half one render and half another.
  const { root, p } = workspaceWith('OLD');
  const fingerprint = 'old'.repeat(8).slice(0, 64).padEnd(64, '0');
  try {
    assert.deepEqual(verifyArtifacts(p, fingerprint), [], 'the untouched set is consistent');

    // One artifact replaced by another revision's bytes.
    fs.writeFileSync(path.join(p.out, 'deck.pdf'), 'NEW PDF');
    const problems = verifyArtifacts(p, fingerprint);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /deck\.pdf has changed since it was published/);
    assert.match(problems[0], /not the ones this render produced/);
  } finally {
    rm(root);
  }
});

test('an EXTRA file left in a published directory is detected', () => {
  const { root, p } = workspaceWith('OLD');
  const fingerprint = 'old'.repeat(8).slice(0, 64).padEnd(64, '0');
  try {
    fs.writeFileSync(path.join(p.out, 'png', '999.png'), 'LEFTOVER');
    const problems = verifyArtifacts(p, fingerprint);
    assert.ok(problems.some((x) => /999\.png was not published by this render/.test(x)), JSON.stringify(problems));
  } finally {
    rm(root);
  }
});

test('a missing artifact manifest is a problem, not a pass', () => {
  const { root, p } = workspaceWith('OLD');
  try {
    fs.rmSync(path.join(p.out, 'artifacts.json'));
    const problems = verifyArtifacts(p, 'x'.repeat(64));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /is missing/);
  } finally {
    rm(root);
  }
});

test('EXPORT REJECTS A MIXED SET, including after reverting the inputs', () => {
  // End to end, through the real commands.
  const root = tempDir('pub-e2e');
  const state = tempDir('pub-e2e-state');
  const dir = path.join(root, 'd');
  const run = (args, cwd = dir) => {
    try {
      return { code: 0, out: execFileSync(DECK_BIN, gateArgs(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECK_STATE_ROOT: state } }) };
    } catch (err) { return { code: err.status ?? -1, out: (err.stdout || '') + (err.stderr || '') }; }
  };
  try {
    assert.equal(run(['init', dir], root).code, 0);
    assert.equal(run(['render']).code, 0);
    assert.equal(run(['export']).code, 0, 'the clean set exports');

    // Revision B of the PDF only, with the inputs left exactly as they were -
    // so the render fingerprint still matches and only the BYTES differ.
    const pdf = path.join(dir, 'out', 'deck.pdf');
    fs.writeFileSync(pdf, Buffer.concat([fs.readFileSync(pdf), Buffer.from('TAMPERED')]));

    const e = run(['export']);
    assert.notEqual(e.code, 0, 'export must reject a set whose bytes are not the ones rendered');
    assert.match(e.out, /deck\.pdf has changed since it was published/);

    // lint must refuse it too: its verdict would be about different output.
    const l = run(['lint']);
    assert.notEqual(l.code, 0);
    assert.match(l.out, /does not match the render that produced it/);
  } finally {
    rm(root); rm(state);
  }
});
