import { loadSchema } from '../schema.js';
import { DeckError, EXIT, usage } from '../util/fail.js';

/**
 * `deck schema <name>` - PRINT THE SHAPE, instead of guessing at it.
 *
 * The PO wrote a file with ten candidate keys in it and binary-searched the
 * gates to find out which ones were accepted. That is a real afternoon spent
 * on a question the tool already knows the answer to: `ledger.json` wants
 * `source_id` and `note`, not `source` and `statement`; an agenda item is
 * `id`, `heading`, `why` and `ledger_refs`; an EXCLUDED item is `ledger_refs`
 * and `reason`, which are different words for a neighbouring idea and exactly
 * the kind of thing nobody guesses right.
 *
 * The refusals themselves were never the problem - they name the unknown key
 * and say why an unknown key is refused, which is why the search converged at
 * all. What was missing was a way to ASK.
 *
 * WHY AN EXAMPLE AND NOT JUST THE SCHEMA.
 *
 * A JSON Schema answers "is this valid" precisely and "what do I write" badly:
 * the required keys are in one list, their types in another object, and the
 * nested shapes behind `$ref`. The example is a valid document of that shape
 * with every optional field present, which is the form the question is
 * actually asked in. Both are printed, example first, because the example is
 * what gets copied.
 *
 * The examples are VALIDATED against their own schemas by
 * test/unit/schema.test.js, so a schema change that makes the example wrong
 * fails the suite rather than teaching the next person a shape deck refuses.
 */

/**
 * The documents a person writes by hand, with the file each lives in.
 *
 * Deliberately not every schema in schemas/: theme.schema.json describes a
 * file only a theme author touches and lint-report.schema.json describes
 * output. These six are the ones an agent and a PO have to produce.
 */
const DOCUMENTS = {
  sources: {
    schema: 'sources.schema.json',
    file: 'sources/manifest.json',
    blurb: 'What was fetched, and whether all of it arrived.',
  },
  ledger: {
    schema: 'ledger.schema.json',
    file: 'ledger.json',
    blurb: 'What was extracted from the sources, each entry quoting its source verbatim.',
  },
  agenda: {
    schema: 'agenda.schema.json',
    file: 'agenda.json',
    blurb: 'The proposed agenda, and what was deliberately left off it.',
  },
  storyboard: {
    schema: 'storyboard.schema.json',
    file: 'storyboard.yaml',
    blurb: 'The slides. Every text field is verbatim.',
  },
  deck: {
    schema: 'deck.schema.json',
    file: 'deck.yaml',
    blurb: 'What changes per deck: project, audience, theme, output.',
  },
  assets: {
    schema: 'asset-manifest.schema.json',
    file: 'assets/manifest.json',
    blurb: 'Imported illustrations, by slot, with the SHA-256 of the bytes.',
  },
};

/**
 * A valid document of each shape, with every optional field filled in.
 *
 * These are checked against their own schemas in the test suite. If you change
 * a schema and do not change these, the suite tells you - which is the point:
 * an example that does not validate is worse than no example, because it is
 * believed.
 */
export const EXAMPLES = {
  sources: {
    schema: 'deck.sources/1',
    sources: [{
      id: 'notion-kickoff',
      kind: 'notion',
      ref: 'https://www.notion.so/workspace/Kickoff-abc123',
      retrieved_at: '2026-10-14T09:30:00Z',
      text_file: 'sources/notion-kickoff.txt',
      raw_file: 'sources/raw/notion-kickoff.json',
      complete: true,
      block_count: 48,
      page_ids: ['abc123'],
      block_ids: ['def456'],
      pagination: { requests: 2, has_more: false },
      missing: [{ what: '添付のPDF', why: 'MCP からは本文のみ取得でき、添付は取得できなかった' }],
    }],
  },
  ledger: {
    schema: 'deck.ledger/1',
    extracted_at: '2026-10-14T09:40:00Z',
    entries: [
      {
        id: 'l-01',
        kind: 'decision',
        source_id: 'notion-kickoff',
        block_id: 'def456',
        quote: '開始時期については次回までに決める',
        status: 'unresolved',
        owner: null,
        due: '次回',
        note: '四月の稼働から逆算すると、ここが決まらないと動けない',
        conflicts_with: [],
        source_omits: ['owner'],
      },
      {
        id: 'l-02',
        kind: 'number',
        source_id: 'notion-kickoff',
        quote: 'オンライン申請率は85%',
        value: '85',
        unit: '%',
        period: '2026年度上半期',
        note: '村全体の数字であり、特定の層の根拠には使えない',
      },
    ],
  },
  agenda: {
    schema: 'deck.agenda/1',
    meeting: {
      name: '10/16 定例',
      when: '10月16日',
      purpose: '開始時期を決める',
      audience: '総務課長、情報システム担当',
    },
    items: [{
      id: 'a-01',
      heading: '開始時期の確認',
      why: 'まだ決まっておらず、四月の稼働に直接きいてくる',
      wants: 'decision',
      ledger_refs: ['l-01'],
    }],
    excluded: [{
      ledger_refs: ['l-02'],
      reason: '村全体の数字で、この会議で扱う層の根拠にはならない',
    }],
    missing_evidence: [{ what: '前回の議事録', why: '共有されておらず確認できていない' }],
  },
};

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function schemaCommand(argv) {
  const json = argv.includes('--json');
  const schemaOnly = argv.includes('--schema');
  const exampleOnly = argv.includes('--example');
  const names = argv.filter((a) => !a.startsWith('--'));

  if (schemaOnly && exampleOnly) {
    usage('deck schema: --schema and --example are mutually exclusive; the default prints both');
  }
  if (names.length === 0) {
    process.stdout.write(list());
    return EXIT.OK;
  }
  if (names.length > 1) usage(`deck schema takes one name, got ${names.length}: ${names.join(', ')}`);

  const name = names[0];
  const doc = DOCUMENTS[name];
  if (!doc) {
    throw new DeckError(
      `deck has no document called "${name}"`,
      EXIT.USAGE,
      [`Known: ${Object.keys(DOCUMENTS).join(', ')}`, '', 'Run `deck schema` with no argument for the list.'],
    );
  }

  const schema = loadSchema(doc.schema);
  const example = EXAMPLES[name] || null;

  if (json) {
    process.stdout.write(`${JSON.stringify({ name, file: doc.file, schema, example }, null, 2)}\n`);
    return EXIT.OK;
  }

  if (!schemaOnly) {
    process.stdout.write(`${doc.file}  -  ${doc.blurb}\n\n`);
    if (example) {
      process.stdout.write('A valid document of this shape, with every optional field present:\n\n');
      process.stdout.write(`${indent(JSON.stringify(example, null, 2))}\n\n`);
    } else {
      process.stdout.write(`There is no worked example for ${name}; \`deck gate init\` writes a commented one.\n\n`);
    }
  }
  if (!exampleOnly) {
    process.stdout.write('The schema deck validates it against:\n\n');
    process.stdout.write(`${indent(JSON.stringify(schema, null, 2))}\n`);
  }
  // EVERY KEY IS REFUSED UNLESS IT IS LISTED. Worth saying out loud next to
  // the shape, because it is why a near-miss is an error rather than a
  // silently dropped field - and why guessing at a key name does not work.
  if (!exampleOnly) {
    process.stdout.write('\nEvery one of these files sets additionalProperties: false. An unknown key\n');
    process.stdout.write('is REFUSED and named, never accepted and dropped, because a typo in a key\n');
    process.stdout.write('would otherwise lose content silently.\n');
  }
  return EXIT.OK;
}

function list() {
  const rows = Object.entries(DOCUMENTS).map(([name, d]) => `  ${name.padEnd(12)} ${d.file.padEnd(22)} ${d.blurb}`);
  return [
    'deck schema <name>  -  the shape of a file deck reads, with a worked example.',
    '',
    ...rows,
    '',
    'Options:',
    '  --example   just the worked example',
    '  --schema    just the JSON Schema',
    '  --json      both, as one JSON object',
    '',
  ].join('\n');
}

/** @param {string} text */
function indent(text) {
  return text.split('\n').map((l) => `  ${l}`).join('\n');
}
