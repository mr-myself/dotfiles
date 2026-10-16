import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PNG } from 'pngjs';
import YAML from 'yaml';
import { DECK_BIN, DECK_HOME, rm, tempDir, gateArgs } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const { pdfPageCount, pngSize } = await import('../../src/render/raster.js');

/**
 * THE END-TO-END FIXTURE.
 *
 * A small Japanese deck through init -> validate -> prompts -> import ->
 * render -> lint -> export, asserting what the PO actually depends on: the
 * PDF's page count and order, the PNG dimensions, that the imported asset's
 * hash survives to the output, and that every verbatim string comes back
 * character for character.
 */

const STATE = tempDir('deck-e2e-state');
const ROOT = tempDir('deck-e2e');
const DECK = path.join(ROOT, 'プロジェクト 資料');  // a space AND Japanese, on purpose

/** @param {string[]} args @param {string} [cwd] */
function deck(args, cwd = DECK) {
  try {
    const stdout = execFileSync(DECK_BIN, gateArgs(args), {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DECK_STATE_ROOT: STATE },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? -1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

/**
 * Verbatim strings the deck must reproduce character for character.
 *
 * Invented content about a fictional place. The theme was measured from a real
 * client deck, and none of that deck's words appear here or anywhere in this
 * repository.
 */
const TEXT = {
  deckTitle: '架空温泉郷　滞在体験のご提案',
  coverTitle: 'まち全体を、ひとつの宿に。',
  coverSubtitle: '分散型宿泊という考え方',
  agendaTitle: '本日の目次',
  agendaItems: ['現状の整理', 'ご提案の内容', '次のステップ'],
  dividerTitle: '現状の整理',
  cardsTitle: '三つの論点',
  cards: [
    { heading: '回遊性', body: '点在する店舗が線でつながっていない。' },
    { heading: '受け入れ', body: '一次対応の窓口が宿ごとに分かれている。' },
    { heading: '発信', body: '季節ごとの魅力が届いていない。' },
  ],
  tableTitle: '比較表',
  tableHeadings: ['項目', '従来', 'アルベルゴ・ディフーゾ'],
  tableRows: [
    ['フロント', '宿ごと', 'まちに一つ'],
    ['回遊', '限定的', 'まち全体'],
  ],
  tableNote: '※ 表の数値は2026年3月時点のもの。',
  statementTitle: '滞在を、まちの時間にする。',
  statementBody: '一つの宿に機能を集めるのではなく、地域に点在するお店やコンテンツをつなぎます。',
  footer: '三つの論点はいずれも独立して進められる。',
};

function storyboardYaml() {
  return YAML.stringify({
    schema: 'deck.storyboard/1',
    title: TEXT.deckTitle,
    slides: [
      {
        id: 'cover',
        page_type: 'cover',
        purpose: '資料の主題と対象を一目で伝える',
        section_label: 'ご提案',
        title: TEXT.coverTitle,
        subtitle: TEXT.coverSubtitle,
        slots: [{
          id: 'cover-art',
          brief: '山あいの温泉郷と湯けむりの水彩イラスト。文字は一切入れない。',
          width_px: 760,
          height_px: 941,
        }],
        source_refs: ['sources/hearing.md'],
      },
      {
        id: 'agenda',
        page_type: 'agenda',
        purpose: '全体の流れを示す',
        section_label: '本日の流れ',
        title: TEXT.agendaTitle,
        subtitle: null,
        agenda: { items: TEXT.agendaItems, active: 1 },
      },
      {
        id: 'ch-01',
        page_type: 'section-divider',
        purpose: '第1章の始まりを示す',
        section_label: '第01章',
        title: TEXT.dividerTitle,
        subtitle: 'いま見えていること',
      },
      {
        id: 'three-points',
        page_type: 'standard-3col',
        purpose: '三つの論点を並べて比較できるようにする',
        section_label: '現状の整理',
        title: TEXT.cardsTitle,
        subtitle: 'それぞれ独立して検討できる',
        body: [{
          kind: 'cards',
          cards: [
            { heading: TEXT.cards[0].heading, body: TEXT.cards[0].body, icon: 'teal' },
            { heading: TEXT.cards[1].heading, body: TEXT.cards[1].body, icon: 'orange' },
            { heading: TEXT.cards[2].heading, body: TEXT.cards[2].body, icon: 'teal' },
          ],
        }],
        footer: { label: '要点', text: TEXT.footer },
      },
      {
        id: 'comparison',
        page_type: 'table',
        purpose: '従来との違いを表で示す',
        section_label: 'ご提案の内容',
        title: TEXT.tableTitle,
        subtitle: null,
        table: {
          columns: TEXT.tableHeadings.map((heading, i) => ({ heading, width_fr: i === 0 ? 0.6 : 1 })),
          rows: TEXT.tableRows,
          note: TEXT.tableNote,
        },
      },
      {
        id: 'close',
        page_type: 'statement',
        purpose: '提案の核心を一文で置く',
        // A statement page requires its eyebrow: it is the framing that says
        // where in the deck this pause is happening, and without it the page
        // reads as a title slide that wandered in.
        section_label: 'ここが要点',
        title: TEXT.statementTitle,
        subtitle: null,
        body: [{ kind: 'statement', text: TEXT.statementBody }],
      },
    ],
  });
}

const SLIDE_ORDER = ['cover', 'agenda', 'ch-01', 'three-points', 'comparison', 'close'];

describe('end to end: a small Japanese deck, on a path with a space and Japanese characters', () => {
  /** @type {string} */
  let assetSha;

  before(() => {
    const r = deck(['init', DECK], ROOT);
    assert.equal(r.code, 0, r.stderr);
    fs.writeFileSync(path.join(DECK, 'storyboard.yaml'), storyboardYaml());
    fs.writeFileSync(path.join(DECK, 'sources', 'hearing.md'), '# ヒアリング記録\n');
  });

  after(() => {
    rm(ROOT);
    rm(STATE);
  });

  test('the workspace path really does contain a space and Japanese characters', () => {
    assert.ok(DECK.includes(' '));
    assert.ok(/[぀-ヿ一-龯]/.test(DECK));
  });

  test('validate accepts the deck and reports the intentionally absent subtitles', () => {
    const r = deck(['validate']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /6 slide\(s\) OK/);
    // `subtitle: null` on three slides, reported rather than assumed.
    assert.match(r.stdout, /intentionally absent subtitles[^\n]*agenda/);
    assert.match(r.stdout, /intentionally absent subtitles[^\n]*comparison/);
    assert.match(r.stdout, /intentionally absent subtitles[^\n]*close/);
  });

  test('prompts are emitted and are paste-ready', () => {
    const r = deck(['prompts']);
    assert.equal(r.code, 0, r.stderr);
    const md = fs.readFileSync(path.join(DECK, 'out', 'prompts.md'), 'utf8');

    assert.match(md, /### `cover-art` - slide `cover`/);
    assert.match(md, /760x941 px（アスペクト比 760:941）/);
    assert.match(md, /山あいの温泉郷と湯けむりの水彩イラスト/);
    assert.match(md, /資料の主題と対象を一目で伝える/, 'the slide purpose must reach the prompt');
    assert.match(md, /Put NO text, letters, numbers/, 'the no-text instruction is mandatory');
    assert.match(md, /Soft watercolour illustration/, 'the style brief must be inlined, not referenced');
    // The brief's own notes to theme authors must NOT reach ChatGPT. A
    // line-by-line comment filter once pasted the tail of a multi-line HTML
    // comment into the middle of a prompt.
    assert.ok(!md.includes('<!--'), 'no HTML comment may survive into a prompt');
    assert.ok(!md.includes('-->'), 'no HTML comment may survive into a prompt');
    assert.ok(!md.includes('written as prompt text rather than as documentation'),
      'the brief\'s note to theme authors must be stripped');
    assert.ok(!md.includes('# watercolor - illustration style brief'),
      'the brief\'s own heading must be stripped');
    // Qualified: a slot id names a POSITION on a page type, so the import
    // command has to say which slide's picture this is.
    assert.match(md, /deck gate assets import cover:cover-art/, 'the import command must be printed ready to copy');
    assert.match(md, /#03224F/, 'the palette goes in the prompt as hex, in prose');
    assert.match(md, /Reference images to attach/);
  });

  test('a single slot can be sent to stdout for piping', () => {
    const r = deck(['prompts', '--slot', 'cover-art']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /deck gate assets import cover:cover-art/);
    assert.ok(!r.stdout.includes('## Illustration prompts'), 'one slot means one entry, not the whole file');
  });

  test('an unknown slot is a usage error naming the real ones', () => {
    const r = deck(['prompts', '--slot', 'nope']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cover-art/);
  });

  test('an illustration is imported and its hash recorded', () => {
    const src = path.join(ROOT, 'chatgpt から の 画像.png');
    const png = new PNG({ width: 380, height: 470 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 180; png.data[i + 1] = 210; png.data[i + 2] = 215; png.data[i + 3] = 255;
    }
    fs.writeFileSync(src, PNG.sync.write(png));

    const r = deck(['assets', 'import', 'cover-art', src]);
    assert.equal(r.code, 0, r.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(DECK, 'assets', 'manifest.json'), 'utf8'));
    assetSha = manifest.assets[0].sha256;
    assert.match(assetSha, /^[0-9a-f]{64}$/);
    assert.deepEqual(manifest.assets[0].pixel_size, { width: 380, height: 470 });
  });

  test('a preview render is allowed with nothing approved', () => {
    const r = deck(['render']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /6 page\(s\)/);
  });

  test('--release is REFUSED before approval, and says what to do', () => {
    const r = deck(['render', '--release']);
    assert.equal(r.code, 1, 'a refused release is a completed process with a failing verdict');
    assert.match(r.stderr, /never been approved/);
    assert.match(r.stderr, /deck approve content/);
  });

  test('THE PDF PAGE COUNT AND ORDER MATCH THE STORYBOARD', () => {
    const pdf = path.join(DECK, 'out', 'deck.pdf');
    assert.equal(pdfPageCount(pdf), SLIDE_ORDER.length);

    // ORDER IS READ OUT OF THE PDF ITSELF.
    //
    // This used to take the order from the combined HTML, which proves the
    // DOM order and nothing about the document that ships. Each page is
    // extracted separately and identified by text that appears on exactly one
    // slide, so a reordered, duplicated or dropped page would be caught.
    const marker = {
      cover: TEXT.coverTitle,
      agenda: TEXT.agendaTitle,
      'ch-01': 'いま見えていること',
      'three-points': TEXT.cardsTitle,
      comparison: TEXT.tableNote,
      close: TEXT.statementTitle,
    };
    SLIDE_ORDER.forEach((id, i) => {
      const text = execFileSync('pdftotext', ['-f', String(i + 1), '-l', String(i + 1), pdf, '-'], { encoding: 'utf8' });
      const normalised = text.replace(/\s+/g, '');
      assert.ok(
        normalised.includes(marker[id].replace(/\s+/g, '')),
        `PDF page ${i + 1} should be slide "${id}" (looking for "${marker[id]}") but held: ${text.trim().slice(0, 120)}`,
      );
      // ...and must NOT hold another slide's marker, so a duplicated page is
      // caught as well as a reordered one.
      for (const [otherId, otherText] of Object.entries(marker)) {
        if (otherId === id) continue;
        assert.ok(
          !normalised.includes(otherText.replace(/\s+/g, '')),
          `PDF page ${i + 1} ("${id}") also contains slide "${otherId}"'s text`,
        );
      }
    });

    // The folio on each page is derived from its index, which is independent
    // corroboration of the order from a different mechanism.
    SLIDE_ORDER.forEach((id, i) => {
      const text = execFileSync('pdftotext', ['-f', String(i + 1), '-l', String(i + 1), pdf, '-'], { encoding: 'utf8' });
      assert.ok(text.includes(`${i + 1}/${SLIDE_ORDER.length}`),
        `PDF page ${i + 1} ("${id}") should carry the folio ${i + 1}/${SLIDE_ORDER.length}`);
    });

    for (const id of SLIDE_ORDER) {
      assert.ok(fs.existsSync(path.join(DECK, 'out', 'html', `${id}.html`)), `missing out/html/${id}.html`);
    }
  });

  test('the folio is DERIVED, so page n of N is correct on every page', () => {
    const geometry = JSON.parse(fs.readFileSync(path.join(DECK, 'out', 'geometry.json'), 'utf8'));
    geometry.slides.forEach((slide, i) => {
      const folio = slide.elements.find((e) => e.id === 'page-number');
      assert.ok(folio, `slide ${slide.slide_id} has no folio`);
      assert.equal(folio.text, `${i + 1}/6`);
    });
  });

  test('EVERY PNG HAS THE SAME, EXPECTED DIMENSIONS', () => {
    const sizes = SLIDE_ORDER.map((_, i) => {
      const f = path.join(DECK, 'out', 'png', `${String(i + 1).padStart(3, '0')}.png`);
      assert.ok(fs.existsSync(f), `missing ${f}`);
      return pngSize(f);
    });
    for (const s of sizes) {
      assert.equal(s.width, 1672 * 2, 'the PNG width is exactly 2x the authored canvas');
      // Height carries a few pixels of slack: Chrome quantises the PDF page
      // height. What matters is that every page agrees.
      assert.ok(Math.abs(s.height - 941 * 2) <= 4, `height ${s.height}`);
    }
    assert.equal(new Set(sizes.map((s) => `${s.width}x${s.height}`)).size, 1);
  });

  test('VERBATIM CONTENT SURVIVES init -> render, character for character', () => {
    // Read back what the DOM actually holds, so this proves the rendered text
    // equals the storyboard's text - not that two copies of a template match.
    const geometry = JSON.parse(fs.readFileSync(path.join(DECK, 'out', 'geometry.json'), 'utf8'));
    const byId = {};
    for (const slide of geometry.slides) {
      byId[slide.slide_id] = Object.fromEntries(slide.elements.map((e) => [e.id, e.text]));
    }

    assert.equal(byId.cover.title, TEXT.coverTitle);
    assert.equal(byId.cover.subtitle, TEXT.coverSubtitle);
    assert.equal(byId.agenda.title, TEXT.agendaTitle);
    TEXT.agendaItems.forEach((item, i) => {
      assert.equal(byId.agenda[`agenda-text-${i + 1}`], item);
    });
    assert.equal(byId['ch-01'].title, TEXT.dividerTitle);
    assert.equal(byId['three-points'].title, TEXT.cardsTitle);
    TEXT.cards.forEach((card, i) => {
      assert.equal(byId['three-points'][`card-heading-${i + 1}`], card.heading);
      assert.equal(byId['three-points'][`card-body-${i + 1}`], card.body);
    });
    assert.equal(byId['three-points']['footer-text'], TEXT.footer);
    assert.equal(byId.comparison.title, TEXT.tableTitle);
    TEXT.tableHeadings.forEach((h, i) => assert.equal(byId.comparison[`th-${i + 1}`], h));
    TEXT.tableRows.forEach((row, r) => {
      row.forEach((cell, c) => assert.equal(byId.comparison[`td-${r + 1}-${c + 1}`], cell));
    });
    assert.equal(byId.comparison['table-note'], TEXT.tableNote);
    assert.equal(byId.close.title, TEXT.statementTitle);
    assert.equal(byId.close['statement-body'], TEXT.statementBody);
  });

  test('a slide whose subtitle is null renders NO subtitle element at all', () => {
    const geometry = JSON.parse(fs.readFileSync(path.join(DECK, 'out', 'geometry.json'), 'utf8'));
    for (const id of ['agenda', 'comparison', 'close']) {
      const slide = geometry.slides.find((s) => s.slide_id === id);
      assert.equal(slide.elements.find((e) => e.id === 'subtitle'), undefined,
        `${id} must not carry an empty subtitle box; it would shift the title baseline`);
    }
    const cover = geometry.slides.find((s) => s.slide_id === 'cover');
    assert.ok(cover.elements.find((e) => e.id === 'subtitle'));
  });

  test('THE IMPORTED ASSET\'S SOURCE HASH SURVIVES TO THE OUTPUT', () => {
    const geometry = JSON.parse(fs.readFileSync(path.join(DECK, 'out', 'geometry.json'), 'utf8'));
    assert.equal(geometry.assets['cover:cover-art'].sha256, assetSha);
    const cover = geometry.slides.find((s) => s.slide_id === 'cover');
    const img = cover.images.find((i) => i.slot === 'cover-art');
    assert.ok(img, 'the slot image must be measured');
    assert.equal(img.complete, true);
    assert.deepEqual(img.natural, { w: 380, h: 470 });
    // Aspect-preserving CONTAINMENT: the PO's file is fitted, never cropped.
    assert.equal(img.object_fit, 'contain');
  });

  test('lint passes on the deck the theme produced', () => {
    const r = deck(['lint']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(DECK, 'out', 'lint', 'report.json'), 'utf8'));
    assert.equal(report.process, 'ok');
    assert.equal(report.verdict, 'pass');
    assert.equal(report.counts.blocking, 0);
    assert.equal(report.counts.slides, 6);
    // Asserted against the rule table rather than a literal, so adding a
    // rule does not need this number edited here as well.
    assert.equal(report.counts.rules_run, report.counts.rules_total);
    assert.ok(report.counts.rules_total >= 10);
    // The process status file is the PROCESS axis and says 0 either way.
    assert.equal(fs.readFileSync(path.join(DECK, 'out', 'lint', 'report-status.txt'), 'utf8').trim(), '0');
    assert.ok(report.honest_limits.length >= 4);
  });

  test('approve records the revision, and --release then succeeds', () => {
    const a = deck(['approve', 'content']);
    assert.equal(a.code, 0, a.stderr);
    const digest = a.stdout.match(/digest:\s+([0-9a-f]{64})/)[1];

    const r = deck(['render', '--release']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const geometry = JSON.parse(fs.readFileSync(path.join(DECK, 'out', 'geometry.json'), 'utf8'));
    assert.equal(geometry.release, true);
    assert.equal(geometry.content_digest, digest);
  });

  test('CHANGING ONE WORD INVALIDATES THE RELEASE, AND THE MESSAGE SAYS WHAT CHANGED', () => {
    const file = path.join(DECK, 'storyboard.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      // The TITLE line specifically. `三つの論点` also opens this slide's
      // `purpose`, and a bare string replace would have edited that instead -
      // which is deliberately NOT part of the content digest, so the release
      // would have been allowed and this test would have passed for the wrong
      // reason.
      const after = before.replace(`title: ${TEXT.cardsTitle}\n`, 'title: 四つの論点\n');
      assert.notEqual(after, before, 'the edit must actually change the file');
      fs.writeFileSync(file, after);
      const r = deck(['render', '--release']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /no longer matches the approved content/);
      assert.match(r.stderr, /slide three-points: title changed/);
      assert.match(r.stderr, /三つの論点/, 'the approved wording must be shown');
      assert.match(r.stderr, /四つの論点/, 'the current wording must be shown');
      assert.match(r.stderr, /deck approve content/);

      // ...while a PREVIEW render is still allowed, so the PO can look.
      assert.equal(deck(['render']).code, 0);
    } finally {
      fs.writeFileSync(file, before);
      deck(['render', '--release']);
    }
  });

  test('changing a slide\'s PURPOSE does not invalidate content approval', () => {
    // `purpose` is authoring intent that feeds the illustration prompts. It is
    // never rendered, so it is deliberately outside the content digest:
    // approval covers the words that SHIP.
    const file = path.join(DECK, 'storyboard.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      const after = before.replace('purpose: 三つの論点を並べて比較できるようにする', 'purpose: 論点の整理');
      assert.notEqual(after, before);
      fs.writeFileSync(file, after);
      const r = deck(['render', '--release']);
      assert.equal(r.code, 0, r.stderr + r.stdout);
    } finally {
      fs.writeFileSync(file, before);
    }
  });

  test('CHANGING ONLY A THEME TOKEN does NOT invalidate content approval', () => {
    const file = path.join(DECK, 'deck.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, `${before}\ntheme_overrides:\n  colors:\n    page_bg: { hex: "#FFFFFF", use: "overridden" }\n`);
      const r = deck(['render', '--release']);
      assert.equal(r.code, 0, r.stderr + r.stdout);
    } finally {
      // Restoring the theme makes the geometry just rendered STALE - it
      // describes the overridden layout. The render fingerprint detects
      // exactly that, so this test has to re-render rather than leave the
      // workspace inconsistent for whatever runs next.
      fs.writeFileSync(file, before);
      assert.equal(deck(['render']).code, 0);
    }
  });

  test('export verifies the deliverable and reports the lint verdict', () => {
    deck(['lint']);
    const r = deck(['export']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /6 page\(s\)/);
    assert.match(r.stdout, /3344x188/);
    for (const id of SLIDE_ORDER) assert.match(r.stdout, new RegExp(id));
    assert.match(r.stdout, /lint\s+process ok, verdict pass/);

    const report = JSON.parse(fs.readFileSync(path.join(DECK, 'out', 'export.json'), 'utf8'));
    assert.equal(report.pdf.pages, 6);
    assert.equal(report.png.length, 6);
    assert.deepEqual(report.png.map((p) => p.slide_id), SLIDE_ORDER);
    assert.equal(report.assets['cover:cover-art'].sha256, assetSha,
      'the hash the PO handed over survives all the way into the export report');
  });

  test('status re-derives the phase from disk', () => {
    const r = deck(['status', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.phase_is_derived, true);
    assert.equal(s.approvals.content.matches, true);
    assert.equal(s.slides, 6);
    assert.equal(s.slots.find((x) => x.slot_id === 'cover-art').state, 'filled');
    assert.equal(s.last_lint.verdict, 'pass');
  });

  test('DECK PROMPTS --SINGLE emits one pasteable brief for the whole deck', () => {
    const r = deck(['prompts', '--single']);
    assert.equal(r.code, 0, r.stderr);
    const md = fs.readFileSync(path.join(DECK, 'out', 'prompts-single.md'), 'utf8');

    // The style is stated ONCE, at the top, before any image.
    const styleAt = md.indexOf('Soft watercolour illustration');
    const firstImageAt = md.indexOf('IMAGE 1 of');
    assert.ok(styleAt > 0 && firstImageAt > styleAt, 'the style must come before the images');
    assert.equal(md.split('Soft watercolour illustration').length - 1, 1, 'the style is stated exactly once');

    // One at a time, in order, in this conversation, style held.
    assert.match(md, /ONE AT A TIME/);
    assert.match(md, /Generate IMAGE 1 only/);
    assert.match(md, /holding the style identical|style identical to IMAGE 1/);
    assert.match(md, /this one conversation/);

    // Per slot: id, slide, where, size, ratio, what to depict.
    assert.match(md, /IMAGE 1 of 1/);
    assert.match(md, /slide "cover"/);
    assert.match(md, /760 x 941 px, aspect ratio 760:941/);
    assert.match(md, /against the right edge/);
    assert.match(md, /野沢の谷あい|山あいの温泉郷と湯けむりの水彩イラスト/);
    assert.match(md, /資料の主題と対象を一目で伝える/);

    // The no-text rule: once prominently, then restated per slot.
    assert.match(md, /PUT NO TEXT IN THE IMAGE/);
    assert.match(md, /\(No text, letters, numbers or logos inside this image\.\)/);

    // A filename convention, and the import commands that use it.
    // The slide is in the filename, so a deck with four three-column slides
    // gets twelve distinct names rather than four repeated ones.
    assert.match(md, /file name: 01-cover-cover-art\.png/);
    assert.match(md, /01-cover-cover-art\.png   ->  cover:cover-art/);

    // Readable as PLAIN TEXT: no markdown tables or headings carrying meaning.
    assert.ok(!md.includes('|---'), 'no markdown tables');
    assert.ok(!/^#{1,6} /m.test(md), 'no markdown headings carrying structure');
  });

  test('--single and --slot are mutually exclusive, and it says so', () => {
    const r = deck(['prompts', '--single', '--slot', 'cover-art']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /do nothing together/);
    assert.match(r.stderr, /Pick one/);
  });

  test('--single honours --out', () => {
    const target = path.join(DECK, 'out', 'elsewhere.md');
    const r = deck(['prompts', '--single', '--out', target]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(target));
    assert.match(fs.readFileSync(target, 'utf8'), /IMAGE 1 of 1/);
  });

  test('A REUSE_UNCHANGED SLOT IS NEVER OFFERED FOR GENERATION', () => {
    const file = path.join(DECK, 'storyboard.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      // Give the agenda slide a real-photo slot the theme can position.
      const after = before.replace(
        '    brief: 野沢の谷あいと湯けむりの水彩イラスト。文字は一切入れない。',
        '    brief: 野沢の谷あいと湯けむりの水彩イラスト。文字は一切入れない。',
      ).replace(
        /(\n  - id: agenda\n)/,
        `$1    slots:\n      - id: agenda-art\n        brief: お客様から支給された実写真。そのまま使う。\n        width_px: 600\n        height_px: 800\n        reuse_unchanged: true\n`,
      );
      assert.notEqual(after, before, 'the fixture edit must apply');
      fs.writeFileSync(file, after);
      assert.equal(deck(['validate']).code, 0, deck(['validate']).stdout);

      // --slot must refuse it outright.
      const one = deck(['prompts', '--slot', 'agenda-art']);
      assert.equal(one.code, 2, 'naming a reuse_unchanged slot must be refused');
      assert.match(one.stderr, /marked reuse_unchanged/);
      assert.match(one.stderr, /never regenerated/);
      assert.ok(!one.stdout.includes('Use case:'), 'no generation prompt may be emitted');

      // --single must list it separately, not as something to generate.
      assert.equal(deck(['prompts', '--single']).code, 0);
      const md = fs.readFileSync(path.join(DECK, 'out', 'prompts-single.md'), 'utf8');
      assert.match(md, /NOT FOR YOU TO GENERATE/);
      const notForYou = md.slice(md.indexOf('NOT FOR YOU TO GENERATE'));
      assert.match(notForYou, /agenda-art/);
      const toGenerate = md.slice(md.indexOf('THE IMAGES'), md.indexOf('NOT FOR YOU TO GENERATE'));
      assert.ok(!toGenerate.includes('agenda-art'), 'it must not appear among the images to generate');
      assert.match(md, /THE IMAGES — 1 in total/, 'only the one real illustration counts');

      // The combined per-slot file excludes it too.
      assert.equal(deck(['prompts']).code, 0);
      const all = fs.readFileSync(path.join(DECK, 'out', 'prompts.md'), 'utf8');
      const generated = all.slice(all.indexOf('## Illustration prompts'));
      assert.ok(!generated.includes('### `agenda-art`'));
    } finally {
      fs.writeFileSync(file, before);
      deck(['render']);
      deck(['lint']);
    }
  });

  test('NOTHING THE PO PASTES CARRIES AN ABSOLUTE LOCAL PATH', () => {
    // prompts.md and prompts-single.md are shared with a third party, and an
    // absolute path carries the user's name and directory layout.
    assert.equal(deck(['prompts']).code, 0);
    assert.equal(deck(['prompts', '--single']).code, 0);
    for (const f of ['prompts.md', 'prompts-single.md']) {
      const text = fs.readFileSync(path.join(DECK, 'out', f), 'utf8');
      assert.ok(!text.includes(process.env.HOME), `${f} leaks the home directory`);
      assert.ok(!text.includes(DECK), `${f} leaks the workspace path`);
    }
    // geometry.json is an artifact too.
    const geo = fs.readFileSync(path.join(DECK, 'out', 'geometry.json'), 'utf8');
    assert.ok(!geo.includes(process.env.HOME), 'geometry.json leaks the home directory');
    assert.ok(!geo.includes('file:///'), 'geometry.json carries an absolute file URL');
  });

  test('AN UNUSABLE PNG SCALE IS REFUSED with the usable set named', () => {
    const file = path.join(DECK, 'deck.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, before.replace('png_scale: 2', 'png_scale: 1.1'));
      const r = deck(['validate']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /png_scale/);
    } finally {
      fs.writeFileSync(file, before);
    }
  });

  test('A FRACTIONAL BUT USABLE PNG SCALE renders at the right size', () => {
    const file = path.join(DECK, 'deck.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, before.replace('png_scale: 2', 'png_scale: 1.5'));
      const r = deck(['render']);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /144 dpi, 1\.5x/);
      const size = pngSize(path.join(DECK, 'out', 'png', '001.png'));
      assert.equal(size.width, Math.round(1672 * 1.5));
      assert.ok(Math.abs(size.height - Math.round(941 * 1.5)) <= 4, `height ${size.height}`);
    } finally {
      fs.writeFileSync(file, before);
      assert.equal(deck(['render']).code, 0);
      deck(['lint']);
    }
  });

  test('an unimplemented page type is REFUSED BY NAME, never substituted', () => {
    const file = path.join(DECK, 'storyboard.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      // `media` rather than `timeline`: timeline is an implemented page type
      // now. What this test is about is that a name deck does NOT implement is
      // refused by that name with its reason, never quietly swapped for a
      // layout the author did not ask for.
      fs.writeFileSync(file, before.replace('page_type: table', 'page_type: media'));
      const v = deck(['validate']);
      assert.equal(v.code, 1);
      assert.match(v.stdout, /page_type "media" is not implemented/);
      assert.match(v.stdout, /reserved image frame/);

      const r = deck(['render']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /media/);
    } finally {
      fs.writeFileSync(file, before);
    }
  });

  test('PPTX is refused by name rather than silently ignored', () => {
    const file = path.join(DECK, 'deck.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, before.replace('formats: [pdf, png]', 'formats: [pdf, pptx]'));
      const r = deck(['validate']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /output format "pptx" is not implemented/);
    } finally {
      fs.writeFileSync(file, before);
    }
  });

  test('lint refuses geometry from a different render rather than reporting on a stale page', () => {
    const file = path.join(DECK, 'storyboard.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, before.replace(TEXT.statementTitle, '別の結び。'));
      const r = deck(['lint']);
      assert.equal(r.code, 3);
      assert.match(r.stderr, /measured geometry is from a different render/);
      assert.match(r.stderr, /content has changed too/);
    } finally {
      fs.writeFileSync(file, before);
    }
  });

  test('LINT REFUSES AFTER A LAYOUT-ONLY CHANGE, which the content digest cannot see', () => {
    // The gap the render fingerprint closes. A theme override moves every box
    // on every page while leaving the words untouched, so keying freshness off
    // the content digest marked stale geometry as current.
    const file = path.join(DECK, 'deck.yaml');
    const before = fs.readFileSync(file, 'utf8');
    try {
      assert.equal(deck(['render']).code, 0);
      assert.equal(deck(['lint']).code, 0, 'baseline must be clean');

      fs.writeFileSync(file, `${before}\ntheme_overrides:\n  canvas:\n    safe_margins_px: { left: 120, right: 50, top: 42, bottom: 35 }\n`);
      const r = deck(['lint']);
      assert.equal(r.code, 3, 'linting a layout that has changed since the render must be refused');
      assert.match(r.stderr, /different render/);
      assert.match(r.stderr, /WORDS are unchanged/, 'the message must say the content did NOT change');
    } finally {
      fs.writeFileSync(file, before);
      deck(['render']);
      deck(['lint']);
    }
  });

  test('A RE-RENDER INVALIDATES THE PREVIOUS LINT REPORT', () => {
    // It used to survive, so `deck export` reported a PASS that had inspected
    // a layout which no longer existed.
    assert.equal(deck(['render']).code, 0);
    assert.equal(deck(['lint']).code, 0);
    const reportFile = path.join(DECK, 'out', 'lint', 'report.json');
    assert.ok(fs.existsSync(reportFile));

    const deckYaml = path.join(DECK, 'deck.yaml');
    const before = fs.readFileSync(deckYaml, 'utf8');
    try {
      fs.writeFileSync(deckYaml, `${before}\ntheme_overrides:\n  colors:\n    page_bg: { hex: "#FFFEF8", use: "nudged" }\n`);
      assert.equal(deck(['render']).code, 0);
      assert.equal(fs.existsSync(reportFile), false,
        'the stale report must be gone, not left saying pass');

      const e = deck(['export']);
      assert.match(e.stdout, /lint\s+NEVER RUN/, 'export must say no verdict exists for this render');
    } finally {
      fs.writeFileSync(deckYaml, before);
      deck(['render']);
      deck(['lint']);
    }
  });
});
