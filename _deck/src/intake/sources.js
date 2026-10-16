import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../schema.js';
import { DeckError, EXIT } from '../util/fail.js';
import { assertInside, sha256 } from '../util/fs.js';
import { plainTexts, summariseRaw } from './notion.js';

/**
 * THE SOURCE MANIFEST, AND WHY A PARTIAL FETCH BLOCKS.
 *
 * An agenda built on half the minutes looks exactly like an agenda built on
 * all of them. Nobody in the meeting can tell, and the agent that built it
 * cannot tell either - it only ever saw the half it got. So the completeness
 * of a retrieval is recorded as a fact at fetch time and checked as a gate,
 * rather than being something the agent is trusted to mention.
 *
 * WAYS A FETCH IS PARTIAL, and any one of them blocks:
 *
 *   complete: false        the agent knows it did not finish
 *   pagination.has_more    a Notion cursor was left unfollowed
 *   missing[]              a named hole - a child page that errored, a database
 *                          the token cannot read
 *   THE SAVED RESPONSE     an unfollowed cursor, or a block reporting
 *                          has_children whose children were never listed,
 *                          read out of the bytes on disk
 *
 * THE LAST ONE IS THE IMPORTANT ONE. The first three are all written by the
 * agent, and a gate that reads only those is reading a declaration and
 * calling it evidence: an entry with complete:true, pagination:null and a
 * raw_file path that did not exist passed cleanly, and `record-source`
 * emitted exactly that shape. The saved response is now parsed and the
 * declared pagination and block count are checked AGAINST it, so the agent
 * cannot claim a complete fetch it did not make.
 *
 * Source files are IMMUTABLE once written. The gate records the sha256 of
 * every text file the first time it sees it and refuses a changed one: a
 * ledger quote is verified against this text, so rewriting the source after
 * extraction would retroactively validate a quote nobody could have made.
 */

/** @param {import('../workspace.js').Paths} p */
export function manifestPath(p) {
  return path.join(p.sources, 'manifest.json');
}

/** @param {import('../workspace.js').Paths} p */
export function sealPath(p) {
  return path.join(p.state, 'source-seal.json');
}

/**
 * @param {import('../workspace.js').Paths} p
 * @returns {any | null}
 */
export function readManifest(p) {
  const file = manifestPath(p);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new DeckError('sources/manifest.json is not valid JSON', EXIT.PROCESS_FAILED, [String(err)]);
  }
  const errors = validate('sources.schema.json', parsed, `${file}: `);
  if (errors.length > 0) {
    throw new DeckError("sources/manifest.json does not match deck's source-manifest schema", EXIT.VERDICT_FAILED, errors);
  }
  return parsed;
}

/**
 * Read one source's flattened text, refusing a path that escapes the deck.
 * @param {import('../workspace.js').Paths} p
 * @param {any} source
 * @returns {string}
 */
export function readSourceText(p, source) {
  const file = path.resolve(p.root, source.text_file);
  // The manifest is written by an agent, so its paths are untrusted input.
  assertInside(file, p.root, `source "${source.id}" text_file`);
  if (!fs.existsSync(file)) {
    throw new DeckError(`source "${source.id}" names a text file that does not exist`, EXIT.PROCESS_FAILED, [
      `text_file: ${source.text_file}`,
      'Every verbatim check runs against this file, so it cannot be skipped.',
    ]);
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * @param {import('../workspace.js').Paths} p
 * @returns {{id: string, text: string}[]}
 */
export function loadSourceTexts(p) {
  const manifest = readManifest(p);
  if (!manifest) return [];
  return manifest.sources.map((s) => ({ id: s.id, text: readSourceText(p, s) }));
}

/**
 * @typedef {object} SourceProblem
 * @property {string} source_id
 * @property {string} kind
 * @property {string} message
 */

/**
 * @param {import('../workspace.js').Paths} p
 * @returns {{manifest: any | null, problems: SourceProblem[], complete: boolean, sources: any[]}}
 */
export function checkSources(p) {
  /** @type {SourceProblem[]} */
  const problems = [];
  const manifest = readManifest(p);
  if (!manifest) {
    return {
      manifest: null,
      complete: false,
      sources: [],
      problems: [{
        source_id: '(none)',
        kind: 'no-manifest',
        message: 'no sources/manifest.json: nothing records what this deck was built from',
      }],
    };
  }

  const seen = new Set();
  for (const s of manifest.sources) {
    if (seen.has(s.id)) {
      problems.push({ source_id: s.id, kind: 'duplicate-id', message: `source id "${s.id}" appears twice` });
    }
    seen.add(s.id);

    if (s.complete !== true) {
      problems.push({
        source_id: s.id,
        kind: 'incomplete',
        message: `source "${s.id}" records complete: false - the retrieval is known to be partial`,
      });
    }
    if (s.pagination && s.pagination.has_more === true) {
      problems.push({
        source_id: s.id,
        kind: 'pagination-unfinished',
        message: `source "${s.id}" left a Notion cursor unfollowed (pagination.has_more is true after ${s.pagination.requests} request(s))`,
      });
    }
    for (const m of s.missing || []) {
      problems.push({
        source_id: s.id,
        kind: 'missing-content',
        message: `source "${s.id}" is missing ${m.what}: ${m.why}`,
      });
    }
    // Present and readable, or every verbatim check below is vacuous.
    try {
      const text = readSourceText(p, s);
      if (!text.trim()) {
        problems.push({
          source_id: s.id,
          kind: 'empty-text',
          message: `source "${s.id}" has an empty text file, so nothing can be quoted from it`,
        });
      }
    } catch (err) {
      problems.push({
        source_id: s.id,
        kind: 'unreadable',
        message: err instanceof DeckError ? err.message : String(err),
      });
    }
    if (s.kind === 'notion') {
      for (const problem of checkNotionEvidence(p, s)) problems.push(problem);
    }
  }

  return { manifest, problems, complete: problems.length === 0, sources: manifest.sources };
}

/**
 * THE RETRIEVAL EVIDENCE, read off the disk.
 *
 * Everything here is derived from the saved response and then compared with
 * what the manifest claims. A disagreement is reported as a disagreement
 * rather than resolved in either direction: the point is that the two should
 * not differ, and if they do, nobody should be guessing which to trust.
 *
 * @param {import('../workspace.js').Paths} p
 * @param {any} s
 * @returns {SourceProblem[]}
 */
function checkNotionEvidence(p, s) {
  /** @type {SourceProblem[]} */
  const problems = [];
  const at = (kind, message) => problems.push({ source_id: s.id, kind, message });

  if (!s.raw_file) {
    at('no-raw', `source "${s.id}" came from Notion but kept no raw response, so what the API actually returned is unanswerable`);
    return problems;
  }

  let file;
  try {
    file = path.resolve(p.root, s.raw_file);
    assertInside(file, p.root, `source "${s.id}" raw_file`);
  } catch (err) {
    at('raw-outside', err instanceof DeckError ? err.message : String(err));
    return problems;
  }
  // PRESENT ON DISK. The old check was `!s.raw_file`, which a path to a
  // nonexistent file satisfies perfectly.
  if (!fs.existsSync(file)) {
    at('raw-missing', `source "${s.id}" names a raw response at ${s.raw_file} that does not exist. The retrieval cannot be verified, so it is not accepted.`);
    return problems;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    at('raw-unparseable', `source "${s.id}" has a raw response that is not valid JSON: ${String(err)}`);
    return problems;
  }

  const summary = summariseRaw(raw);
  for (const problem of summary.problems) at('raw-incomplete', `source "${s.id}": ${problem}`);

  if (summary.requests === 0) {
    at('raw-not-a-response', `source "${s.id}" has a saved response that is neither a fetched Notion page (metadata + text) nor a block-children list, so no retrieval is recorded in it`);
    return problems;
  }
  if (summary.unfinished) {
    at('pagination-unfinished', `source "${s.id}" has a saved response that left a Notion cursor unfollowed. The bytes say the fetch was not finished, whatever the manifest records.`);
  }
  // A FETCHED PAGE HAS NO BLOCKS, and that is not a defect: notion-fetch
  // returns the page already flattened. Only a block-list retrieval is
  // expected to carry blocks.
  if (summary.blocks === 0 && summary.pages === 0) {
    at('raw-no-blocks', `source "${s.id}" has a saved response containing neither blocks nor page text, so there is nothing it could have been flattened from`);
  }

  // THE DECLARED NUMBERS, CHECKED. A manifest that disagrees with its own
  // evidence is the shape of a hand-edited pass.
  if (s.pagination === null || s.pagination === undefined) {
    // AN ABSENT FIELD IS NOT MISSING EVIDENCE.
    //
    // The bytes already answered the question: the chain holds N requests and
    // no cursor was left unfollowed, both checked above. The manifest field is
    // a convenience for a reader, not the proof - so a source recorded by an
    // older deck, which wrote pagination:null and asked the agent to fill it
    // in, is not blocked for a formality while its actual evidence is sound.
    // What IS refused, above, is a raw_file that does not exist: that is
    // missing evidence, and it was the real hole here.
    //
    // Nothing is inferred in the agent's favour. If the saved response showed
    // an unfollowed cursor, the block has already been recorded.
  } else {
    if (s.pagination.requests !== summary.requests) {
      at('pagination-disagrees', `source "${s.id}" declares ${s.pagination.requests} request(s) but its saved response holds ${summary.requests}`);
    }
    if (s.pagination.has_more === true) {
      at('pagination-unfinished', `source "${s.id}" declares pagination.has_more true after ${s.pagination.requests} request(s), so a cursor was left unfollowed`);
    }
  }
  if (summary.pages === 0 && Number.isFinite(s.block_count) && s.block_count !== summary.blocks) {
    at('block-count-disagrees', `source "${s.id}" declares ${s.block_count} block(s) but its saved response holds ${summary.blocks}`);
  }

  // THE TEXT FILE MUST BE ABOUT THESE BLOCKS. Not a faithfulness check - the
  // verbatim gates do that - but a flattening that shares no wording at all
  // with the response it claims to come from is a text file about something
  // else, and every quote verified against it would be meaningless.
  const texts = plainTexts(raw).map((t) => t.trim()).filter((t) => t.length >= 4);
  if (texts.length > 0) {
    let flat = '';
    try {
      flat = readSourceText(p, s).replace(/\s+/g, ' ');
    } catch {
      flat = '';
    }
    const present = texts.filter((t) => flat.includes(t.replace(/\s+/g, ' ')));
    if (present.length === 0) {
      at('text-unrelated', `source "${s.id}" has a text file that contains none of the ${texts.length} text run(s) in its saved response, so it is not a flattening of it`);
    }
  }
  return problems;
}

/**
 * SEAL the sources, so a later edit cannot retroactively validate a quote.
 *
 * Called by the ledger gate once the sources check passes. The seal is a
 * record of the bytes the ledger was verified against; the next run compares
 * and refuses a change rather than re-verifying against new text.
 *
 * @param {import('../workspace.js').Paths} p
 * @returns {{changed: {id: string, message: string}[]}}
 */
export function sealSources(p) {
  const { sources } = checkSources(p);
  const file = sealPath(p);
  /** @type {any} */
  let existing = null;
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      existing = null;
    }
  }
  const previous = new Map(((existing && existing.sources) || []).map((s) => [s.id, s]));
  /** @type {{id: string, message: string}[]} */
  const changed = [];
  const now = sources.map((s) => {
    const text = (() => {
      try {
        return readSourceText(p, s);
      } catch {
        return null;
      }
    })();
    const sha = text === null ? null : sha256(text);
    const before = previous.get(s.id);
    if (before && sha && before.sha256 && before.sha256 !== sha) {
      changed.push({
        id: s.id,
        message: `source "${s.id}" has changed since the ledger was verified against it (${before.sha256.slice(0, 12)} -> ${sha.slice(0, 12)})`,
      });
    }
    return {
      id: s.id,
      text_file: s.text_file,
      sha256: sha,
      retrieved_at: s.retrieved_at,
      sealed_at: before ? before.sealed_at : new Date().toISOString(),
    };
  });
  if (changed.length === 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schema: 'deck.source-seal/1', sources: now }, null, 2)}\n`);
  }
  return { changed };
}
