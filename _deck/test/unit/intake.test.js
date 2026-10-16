import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { DECK_HOME, rm, tempDir } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;

const { checkSources, sealSources } = await import('../../src/intake/sources.js');
const { checkLedger, mustBeAccountedFor } = await import('../../src/intake/ledger.js');
const { checkAgenda } = await import('../../src/intake/agenda.js');
const { checkFidelity } = await import('../../src/intake/fidelity.js');
const { copySheet } = await import('../../src/intake/copy.js');
const { numericTokens, dateTokens, sourceIndex } = await import('../../src/intake/text.js');
const { paths } = await import('../../src/workspace.js');
const { prerequisitesFor } = await import('../../src/intake/prerequisites.js');

/**
 * THE INTAKE GATES.
 *
 * These are the checks that stand between the PO and a deck built on material
 * nobody verified: a partial fetch, a paraphrase presented as a quotation, an
 * unresolved decision quietly dropped from the agenda, a number that appears
 * on a slide and nowhere in the minutes.
 *
 * Every fixture here is a MOCKED Notion response or a flattened page. Nothing
 * in this file reaches the network, and the gates themselves never fetch -
 * the agent fetches in its own session and saves what it got, and these check
 * what is on disk. That split is what makes them testable at all.
 */

/** @type {string[]} */
const made = [];
after(() => { for (const d of made) rm(d); });

/**
 * A NOTION RESPONSE CHAIN FOR A FLATTENED TEXT.
 *
 * The fixtures used to write `{"object":"page"}` as the raw file, which is
 * why B2 survived: the gate only looked at whether `raw_file` was a non-empty
 * string, so a placeholder satisfied it and the tests never exercised the
 * evidence at all. These are the real shapes - a block-children list
 * response, blocks carrying rich_text, and one response per request - because
 * the gate now parses them.
 *
 * @param {string} id
 * @param {string} text   the flattened text, one block per line
 * @param {object} [opts]
 * @param {boolean} [opts.hasMore]    leave a pagination cursor unfollowed
 * @param {boolean} [opts.toggle]     hide the last line inside a toggle whose
 *                                    children are fetched in a second request
 * @param {boolean} [opts.lostToggle] the same toggle, children NEVER fetched
 * @param {boolean} [opts.paginated]  split the blocks over two requests
 */
function notionChain(id, text, opts = {}) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const block = (n, line, extra = {}) => ({
    object: 'block',
    id: `${id}-b${n}`,
    type: 'paragraph',
    has_children: false,
    paragraph: { rich_text: [{ type: 'text', plain_text: line }] },
    ...extra,
  });
  const list = (results, extra = {}) => ({
    object: 'list', results, next_cursor: null, has_more: false, type: 'block', ...extra,
  });

  if (opts.toggle || opts.lostToggle) {
    const head = lines.slice(0, -1).map((l, i) => block(i + 1, l));
    const toggleBlock = {
      object: 'block',
      id: `${id}-toggle`,
      type: 'toggle',
      has_children: true,
      toggle: { rich_text: [{ type: 'text', plain_text: '詳細' }] },
    };
    const chain = [list([...head, toggleBlock])];
    if (!opts.lostToggle) {
      chain.push(list([block(99, lines[lines.length - 1])], { block_id: `${id}-toggle` }));
    }
    return chain;
  }
  if (opts.paginated) {
    const half = Math.ceil(lines.length / 2);
    return [
      list(lines.slice(0, half).map((l, i) => block(i + 1, l)), { has_more: true, next_cursor: 'cursor-1' }),
      list(lines.slice(half).map((l, i) => block(half + i + 1, l)), { start_cursor: 'cursor-1' }),
    ];
  }
  return [list(lines.map((l, i) => block(i + 1, l)), opts.hasMore ? { has_more: true, next_cursor: 'cursor-1' } : {})];
}

/**
 * A deck workspace with sources, a ledger and an agenda, as the agent writes
 * them. `raw` overrides one source's saved response, for the tests that are
 * about the evidence rather than the words.
 */
function deck({
  sources = {}, manifest = null, ledger = null, agenda = null, storyboard = null, raw = {}, chainOpts = {},
} = {}) {
  const root = tempDir('deck-intake テスト');
  made.push(root);
  const p = paths(root);
  fs.mkdirSync(p.sources, { recursive: true });
  fs.mkdirSync(p.state, { recursive: true });

  const entries = Object.entries(sources);
  /** @type {Record<string, any>} */
  const chains = {};
  for (const [id, text] of entries) {
    fs.writeFileSync(path.join(p.sources, `${id}.txt`), text);
    const chain = raw[id] !== undefined ? raw[id] : notionChain(id, text, chainOpts[id] || {});
    chains[id] = chain;
    fs.writeFileSync(path.join(p.sources, `${id}.json`), JSON.stringify(chain, null, 2));
  }
  const derived = (id) => {
    const chain = chains[id];
    const blocks = JSON.stringify(chain).match(/"object":"block"/g);
    return {
      blocks: blocks ? blocks.length : 0,
      requests: Array.isArray(chain) ? chain.length : 1,
    };
  };
  const m = manifest === false ? null : manifest || {
    schema: 'deck.sources/1',
    sources: entries.map(([id]) => ({
      id,
      kind: 'notion',
      ref: `https://www.notion.so/${id}`,
      retrieved_at: '2026-10-07T05:00:00.000Z',
      raw_file: `sources/${id}.json`,
      text_file: `sources/${id}.txt`,
      complete: true,
      block_count: derived(id).blocks,
      page_ids: [`${id}-page`],
      block_ids: [],
      pagination: { requests: derived(id).requests, has_more: false, next_cursor: null },
      missing: [],
      notes: null,
    })),
  };
  if (m) fs.writeFileSync(path.join(p.sources, 'manifest.json'), JSON.stringify(m, null, 2));
  if (ledger) fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify(ledger, null, 2));
  if (agenda) fs.writeFileSync(path.join(root, 'agenda.json'), JSON.stringify(agenda, null, 2));
  if (storyboard) fs.writeFileSync(p.storyboard, JSON.stringify(storyboard));
  return { root, p };
}

/**
 * MOCK NOTION MINUTES, flattened as the agent is told to flatten them.
 *
 * Deliberately contains everything the real thing does and the happy path
 * does not: nested content under a toggle, a table, two CONFLICTING figures
 * for the same month, a decision left open, an action still pending, and one
 * action the source really does mark finished.
 */
const MINUTES = `# 第3回定例
日時: 2026年10月7日 14:00-15:00

## 決定事項
- 宿泊パッケージの価格は 18,000円 で確定とする。

## 未決
- 送客チャネルをOTA中心にするか自社サイト中心にするかは次回までに決める。
- 予約システムの刷新は費用が読めないため判断を保留。

## 数値
- 9月の予約件数は 412件 だった。
- なお速報では9月は 408件 との報告もあり、数字の確定待ち。
- 稼働率は 62% 。

## アクション
- 田中: OTA3社の手数料を比較して次回持ち込む。期限は10月21日。
- 鈴木: 9月の予約件数を確定させる。（完了）

## 表
| 項目 | 9月 |
| 予約件数 | 412件 |
`;

/** A ledger over MINUTES whose every quote is really in it. */
function goodLedger() {
  return {
    schema: 'deck.ledger/1',
    extracted_at: '2026-10-07T06:00:00.000Z',
    entries: [
      {
        id: 'd-01', kind: 'decision', source_id: 'mtg', status: 'resolved',
        quote: '宿泊パッケージの価格は 18,000円 で確定とする。',
      },
      {
        id: 'd-02', kind: 'decision', source_id: 'mtg', status: 'unresolved',
        quote: '送客チャネルをOTA中心にするか自社サイト中心にするかは次回までに決める。',
      },
      {
        id: 'n-01', kind: 'number', source_id: 'mtg', status: null,
        quote: '9月の予約件数は 412件 だった。', value: '412', unit: '件', period: '2026年9月',
        conflicts_with: ['n-02'],
      },
      {
        id: 'n-02', kind: 'number', source_id: 'mtg', status: null,
        quote: '速報では9月は 408件 との報告もあり', value: '408', unit: '件', period: '2026年9月速報',
        conflicts_with: ['n-01'],
      },
      {
        id: 'd-03', kind: 'decision', source_id: 'mtg', status: 'unresolved',
        quote: '予約システムの刷新は費用が読めないため判断を保留。',
      },
      {
        id: 'a-01', kind: 'action', source_id: 'mtg', status: 'pending', owner: '田中', due: '10月21日',
        quote: '田中: OTA3社の手数料を比較して次回持ち込む。期限は10月21日。',
      },
      {
        id: 'a-02', kind: 'action', source_id: 'mtg', status: 'done', owner: '鈴木',
        quote: '鈴木: 9月の予約件数を確定させる。（完了）',
      },
    ],
  };
}

function goodAgenda() {
  return {
    schema: 'deck.agenda/1',
    meeting: { name: '第4回定例', when: '来週火曜', purpose: '送客チャネルを決める', audience: '経営会議' },
    items: [
      {
        id: 'i-01', heading: '送客チャネルの方針', why: '前回持ち越しで、ここが決まらないと見積もりも動かない',
        wants: 'decision', ledger_refs: ['d-02', 'a-01'],
      },
      {
        id: 'i-02', heading: '9月実績の確定', why: '速報と確定で件数が違うので前提を揃えたい',
        wants: 'agreement', ledger_refs: ['n-01', 'n-02'],
      },
    ],
    excluded: [{ ledger_refs: ['d-03'], reason: '費用が読めない段階なので手数料比較が出てから' }],
  };
}

// ---------------------------------------------------------------- text tokens

test('a number is load-bearing when it has two digits OR a unit', () => {
  // The threshold exists so the gate does not fire on the agent's own prose.
  // 「3つの論点」 is a sentence it wrote; 「3件」 is a claim about the world.
  const t = numericTokens('3つの論点、3件の指摘、42人、1,234円');
  assert.equal(t.find((x) => x.raw === '3' && x.unit === '').loadBearing, false,
    'a bare single digit is the agent writing, and must not need a source');
  assert.equal(t.find((x) => x.raw === '3' && x.unit === '件').loadBearing, true,
    'a single digit WITH a unit is a claim and must trace');
  assert.equal(t.find((x) => x.raw === '42').loadBearing, true);
  assert.equal(t.find((x) => x.raw === '1,234').core, '1234',
    'separators are stripped from the core, so a reformat is not a fabrication');
});

test('full-width digits are the same number as half-width', () => {
  // Two keyboards, one number. Normalised for COMPARISON only.
  assert.equal(numericTokens('４２件')[0].core, '42');
  assert.ok(sourceIndex('予約は４２件').hasNumber('42'));
});

test('a date is matched as a whole FORM, not as its digits', () => {
  // A source containing 10件 and 14人 would otherwise vouch for 10月14日.
  const i = sourceIndex('10件の指摘と14人の参加者');
  assert.equal(i.hasDate('10-14'), false,
    'digits that happen to appear separately must not vouch for a date');
  assert.ok(sourceIndex('次回は10月14日').hasDate('10-14'));
  assert.deepEqual(dateTokens('2026/3/1').map((d) => d.normal), ['2026-3-1'],
    'slashed dates normalise to the same form as 年月日');
});

test('a quote matches across a line break, because Notion keeps the typist\'s breaks', () => {
  const i = sourceIndex('価格は\n18,000円 で\n確定とする。');
  assert.ok(i.hasQuote('価格は 18,000円 で 確定とする。'));
  assert.equal(i.hasQuote('価格は 19,000円 で確定とする。'), false,
    'only whitespace is normalised; a changed character is a changed quote');
});

// -------------------------------------------------------------------- sources

test('a COMPLETE fetch passes', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  assert.deepEqual(checkSources(p).problems, []);
});

test('A PARTIAL FETCH BLOCKS - complete: false', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].complete = false;
  fs.writeFileSync(f, JSON.stringify(m));
  const { problems, complete } = checkSources(p);
  assert.equal(complete, false);
  assert.ok(problems.some((x) => x.kind === 'incomplete'), JSON.stringify(problems));
});

test('A PARTIAL FETCH BLOCKS - an unfollowed pagination cursor, even when complete says true', () => {
  // Checked SEPARATELY from `complete` on purpose: has_more comes straight
  // from the API, so it catches the case where the agent believed it had
  // finished and the API says otherwise. This is the one a prompt cannot fix.
  const { p } = deck({ sources: { mtg: MINUTES } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].complete = true;
  m.sources[0].pagination = { requests: 1, has_more: true, next_cursor: 'abc' };
  fs.writeFileSync(f, JSON.stringify(m));
  const { problems } = checkSources(p);
  assert.ok(problems.some((x) => x.kind === 'pagination-unfinished'), JSON.stringify(problems));
});

test('A PARTIAL FETCH BLOCKS - a named missing piece', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].missing = [{ what: '子ページ「見積もり」', why: 'トークンに閲覧権限がない', id: 'xyz' }];
  fs.writeFileSync(f, JSON.stringify(m));
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'missing-content'));
});

test('no manifest at all blocks, rather than reading as nothing to check', () => {
  const { p } = deck({ sources: {}, manifest: false });
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'no-manifest'));
});

test('an empty source text blocks, because every quote would pass vacuously', () => {
  const { p } = deck({ sources: { mtg: '   \n  ' } });
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'empty-text'));
});

test('a text_file pointing outside the deck is refused', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].text_file = '../../../../etc/passwd';
  fs.writeFileSync(f, JSON.stringify(m));
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'unreadable'));
});

test('a Notion source that kept no raw response is reported', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].raw_file = null;
  fs.writeFileSync(f, JSON.stringify(m));
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'no-raw'));
});

// ------------------------------------------------- the retrieval EVIDENCE
//
// These are the regression tests for a false pass: the gate used to check
// `pagination.has_more` and `block_count` - both written by the agent - and,
// for the response itself, only whether `raw_file` was a non-empty string. An
// entry with complete:true, pagination:null and a path to a file that did not
// exist passed cleanly, and `record-source` emitted exactly that shape.

test('A RAW FILE THAT DOES NOT EXIST IS NOT EVIDENCE', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].raw_file = 'sources/never-saved.json';
  fs.writeFileSync(f, JSON.stringify(m));
  const { problems } = checkSources(p);
  assert.ok(problems.some((x) => x.kind === 'raw-missing'), JSON.stringify(problems));
});

test('THE EXACT SHAPE record-source USED TO EMIT, with its evidence intact, PASSES', () => {
  // complete:true, pagination:null, block_count:null is what the old helper
  // wrote. It is not blocked for the missing FIELDS: the saved response
  // already answers the question the fields were asking, and that is the
  // whole point of checking the bytes instead. A source recorded by an older
  // deck is therefore not stranded mid-run.
  const { p } = deck({ sources: { mtg: MINUTES } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].complete = true;
  m.sources[0].pagination = null;
  m.sources[0].block_count = null;
  fs.writeFileSync(f, JSON.stringify(m));
  assert.deepEqual(checkSources(p).problems, [], JSON.stringify(checkSources(p).problems));
});

test('THE SAME SHAPE WITH NO SAVED RESPONSE IS REFUSED - that was the false pass', () => {
  // complete:true, pagination:null AND a raw_file path that does not exist.
  // Before this, zero problems: the gate checked whether the field was a
  // non-empty string, never whether the file was there.
  const { p } = deck({ sources: { mtg: MINUTES } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].complete = true;
  m.sources[0].pagination = null;
  m.sources[0].block_count = null;
  m.sources[0].raw_file = 'sources/never-saved.json';
  fs.writeFileSync(f, JSON.stringify(m));
  const kinds = checkSources(p).problems.map((x) => x.kind);
  assert.ok(kinds.includes('raw-missing'), JSON.stringify(kinds));
});

test('and the same shape whose BYTES show an unfollowed cursor is refused', () => {
  // The manifest declares nothing at all, so only the saved response can
  // answer - and it says the fetch did not finish.
  const { p } = deck({ sources: { mtg: MINUTES }, chainOpts: { mtg: { hasMore: true } } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].pagination = null;
  m.sources[0].block_count = null;
  fs.writeFileSync(f, JSON.stringify(m));
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'pagination-unfinished'));
});

test('a raw response that is not JSON, or holds no list response, is refused', () => {
  const bad = deck({ sources: { mtg: MINUTES }, raw: { mtg: { object: 'page', id: 'p1' } } });
  assert.ok(checkSources(bad.p).problems.some((x) => x.kind === 'raw-not-a-response'));

  const { p } = deck({ sources: { mtg: MINUTES } });
  fs.writeFileSync(path.join(p.sources, 'mtg.json'), 'not json at all');
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'raw-unparseable'));
});

test('AN UNFOLLOWED CURSOR IN THE BYTES BLOCKS, whatever the manifest says', () => {
  // The manifest is written to agree with itself: has_more false, the request
  // count right. The saved response says otherwise, and it wins.
  const { p } = deck({ sources: { mtg: MINUTES }, chainOpts: { mtg: { hasMore: true } } });
  const problems = checkSources(p).problems;
  assert.ok(problems.some((x) => x.kind === 'pagination-unfinished'), JSON.stringify(problems));
});

test('A PAGINATION CHAIN THAT WAS FOLLOWED passes', () => {
  // Two responses, the second carrying the cursor the first handed out. This
  // is the shape a correct multi-request fetch leaves behind, and it must not
  // be mistaken for an unfinished one.
  const { p } = deck({ sources: { mtg: MINUTES }, chainOpts: { mtg: { paginated: true } } });
  assert.deepEqual(checkSources(p).problems, [], JSON.stringify(checkSources(p).problems));
});

test('A TOGGLE WHOSE CHILDREN WERE NEVER READ BLOCKS', () => {
  // The most common way a Notion fetch quietly loses half the minutes:
  // has_children is true and nobody went down a level.
  const lost = deck({ sources: { mtg: MINUTES }, chainOpts: { mtg: { lostToggle: true } } });
  const problems = checkSources(lost.p).problems;
  assert.ok(problems.some((x) => /has_children/.test(x.message)), JSON.stringify(problems));

  // The same deck with the children actually fetched is clean.
  const ok = deck({ sources: { mtg: MINUTES }, chainOpts: { mtg: { toggle: true } } });
  assert.deepEqual(checkSources(ok.p).problems, [], JSON.stringify(checkSources(ok.p).problems));
});

test('a manifest that disagrees with its own evidence is reported', () => {
  for (const [field, value, kind] of [
    ['block_count', 999, 'block-count-disagrees'],
    ['pagination', { requests: 9, has_more: false, next_cursor: null }, 'pagination-disagrees'],
  ]) {
    const { p } = deck({ sources: { mtg: MINUTES } });
    const f = path.join(p.sources, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    m.sources[0][field] = value;
    fs.writeFileSync(f, JSON.stringify(m));
    assert.ok(checkSources(p).problems.some((x) => x.kind === kind), `${field} should report ${kind}`);
  }
});

test('a text file that is not a flattening of its own response is reported', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  fs.writeFileSync(path.join(p.sources, 'mtg.txt'), 'まったく無関係な別の議事録の本文です。');
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'text-unrelated'));
});

test('a notion TABLE is read as blocks, and counted', async () => {
  const { summariseRaw } = await import('../../src/intake/notion.js');
  const chain = [{
    object: 'list',
    results: [{
      object: 'block',
      id: 't1',
      type: 'table',
      has_children: true,
      table: { table_width: 2, has_column_header: true },
    }],
    has_more: false,
    next_cursor: null,
  }, {
    object: 'list',
    block_id: 't1',
    results: [
      {
        object: 'block',
        id: 'r1',
        type: 'table_row',
        table_row: { cells: [[{ plain_text: '予約件数' }], [{ plain_text: '412件' }]] },
      },
    ],
    has_more: false,
    next_cursor: null,
  }];
  const summary = summariseRaw(chain);
  assert.equal(summary.tables, 1);
  assert.equal(summary.blocks, 2);
  assert.equal(summary.unresolvedChildren, 0, 'the table rows WERE fetched');
  assert.deepEqual(summary.problems, []);
});

test('SOURCES ARE SEALED, so a later edit cannot retroactively validate a quote', () => {
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger() });
  assert.deepEqual(sealSources(p).changed, [], 'the first seal records, it does not complain');
  fs.writeFileSync(path.join(p.sources, 'mtg.txt'), `${MINUTES}\n- 追記: 来期予算を3,000万円に増額することで合意した。`);
  const { changed } = sealSources(p);
  assert.equal(changed.length, 1, 'rewriting a source after extraction must be caught');
  assert.match(changed[0].message, /has changed since the ledger was verified/);
});

// --------------------------------------------------------------------- ledger

test('a ledger whose quotes are all real passes', () => {
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger() });
  const { problems, checked, counts } = checkLedger(p);
  assert.deepEqual(problems, [], JSON.stringify(problems));
  assert.equal(checked, 7);
  assert.deepEqual(counts, { decision: 3, number: 2, action: 2 });
});

test('AN INVENTED DECISION IS REFUSED BY ID', () => {
  // The single most valuable check in this layer. A paraphrase reads exactly
  // like a quotation, and no instruction in a prompt makes the difference
  // visible to the PO.
  const l = goodLedger();
  l.entries.push({
    id: 'd-99', kind: 'decision', source_id: 'mtg', status: 'resolved',
    quote: '来期の予算を3,000万円に増額することで合意した。',
  });
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: l });
  const { problems } = checkLedger(p);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].entry_id, 'd-99');
  assert.equal(problems[0].kind, 'quote-not-in-source');
  assert.match(problems[0].message, /paraphrased, or it was invented/);
});

test('A PARAPHRASE IS REFUSED TOO, not only a fabrication', () => {
  // The dangerous middle case: every fact right, the wording the agent's own.
  const l = goodLedger();
  l.entries[0].quote = '宿泊パッケージの価格を18,000円に決定した。';
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: l });
  assert.ok(checkLedger(p).problems.some((x) => x.kind === 'quote-not-in-source'));
});

test('a quote lifted from a DIFFERENT source than the one cited is reported', () => {
  const l = goodLedger();
  l.entries[0].source_id = 'other';
  const { p } = deck({ sources: { mtg: MINUTES, other: '別の資料です。' }, ledger: l });
  assert.ok(checkLedger(p).problems.some((x) => x.kind === 'quote-from-other-source'));
});

test('a citation to a source that does not exist is reported', () => {
  const l = goodLedger();
  l.entries[0].source_id = 'nope';
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: l });
  assert.ok(checkLedger(p).problems.some((x) => x.kind === 'unknown-source'));
});

test('AN ACTION MAY NOT BE RECORDED done JUST BECAUSE IT SOUNDS FINISHED', () => {
  // The status vocabulary is per-kind, and the schema cannot express that: its
  // enum has to hold every value for every kind.
  const l = goodLedger();
  l.entries.find((e) => e.id === 'a-01').status = 'resolved';
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: l });
  const { problems } = checkLedger(p);
  assert.ok(problems.some((x) => x.kind === 'bad-status' && /an action is/.test(x.message)));
});

test('a number with no unit, or no period, is refused', () => {
  const l = goodLedger();
  const n = l.entries.find((e) => e.id === 'n-01');
  delete n.unit;
  delete n.period;
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: l });
  const kinds = checkLedger(p).problems.map((x) => x.kind);
  assert.ok(kinds.includes('number-no-unit'), '1,200 of what?');
  assert.ok(kinds.includes('number-no-period'), 'two numbers from different months are not a trend');
});

test('a number whose value is not in the source is refused', () => {
  const l = goodLedger();
  l.entries.find((e) => e.id === 'n-01').value = '413';
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: l });
  assert.ok(checkLedger(p).problems.some((x) => x.kind === 'value-not-in-source'));
});

test('a pending action with no owner is refused', () => {
  const l = goodLedger();
  delete l.entries.find((e) => e.id === 'a-01').owner;
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: l });
  assert.ok(checkLedger(p).problems.some((x) => x.kind === 'action-no-owner'));
});

test('CONFLICTING NUMBERS ARE BOTH KEPT, and a dangling link is caught', () => {
  // Minutes do contradict themselves. Recording both is how the agent avoids
  // silently picking one, so the link between them has to be real.
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger() });
  assert.deepEqual(checkLedger(p).problems, []);

  const l = goodLedger();
  l.entries.find((e) => e.id === 'n-01').conflicts_with = ['n-77'];
  const d2 = deck({ sources: { mtg: MINUTES }, ledger: l });
  assert.ok(checkLedger(d2.p).problems.some((x) => x.kind === 'dangling-conflict'));
});

test('the ledger gate does not run at all on unsound sources', () => {
  // Verifying quotes against a text file that is missing would pass every
  // quote for the wrong reason, so the source problems are reported instead.
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger() });
  fs.rmSync(path.join(p.sources, 'mtg.txt'));
  const { problems } = checkSources(p);
  assert.ok(problems.some((x) => x.kind === 'unreadable'));
});

test('which entries must be accounted for on an agenda', () => {
  const open = mustBeAccountedFor(goodLedger()).map((e) => e.id);
  assert.deepEqual(open.sort(), ['a-01', 'd-02', 'd-03'],
    'unresolved decisions, pending actions and open questions - not resolved ones');
});

// --------------------------------------------------------------------- agenda

test('an agenda accounting for every open item passes', () => {
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger(), agenda: goodAgenda() });
  const { problems, open, accounted } = checkAgenda(p);
  assert.deepEqual(problems, [], JSON.stringify(problems));
  assert.equal(open, 3);
  assert.equal(accounted, 5);
});

test('AN OPEN ITEM SILENTLY DROPPED IS REFUSED, with its source wording', () => {
  // An agenda that quietly drops an unresolved decision looks complete.
  // Nobody can see an absence - which is why this is a gate and not advice.
  const a = goodAgenda();
  a.excluded = [];
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger(), agenda: a });
  const { problems } = checkAgenda(p);
  const dropped = problems.filter((x) => x.kind === 'open-item-unaccounted');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].ref, 'd-03');
  assert.match(dropped[0].message, /予約システムの刷新/, 'the PO must see WHAT was dropped');
});

test('AN EXCLUSION NEEDS A REASON, and the schema is really enforced', () => {
  // This test caught the schemas being decorative: validate() RETURNS its
  // problems rather than throwing, and the three intake readers were
  // discarding the return value - so a missing `reason`, an unknown key and a
  // wrong schema constant all sailed through. The assertion is on the DETAIL
  // line, because that is where the field name appears.
  const a = goodAgenda();
  a.excluded = [{ ledger_refs: ['d-02'] }];
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger(), agenda: a });
  assert.throws(() => checkAgenda(p), (err) => {
    assert.match(err.message, /does not match deck's agenda schema/);
    assert.ok(err.details.some((d) => /required property 'reason'/.test(d)), err.details.join(' | '));
    return true;
  });
});

test('the intake schemas refuse an unknown key and a wrong schema constant', () => {
  // additionalProperties: false everywhere, for the reason the storyboard
  // schema has it: a typo'd key is silently dropped content.
  for (const [file, doc] of [
    ['ledger.json', { schema: 'deck.ledger/1', entries: [], nope: 1 }],
    ['agenda.json', { schema: 'deck.agenda/9', meeting: { purpose: 'p', audience: 'a' }, items: [] }],
  ]) {
    const { root } = deck({ sources: { mtg: MINUTES } });
    fs.writeFileSync(path.join(root, file), JSON.stringify(doc));
    const read = file === 'ledger.json' ? checkLedger : checkAgenda;
    assert.throws(() => read(paths(root)), /does not match deck's/, file);
  }
});

test('an item and an exclusion cannot both claim the same entry', () => {
  const a = goodAgenda();
  a.excluded = [{ ledger_refs: ['d-02'], reason: '今回は見送る' }];
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger(), agenda: a });
  assert.ok(checkAgenda(p).problems.some((x) => x.kind === 'both-included-and-excluded'));
});

test('an agenda item citing a ledger entry that does not exist is refused', () => {
  const a = goodAgenda();
  a.items[0].ledger_refs = ['d-02', 'ghost'];
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger(), agenda: a });
  assert.ok(checkAgenda(p).problems.some((x) => x.kind === 'dangling-ref' && x.ref === 'ghost'));
});

test('agent_proposed is an allowed ref, so the agent\'s own idea stays visible', () => {
  // The alternative is an agent hiding its own suggestion behind a citation.
  const a = goodAgenda();
  a.items.push({
    id: 'i-03', heading: '来期の進め方', why: '議題として用意しておきたい', ledger_refs: ['agent_proposed'],
  });
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger(), agenda: a });
  assert.deepEqual(checkAgenda(p).problems.filter((x) => x.kind === 'dangling-ref'), []);
});

test('a reason that merely restates the heading is refused', () => {
  const a = goodAgenda();
  a.items[0].why = a.items[0].heading;
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger(), agenda: a });
  assert.ok(checkAgenda(p).problems.some((x) => x.kind === 'why-restates-heading'));
});

test('an agenda with no ledger behind it is refused', () => {
  const { p } = deck({ sources: { mtg: MINUTES }, agenda: goodAgenda() });
  assert.ok(checkAgenda(p).problems.some((x) => x.kind === 'no-ledger'));
});

// ------------------------------------------------------------------- fidelity

/** A storyboard carrying the given fragments, in the shapes the templates render. */
function board(patch = {}) {
  return {
    schema: 'deck.storyboard/1',
    title: 'テスト',
    slides: [{
      id: 's1', page_type: 'statement', purpose: 'テスト', title: '見出し', subtitle: null, ...patch,
    }],
  };
}

test('numbers and dates that occur in the source pass', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const sb = board({ body: [{ kind: 'statement', text: '9月の予約件数は 412件 だった。' }] });
  const { findings } = checkFidelity(p, sb);
  assert.deepEqual(findings, [], JSON.stringify(findings));
});

test('AN INVENTED NUMBER ON A SLIDE IS BLOCKED', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const sb = board({ body: [{ kind: 'statement', text: '9月の予約件数は 450件 だった。' }] });
  const { findings } = checkFidelity(p, sb);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'block');
  assert.equal(findings[0].kind, 'number-not-in-source');
  assert.match(findings[0].message, /450件 appears in no source text/);
});

test('A MOVED DATE IS BLOCKED', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const sb = board({ title: '次回は10月28日', body: [] });
  const { findings } = checkFidelity(p, sb);
  assert.ok(findings.some((f) => f.kind === 'date-not-in-source'));
});

test('a reformatted number is NOT a fabrication', () => {
  // 18,000 and 18000 are the same number. Blocking this would teach the agent
  // to copy separators rather than to copy facts.
  const { p } = deck({ sources: { mtg: MINUTES } });
  const sb = board({ body: [{ kind: 'statement', text: '価格は18000円です。' }] });
  assert.deepEqual(checkFidelity(p, sb).findings, []);
});

test('the agent\'s OWN prose with a small count is not blocked', () => {
  // The threshold that keeps this gate usable. 「3つの論点」 is the agent
  // writing a sentence, not making a claim about the minutes.
  const { p } = deck({ sources: { mtg: MINUTES } });
  const sb = board({ title: '本日の3つの論点', body: [] });
  assert.deepEqual(checkFidelity(p, sb).findings, []);
});

test('A TABLE CELL CARRYING A NUMBER MUST BE VERBATIM', () => {
  // A table is where a number goes to be read as data, so the bar is the
  // whole cell rather than the number inside it.
  const { p } = deck({ sources: { mtg: MINUTES } });
  const ok = board({
    page_type: 'table',
    table: { columns: [{ heading: '項目' }, { heading: '9月' }], rows: [['予約件数', '412件']], note: null },
  });
  assert.deepEqual(checkFidelity(p, ok).findings, [], 'a verbatim cell passes');

  const bad = board({
    page_type: 'table',
    table: { columns: [{ heading: '項目' }, { heading: '9月' }], rows: [['予約件数', '412件（前年比+8%）']], note: null },
  });
  const { findings } = checkFidelity(p, bad);
  assert.ok(findings.some((f) => f.kind === 'table-cell-not-verbatim' || f.kind === 'number-not-in-source'),
    `expected a blocking finding, got ${JSON.stringify(findings)}`);
});

test('AN UNRESOLVED ITEM DESCRIBED AS FINISHED IS WARNED ABOUT, not blocked', () => {
  // A heuristic, and reported as one. Blocking on word-matching would teach
  // the agent to word around it, which is worse than not having it.
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger() });
  const sb = board({
    body: [{ kind: 'statement', text: '送客チャネルをOTA中心にするか自社サイト中心にするかは対応済みです。' }],
  });
  const { findings } = checkFidelity(p, sb);
  const warn = findings.filter((f) => f.kind === 'pending-described-as-finished');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].severity, 'warn', 'a heuristic must not block');
  assert.match(warn[0].message, /d-02/);
});

test('「導入済み」 IS NOT A COMPLETION CLAIM, and 「完了」 beside it still is', () => {
  // FROM THE FIELD REPORT. 済み matches inside PMS導入済み, which is an
  // adjective naming WHICH facilities already run the system, not a claim
  // that an open decision was settled. It fired three or four times on every
  // run of a real deck, and a warning that is wrong every time is one the
  // reader learns to scroll past - which costs the warnings that are right.
  const minutes = `${MINUTES}\n- PMS導入済みの施設は3件、未導入は5件。\n`;
  const { p } = deck({ sources: { mtg: minutes }, ledger: goodLedger() });
  const warnings = (text) => checkFidelity(p, board({ body: [{ kind: 'statement', text }] }))
    .findings.filter((f) => f.kind === 'pending-described-as-finished');

  // The adjective, in a sentence that overlaps the unresolved d-02 entry.
  assert.deepEqual(
    warnings('送客チャネルをOTA中心にするか自社サイト中心にするかは、PMS導入済みの施設から考えます。'),
    [],
    '導入済み describes a group of facilities; it asserts nothing about the open decision',
  );
  assert.deepEqual(warnings('未導入の施設にどう広げるかは次の論点です。'), []);

  // SUPPRESSING THE WHOLE FRAGMENT WOULD HAVE BEEN THE EASY FIX AND THE
  // WRONG ONE. A real completion claim in the same sentence as the adjective
  // must still be caught.
  const both = warnings('PMS導入済みの施設については、送客チャネルをOTA中心にするか自社サイト中心にするかは完了しています。');
  assert.equal(both.length, 1, 'the adjective must not silence a genuine claim beside it');
  assert.equal(both[0].severity, 'warn');
  assert.match(both[0].message, /完了/);
});

test('a slide quoting an action the source really marks done is not warned about', () => {
  const { p } = deck({ sources: { mtg: MINUTES }, ledger: goodLedger() });
  const sb = board({ body: [{ kind: 'statement', text: '9月の予約件数の確定は完了しました。' }] });
  const warn = checkFidelity(p, sb).findings.filter((f) => f.kind === 'pending-described-as-finished');
  assert.deepEqual(warn, [], 'a-02 is done in the source, so there is nothing to warn about');
});

test('no sources at all means every number is unverifiable, and that BLOCKS', () => {
  const { p } = deck({ sources: {}, manifest: false });
  const sb = board({ body: [{ kind: 'statement', text: '412件' }] });
  const { findings } = checkFidelity(p, sb);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'no-sources');
  assert.equal(findings[0].severity, 'block');
});

test('fidelity walks EVERY rendered fragment, through the lint rule\'s own enumeration', async () => {
  // Shared with content-integrity on purpose: two enumerations of "what the
  // PO will see" would eventually disagree, and the gap is where an unchecked
  // number lives.
  const { requiredText } = await import('../../src/lint/rules/content-integrity.js');
  const { p } = deck({ sources: { mtg: MINUTES } });
  const slide = {
    id: 's1', page_type: 'standard-3col', purpose: 'x', title: '見出し',
    body: [{
      kind: 'cards',
      cards: [{ heading: 'カード', body: '本文に 999件 ', items: ['項目に 888件 '] }],
    }],
  };
  const fields = requiredText(slide).map((f) => f.field);
  assert.ok(fields.includes('cards[0].body') && fields.includes('cards[0].items[0]'));
  const { findings } = checkFidelity(p, { schema: 'deck.storyboard/1', title: 't', slides: [slide] });
  assert.equal(findings.filter((f) => f.kind === 'number-not-in-source').length, 2,
    'both the card body and the card bullet must be checked');
});

// ----------------------------------------------------------------- copy sheet

test('THE COPY SHEET IS READABLE JAPANESE, numbered so the PO can point at a slide', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const sb = {
    schema: 'deck.storyboard/1',
    title: '野沢温泉 次回定例',
    slides: [
      { id: 'cover', page_type: 'cover', purpose: 'x', title: '送客チャネルを決める', subtitle: null },
      {
        id: 'tbl',
        page_type: 'table',
        purpose: 'x',
        title: '予約件数',
        table: { columns: [{ heading: '項目' }, { heading: '9月' }], rows: [['予約件数', '412件']], note: null },
      },
    ],
  };
  const { text, slides, totals } = copySheet(p, sb);
  assert.match(text, /## 1枚目（表紙）/);
  assert.match(text, /## 2枚目（表）/);
  assert.match(text, /タイトル: 【作成】 送客チャネルを決める/,
    'a heading the agent wrote is marked as written');
  assert.match(text, /表 1 行 2 列: 【引用】 412件/,
    'a cell lifted from the minutes is marked as quoted');
  assert.match(text, /直したいところは「3枚目のタイトルを/, 'it must tell the PO how to ask for an edit');
  assert.equal(slides.length, 2);
  assert.equal(totals.quoted + totals.written, slides.flatMap((s) => s.fragments).length);
  assert.ok(!text.includes('page_type:'), 'no YAML, no field paths - this is for a person');
});

test('PROVENANCE IS COMPUTED, so the agent cannot label its own prose as a quotation', () => {
  // If the mark were declared, the one label that matters would be the one the
  // agent had an incentive to get wrong.
  const { p } = deck({ sources: { mtg: MINUTES } });
  const paraphrase = '価格は18,000円に決定しました。';
  const verbatim = '宿泊パッケージの価格は 18,000円 で確定とする。';
  const sheet = copySheet(p, {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [
      { id: 'a', page_type: 'statement', purpose: 'x', title: 'A', body: [{ kind: 'statement', text: paraphrase }] },
      { id: 'b', page_type: 'statement', purpose: 'x', title: 'B', body: [{ kind: 'statement', text: verbatim }] },
    ],
  });
  const frag = (i) => sheet.slides[i].fragments.find((f) => f.field === 'body statement');
  assert.equal(frag(0).quoted, false, 'a paraphrase is the agent writing, however faithful');
  assert.equal(frag(1).quoted, true);
  assert.equal(frag(1).source_id, 'mtg', 'and it says WHICH source');
});

test('with no source loaded, the copy sheet says it cannot judge rather than claiming 作成', () => {
  // Marking everything 【作成】 when the sources are missing would be a lie of
  // the most confident kind.
  const { p } = deck({ sources: {}, manifest: false });
  const { text } = copySheet(p, board());
  assert.match(text, /引用の判定ができていません/);
  assert.match(text, /【—】/);
});

test('the copy sheet names the illustration slots and says they carry no words', () => {
  const { p } = deck({ sources: { mtg: MINUTES } });
  const sb = board({
    slots: [{ id: 'cover-art', brief: '温泉宿の水彩', width_px: 760, height_px: 941 }],
  });
  const { text } = copySheet(p, sb);
  assert.match(text, /図版枠「cover-art」/);
  assert.match(text, /760x941px・文字は入りません/);
});

// ================================================================= REGRESSIONS
//
// Every test below reproduces a defect that reached the PO, or would have.
// They are grouped here rather than beside their neighbours because what they
// have in common is the failure mode: a gate that was confidently wrong.

test('A2: A CORRECT QUOTE IS NOT REFUSED BECAUSE ANOTHER SOURCE REPEATS IT', () => {
  // quoteFrom() returned the FIRST source containing the wording and the gate
  // compared that with the cited one - so an entry citing the minutes was
  // refused whenever an earlier source carried the same sentence. A forwarded
  // copy of the same page, a quoted excerpt or shared boilerplate is enough.
  const SAME = '宿泊パッケージの価格は 18,000円 で確定とする。';
  const ledger = {
    schema: 'deck.ledger/1',
    entries: [{
      id: 'd-01', kind: 'decision', source_id: 'b-minutes', status: 'resolved', quote: SAME,
    }],
  };
  const { p } = deck({ sources: { 'a-minutes': SAME, 'b-minutes': SAME }, ledger });
  assert.deepEqual(checkLedger(p).problems, [], 'the cited source does contain it');
});

test('A2 control: the cited source NOT containing it still points at the one that does', () => {
  const SAME = '宿泊パッケージの価格は 18,000円 で確定とする。';
  const ledger = {
    schema: 'deck.ledger/1',
    entries: [{
      id: 'd-01', kind: 'decision', source_id: 'b-minutes', status: 'resolved', quote: SAME,
    }],
  };
  const { p } = deck({ sources: { 'a-minutes': SAME, 'b-minutes': '別の話をしています。' }, ledger });
  const problems = checkLedger(p).problems;
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'quote-from-other-source');
  assert.match(problems[0].message, /"a-minutes"/, 'it must name where the wording really is');
});

test('A2 control: wording in NO source is still an invention', () => {
  const ledger = {
    schema: 'deck.ledger/1',
    entries: [{
      id: 'd-99', kind: 'decision', source_id: 'mtg', status: 'resolved',
      quote: '来期の予算を3,000万円に増額することで合意した。',
    }],
  };
  const { p } = deck({ sources: { mtg: MINUTES }, ledger });
  assert.ok(checkLedger(p).problems.some((x) => x.kind === 'quote-not-in-source'));
});

test('A3: THE SAME DATE IN TWO FORMATS IS ONE DATE', () => {
  // The old normaliser ran four patterns independently, so 2026年10月14日
  // produced THREE overlapping tokens - the full date, the year-month and the
  // month-day - while 2026-10-14 produced one. A source written with hyphens
  // and a slide written in Japanese therefore disagreed about the same date,
  // and the slide was blocked TWICE for it. On an ordinary deck.
  const { p } = deck({ sources: { mtg: '次回の開催は 2026-10-14 とする。' } });
  const sb = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{
      id: 's1', page_type: 'statement', purpose: 'x', title: '次回は2026年10月14日',
      body: [{ kind: 'statement', text: '次回の開催は2026年10月14日とする。' }],
    }],
  };
  assert.deepEqual(checkFidelity(p, sb).findings, [], JSON.stringify(checkFidelity(p, sb).findings));
});

test('A3: and the reverse direction, Japanese source to a slashed slide', () => {
  const { p } = deck({ sources: { mtg: '次回の開催は 2026年10月14日 とする。' } });
  const sb = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{ id: 's1', page_type: 'statement', purpose: 'x', title: '次回は2026/10/14' }],
  };
  assert.deepEqual(checkFidelity(p, sb).findings, []);
});

test('A3 control: a slide that INVENTS the year is still blocked', () => {
  // The source side vouches for the less specific forms it implies, which is
  // the safe direction. It does not work upwards: a source saying only
  // 10月14日 cannot authorise a slide that has decided which year.
  const { p } = deck({ sources: { mtg: '次回は 10月14日 です。' } });
  const sb = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{ id: 's1', page_type: 'statement', purpose: 'x', title: '次回は2026年10月14日' }],
  };
  const findings = checkFidelity(p, sb).findings;
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].kind, 'date-not-in-source');
});

test('A3 control: a date moved by a week is still blocked, exactly once', () => {
  const { p } = deck({ sources: { mtg: '次回は 2026-10-14 です。' } });
  const sb = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{ id: 's1', page_type: 'statement', purpose: 'x', title: '次回は2026年10月21日' }],
  };
  const findings = checkFidelity(p, sb).findings;
  assert.equal(findings.length, 1, 'one wrong date is one finding, not three');
  assert.match(findings[0].message, /2026年10月21日/);
});

test('B3: 1.5% DOES NOT AUTHORISE 15%', () => {
  // The decimal point was stripped along with the grouping comma, so 1.5 and
  // 15 had the same core and the gate saw the same number. A source saying
  // 1.5% authorised a slide saying 15% - a tenfold claim, passing cleanly.
  const { p } = deck({ sources: { mtg: '前年比は 1.5% 増でした。' } });
  const sb = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{
      id: 's1', page_type: 'statement', purpose: 'x', title: '成長率',
      body: [{ kind: 'statement', text: '前年比15%増を達成しました。' }],
    }],
  };
  const findings = checkFidelity(p, sb).findings;
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].kind, 'number-not-in-source');
  assert.match(findings[0].message, /15%/);
});

test('B3: and the decimal itself still passes, in either notation', () => {
  const { p } = deck({ sources: { mtg: '前年比は 1.5% 増でした。' } });
  const sb = (text) => ({
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{
      id: 's1', page_type: 'statement', purpose: 'x', title: '成長率',
      body: [{ kind: 'statement', text }],
    }],
  });
  assert.deepEqual(checkFidelity(p, sb('前年比1.5%増')).findings, []);
  assert.deepEqual(checkFidelity(p, sb('前年比1.50%増')).findings, [], '1.50 is the same number as 1.5');
  assert.deepEqual(checkFidelity(p, sb('前年比１.５%増')).findings, [], 'full-width digits too');
});

test('B3: a grouping comma is still only formatting', () => {
  const { p } = deck({ sources: { mtg: '売上は 1,234,567円 でした。' } });
  const sb = (text) => ({
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{ id: 's1', page_type: 'statement', purpose: 'x', title: text }],
  });
  assert.deepEqual(checkFidelity(p, sb('売上1234567円')).findings, []);
  assert.equal(checkFidelity(p, sb('売上1234568円')).findings.length, 1, 'and a changed digit is not');
});

test('C1: A KANJI SOURCE DOES NOT BLOCK AN ARABIC SLIDE', () => {
  // Minutes are typed by people, and people write 十二件 as readily as 12件.
  // Kanji numerals were not tokenised at all, so the source vouched for
  // nothing and the equivalent slide was refused.
  const { p } = deck({ sources: { mtg: '指摘は十二件ありました。' } });
  const sb = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{ id: 's1', page_type: 'statement', purpose: 'x', title: '指摘は12件' }],
  };
  assert.deepEqual(checkFidelity(p, sb).findings, [], JSON.stringify(checkFidelity(p, sb).findings));
});

test('C1: AN INVENTED KANJI QUANTITY IS NOW CHECKED', () => {
  // The other half, and the worse one: a kanji number on a slide produced no
  // token, so it bypassed the fidelity check altogether. 五十件 could be put
  // on a slide whose source said 12件 and nothing would notice.
  const { p } = deck({ sources: { mtg: '指摘は12件ありました。' } });
  const sb = {
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{ id: 's1', page_type: 'statement', purpose: 'x', title: '指摘は五十件' }],
  };
  const findings = checkFidelity(p, sb).findings;
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].kind, 'number-not-in-source');
});

test('C1: larger kanji numerals, and a word that only looks like one', async () => {
  const { kanjiToNumber } = await import('../../src/intake/text.js');
  assert.equal(kanjiToNumber('千二百'), '1200');
  assert.equal(kanjiToNumber('一万三千'), '13000');
  assert.equal(kanjiToNumber('三百'), '300');
  assert.equal(kanjiToNumber('四半期'), null, '四半期 is a word, not a number');
  assert.equal(kanjiToNumber('見込み'), null);
});

test('C1: a numeric table cell accepts reformatting but not a changed number', () => {
  const src = '## 表\n| 項目 | 9月 |\n| 予約件数 | 1,234件 |\n';
  const cell = (c) => ({
    schema: 'deck.storyboard/1',
    title: 't',
    slides: [{
      id: 's1', page_type: 'table', purpose: 'x', title: '表',
      table: { columns: [{ heading: '項目' }, { heading: '9月' }], rows: [['予約件数', c]], note: null },
    }],
  });
  const { p } = deck({ sources: { mtg: src } });
  for (const same of ['1,234件', '1234件', '１２３４件']) {
    assert.deepEqual(checkFidelity(p, cell(same)).findings, [], `${same} is the same data`);
  }
  assert.ok(checkFidelity(p, cell('1,235件')).findings.length > 0, 'a changed digit is not');
});

test('a list separator does not join two numbers into one', async () => {
  // 、 and ・ used to be folded to , and . - so 「9月・10月」 became one
  // number and matched nothing, and 「1、2、3」 became 123.
  const { numericTokens } = await import('../../src/intake/text.js');
  assert.deepEqual(numericTokens('9月・10月').map((t) => t.core), ['9', '10']);
  assert.deepEqual(numericTokens('1、2、3').map((t) => t.core), ['1', '2', '3']);
});

test('C5: AN OWNER THE SOURCE DOES NOT NAME IS RECORDED, NOT INVENTED', () => {
  // The gate refused a pending action with no owner, which left the agent two
  // options: drop a real action, or make up a name. Both are worse than the
  // truth, and making one up is exactly what these gates exist to prevent.
  const quote = '送客チャネルをOTA中心にするか自社サイト中心にするかは次回までに決める。';
  const entry = (extra) => ({
    schema: 'deck.ledger/1',
    entries: [{
      id: 'a-01', kind: 'action', source_id: 'mtg', status: 'pending', quote, ...extra,
    }],
  });
  const without = deck({ sources: { mtg: MINUTES }, ledger: entry({}) });
  assert.ok(checkLedger(without.p).problems.some((x) => x.kind === 'action-no-owner'));

  const declared = deck({ sources: { mtg: MINUTES }, ledger: entry({ source_omits: ['owner'] }) });
  assert.deepEqual(checkLedger(declared.p).problems, [], 'recording the absence is accepted');

  const both = deck({
    sources: { mtg: MINUTES },
    ledger: entry({ owner: '田中', source_omits: ['owner'] }),
  });
  assert.ok(checkLedger(both.p).problems.some((x) => x.kind === 'omits-but-filled'),
    'declaring it absent AND filling it in is a contradiction');
});

test('C5: a number whose source states no period is recordable too', () => {
  const quote = '9月の予約件数は 412件 だった。';
  const { p } = deck({
    sources: { mtg: MINUTES },
    ledger: {
      schema: 'deck.ledger/1',
      entries: [{
        id: 'n-01', kind: 'number', source_id: 'mtg', quote, value: '412', unit: '件',
        source_omits: ['period'],
      }],
    },
  });
  assert.deepEqual(checkLedger(p).problems, []);
});

test('C5: MISSING INFORMATION MUST REACH THE PO AT THE AGENDA GATE', () => {
  // Recording "the minutes do not say who owns this" is only worth anything
  // if the hole is raised. A missing owner is a question for the room, and
  // the agenda is where the room's questions are agreed.
  const quote = '送客チャネルをOTA中心にするか自社サイト中心にするかは次回までに決める。';
  const ledger = {
    schema: 'deck.ledger/1',
    entries: [{
      id: 'a-01', kind: 'action', source_id: 'mtg', status: 'pending', quote, source_omits: ['owner'],
    }],
  };
  const buried = {
    schema: 'deck.agenda/1',
    meeting: { purpose: 'p', audience: 'a' },
    items: [{ id: 'i-01', heading: '別の件', why: 'こちらを先に決めたい', ledger_refs: ['agent_proposed'] }],
    excluded: [{ ledger_refs: ['a-01'], reason: '次回は報告待ち' }],
  };
  const hidden = deck({ sources: { mtg: MINUTES }, ledger, agenda: buried });
  assert.ok(checkAgenda(hidden.p).problems.some((x) => x.kind === 'missing-information-not-raised'));

  const raised = deck({
    sources: { mtg: MINUTES },
    ledger,
    agenda: { ...buried, missing_evidence: [{ what: 'a-01 の担当者', why: '議事録に担当の記載がない' }] },
  });
  assert.deepEqual(checkAgenda(raised.p).problems, []);
});

test('A1: the agenda digest covers the EXCLUSIONS, not only the items', async () => {
  // The PO agreed to leave those things out, for those reasons. An agenda
  // whose exclusion list has quietly changed is a different agenda.
  const { agendaArtifactDigest } = await import('../../src/digest.js');
  const base = {
    schema: 'deck.agenda/1',
    meeting: { purpose: 'p', audience: 'a' },
    items: [{ id: 'i-01', heading: 'h', why: 'w', ledger_refs: ['d-01'] }],
    excluded: [{ ledger_refs: ['d-02'], reason: '費用が読めないため' }],
  };
  const changedReason = { ...base, excluded: [{ ledger_refs: ['d-02'], reason: 'まったく別の理由' }] };
  const noExclusion = { ...base, excluded: [] };
  assert.notEqual(agendaArtifactDigest(base), agendaArtifactDigest(changedReason));
  assert.notEqual(agendaArtifactDigest(base), agendaArtifactDigest(noExclusion));
  // ...and re-ordering the keys of the same agenda does not change it.
  const reordered = {
    excluded: base.excluded, items: base.items, meeting: base.meeting, schema: base.schema,
  };
  assert.equal(agendaArtifactDigest(base), agendaArtifactDigest(reordered));
});

test('A1: and it names which agenda field moved', async () => {
  const { agendaArtifactProjection, describeAgendaChanges } = await import('../../src/digest.js');
  const before = agendaArtifactProjection({
    meeting: { purpose: 'p', audience: 'a' },
    items: [{ id: 'i-01', heading: '送客チャネル', why: 'w', ledger_refs: ['d-01'] }],
    excluded: [{ ledger_refs: ['d-02'], reason: '費用が読めないため' }],
  });
  const after = agendaArtifactProjection({
    meeting: { purpose: 'p', audience: 'a' },
    items: [{ id: 'i-01', heading: '別の論点', why: 'w', ledger_refs: ['d-01'] }],
    excluded: [],
  });
  const changes = describeAgendaChanges(before, after);
  assert.ok(changes.some((c) => /i-01.*heading/.test(c)), JSON.stringify(changes));
  assert.ok(changes.some((c) => /no longer excluded/.test(c)), JSON.stringify(changes));
});

test('C3: AN AMBIGUOUS INBOX MATCH IS REFUSED, not guessed', async () => {
  // find() silently took whichever file readdir returned first. A wrong
  // illustration in the right slot renders cleanly: lint cannot see it, and
  // the PO would find it in the meeting.
  const { inboxCommand } = await import('../../src/commands/intake.js');
  const root = tempDir('deck-inbox テスト');
  made.push(root);
  const p = paths(root);
  fs.mkdirSync(p.inbox, { recursive: true });
  fs.mkdirSync(p.assets, { recursive: true });
  fs.writeFileSync(p.deckYaml, [
    'schema: deck.request/1',
    'request:',
    '  project_name: "t"',
    '  purpose: "t"',
    '  audience: "t"',
    '  theme: watercolor',
    '  output:',
    '    formats: [pdf]',
    '    png_scale: 2',
  ].join('\n'));
  fs.writeFileSync(p.storyboard, [
    'schema: deck.storyboard/1',
    'title: "t"',
    'slides:',
    '  - id: cover',
    '    page_type: cover',
    '    purpose: "p"',
    '    title: "t"',
    '    slots:',
    '      - id: hero',
    '        brief: "b"',
    '        width_px: 100',
    '        height_px: 100',
  ].join('\n'));
  // A one-pixel PNG, twice, both matching the slot id.
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154'
    + '789c63000100000500010d0a2db40000000049454e44ae426082', 'hex',
  );
  fs.writeFileSync(path.join(p.inbox, '01-hero.png'), png);
  fs.writeFileSync(path.join(p.inbox, '02-hero.png'), png);

  const cwd = process.cwd();
  const out = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  let code;
  try {
    process.chdir(root);
    code = await inboxCommand([]);
  } finally {
    process.stdout.write = write;
    process.chdir(cwd);
  }
  assert.equal(code, 1, 'an ambiguous inbox is not a pass');
  assert.match(out.join(''), /AMBIGUOUS/);
  assert.match(out.join(''), /01-hero\.png/);
  assert.match(out.join(''), /02-hero\.png/);
  // NOTHING WAS IMPORTED. No asset manifest at all is the strongest form of
  // that: the import path was never entered, so no file was copied in on a
  // guess and no hash was recorded for an image nobody chose.
  const imported = fs.existsSync(p.assetManifest)
    ? (JSON.parse(fs.readFileSync(p.assetManifest, 'utf8')).assets || [])
    : [];
  assert.deepEqual(imported, [], 'nothing may be imported on a guess');
});

// ====================================================== THE NOTION MCP SHAPE
//
// The source gate demanded a REST block-children list response. `notion-fetch`
// - the tool the agent is told to use - returns a PAGE OBJECT: metadata,
// title, url, and the whole page already flattened into `text`. There is no
// `results` array anywhere in it. So a correctly saved retrieval was reported
// as "no Notion list response at all" and the deck was blocked on evidence
// that was perfectly good.
//
// This is the exact shape of the files in the PO's own deck.

/** What notion-fetch really returns, keys and all. */
function fetchedPage(id, text) {
  return {
    metadata: {
      id: `2812${id}-0000-8000-0000-000000000000`,
      object: 'page',
      created_time: '2026-10-12T04:00:00.000Z',
      last_edited_time: '2026-10-12T09:30:00.000Z',
    },
    title: `野沢温泉 ${id}`,
    url: `https://www.notion.so/${id}`,
    text,
    cover: null,
    icon: null,
    path: ['野沢温泉プロジェクト', `野沢温泉 ${id}`],
    verification: null,
    page_last_edited_at: '2026-10-12T09:30:00.000Z',
  };
}

test('THE SOURCE GATE ACCEPTS A notion-fetch PAGE OBJECT', () => {
  const { p } = deck({ sources: { mtg: MINUTES }, raw: { mtg: fetchedPage('minutes', MINUTES) } });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  // A fetched page has no blocks to count and no cursor to follow; the agent
  // records what it has.
  m.sources[0].block_count = null;
  m.sources[0].pagination = null;
  fs.writeFileSync(f, JSON.stringify(m));
  assert.deepEqual(checkSources(p).problems, [], JSON.stringify(checkSources(p).problems));
});

test('a page object wrapped in an array is accepted too', () => {
  const { p } = deck({
    sources: { mtg: MINUTES },
    raw: { mtg: [fetchedPage('minutes', MINUTES)] },
  });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].block_count = null;
  m.sources[0].pagination = null;
  fs.writeFileSync(f, JSON.stringify(m));
  assert.deepEqual(checkSources(p).problems, []);
});

test('and so is a deck built from TWO fetched pages', () => {
  // The PO's deck has exactly this: minutes and a scheme page.
  const { p } = deck({
    sources: { minutes: MINUTES, scheme: '## 案\n- 案①: 事前チェックイン\n' },
    raw: {
      minutes: fetchedPage('minutes', MINUTES),
      scheme: fetchedPage('scheme', '## 案\n- 案①: 事前チェックイン\n'),
    },
  });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const src of m.sources) { src.block_count = null; src.pagination = null; }
  fs.writeFileSync(f, JSON.stringify(m));
  assert.deepEqual(checkSources(p).problems, []);
});

test('a page object whose text is NOT what the text file says is still caught', () => {
  // Accepting the shape does not mean accepting anything in it. The flattened
  // file still has to be a flattening of the page that was fetched.
  const { p } = deck({
    sources: { mtg: MINUTES },
    raw: { mtg: fetchedPage('minutes', 'まったく無関係な別のページの本文です。これは議事録ではありません。') },
  });
  const f = path.join(p.sources, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  m.sources[0].block_count = null;
  m.sources[0].pagination = null;
  fs.writeFileSync(f, JSON.stringify(m));
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'text-unrelated'),
    JSON.stringify(checkSources(p).problems));
});

test('an empty page object is not evidence of a retrieval', () => {
  const { p } = deck({
    sources: { mtg: MINUTES },
    raw: { mtg: { metadata: { id: 'x' }, title: 't', url: 'u', text: '' } },
  });
  assert.ok(checkSources(p).problems.some((x) => x.kind === 'raw-not-a-response'));
});

test('summariseRaw reports a fetched page as one request and one page', async () => {
  const { summariseRaw } = await import('../../src/intake/notion.js');
  const s = summariseRaw(fetchedPage('minutes', MINUTES));
  assert.equal(s.requests, 1);
  assert.equal(s.pages, 1);
  assert.equal(s.blocks, 0, 'a fetched page carries no block objects');
  assert.equal(s.unfinished, false, 'and leaves no cursor to follow');
  assert.deepEqual(s.problems, []);
});


// ---------------------------------------------------------------------------
// NOTION EVIDENCE: the source gate and the approval prerequisite are ONE check.
// ---------------------------------------------------------------------------

test('A NOTION PAGE OBJECT PASSES, and `source` and `approve` give the SAME answer', () => {
  // FROM THE FIELD REPORT: `deck gate source` passed and `approve` failed on
  // the same source, and a real deck shipped with ZERO approvals because of
  // it. The gate used to demand a block-children LIST response, which the
  // MCP never returns for a fetched page.
  //
  // It does not reproduce any more - both paths call checkSources - and this
  // test is what keeps that true. The assertion is not "both pass": it is
  // that the two paths return the SAME problems, which is the property that
  // was broken and the one that would break again if they ever forked.
  const { p } = deck({
    sources: { kickoff: MINUTES },
    raw: { kickoff: fetchedPage('kickoff', MINUTES) },
    manifest: null,
    ledger: goodLedger(),
  });

  const gate = checkSources(p).problems;
  const prereq = prerequisitesFor(p, 'agenda', board()).find((x) => x.gate === 'source');

  assert.deepEqual(gate, [], `the page object is good evidence: ${JSON.stringify(gate)}`);
  assert.equal(prereq.ok, true, 'and the approval path must not disagree with the gate about it');
  assert.equal(prereq.details.length, 0);
});

test('AND THEY AGREE WHEN THE EVIDENCE IS BAD, which is the half that matters', () => {
  // Agreeing on a pass is easy. The divergence that cost a deck its approvals
  // was one path accepting what the other refused, so the failing case is
  // asserted too - problem for problem, not just verdict for verdict.
  const cases = {
    'a raw file that does not exist': (m) => { m.sources[0].raw_file = 'sources/gone.json'; },
    'a retrieval the manifest itself calls partial': (m) => { m.sources[0].complete = false; },
    'an unfollowed cursor': (m) => { m.sources[0].pagination = { requests: 1, has_more: true, next_cursor: 'c' }; },
  };
  for (const [label, damage] of Object.entries(cases)) {
    const { p, root } = deck({ sources: { kickoff: MINUTES }, raw: { kickoff: fetchedPage('kickoff', MINUTES) } });
    const manifestFile = path.join(p.sources, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    damage(m);
    fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2));
    assert.ok(root);

    const gate = checkSources(p).problems;
    const prereq = prerequisitesFor(p, 'agenda', board()).find((x) => x.gate === 'source');
    assert.ok(gate.length > 0, `${label}: the source gate must refuse this`);
    assert.equal(prereq.ok, false, `${label}: and so must the approval prerequisite`);
    assert.deepEqual(
      prereq.details,
      gate.slice(0, 5).map((x) => x.message),
      `${label}: the two paths must report the SAME problems, not merely both fail`,
    );
  }
});

test('THE QUOTE CHECK IS NOT RELAXED BY ANY OF THIS', () => {
  // The PO named the ledger's quote matching as the single most valuable
  // thing in the tool: it caught a Notion source whose last 171 characters
  // were missing, including two items under 「まだ決まっていないこと」, when
  // every other gate - `source` included - passed the truncated source as
  // complete. Accepting the MCP's page shape must not have loosened it.
  const full = `${MINUTES}\n## まだ決まっていないこと\n- 着手時期は未定である。\n`;
  const truncated = full.slice(0, full.indexOf('## まだ決まっていないこと'));
  const ledger = {
    schema: 'deck.ledger/1',
    extracted_at: '2026-10-07T06:00:00.000Z',
    entries: [{
      id: 'd-09', kind: 'open_question', source_id: 'kickoff', status: 'unresolved', quote: '着手時期は未定である。',
    }],
  };

  // The TRUNCATED source: every retrieval check passes, and the quote does not.
  const cut = deck({
    sources: { kickoff: truncated }, raw: { kickoff: fetchedPage('kickoff', truncated) }, ledger,
  });
  assert.deepEqual(checkSources(cut.p).problems, [],
    'the source gate still cannot see a tail that never arrived - that is exactly why the quote check matters');
  const cutProblems = checkLedger(cut.p).problems;
  assert.equal(cutProblems.length, 1);
  assert.match(cutProblems[0].message, /d-09/);

  // The COMPLETE source: the same quote verifies.
  const whole = deck({
    sources: { kickoff: full }, raw: { kickoff: fetchedPage('kickoff', full) }, ledger,
  });
  assert.deepEqual(checkLedger(whole.p).problems, []);
});
