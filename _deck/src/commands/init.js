import fs from 'node:fs';
import path from 'node:path';
import { resolveThemeDir } from '../theme/load.js';
import { EXIT, usage } from '../util/fail.js';
import { DeckError } from '../util/fail.js';
import { ensureDir, writeAtomic, writeJson } from '../util/fs.js';
import { paths, registerDeck } from '../workspace.js';

/**
 * `deck init <dir> [--theme watercolor]`
 *
 * Scaffolds a workspace with a storyboard that RENDERS AS WRITTEN. A template
 * full of placeholder prose would be a template the PO has to delete before
 * starting; a small real deck is something to edit.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function initCommand(argv) {
  let dir = null;
  let theme = 'watercolor';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--theme') {
      if (!argv[i + 1]) usage('--theme requires a theme name');
      theme = argv[i + 1];
      i += 1;
    } else if (a.startsWith('-')) {
      usage(`unknown option for deck init: ${a}`);
    } else if (dir === null) {
      dir = a;
    } else {
      usage('deck init takes exactly one directory');
    }
  }
  if (dir === null) usage('deck init requires a directory');

  // The theme has to exist before anything is written, so a typo'd --theme
  // does not leave a half-scaffolded workspace behind.
  resolveThemeDir(theme);

  const root = path.resolve(dir);
  if (fs.existsSync(root)) {
    const entries = fs.readdirSync(root).filter((f) => f !== '.DS_Store');
    if (entries.length > 0) {
      throw new DeckError(`${root} is not empty`, EXIT.ENVIRONMENT, [
        `It contains: ${entries.slice(0, 8).join(', ')}${entries.length > 8 ? ', ...' : ''}`,
        'deck init refuses to scaffold over existing files.',
      ]);
    }
  }
  if (fs.lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new DeckError(`${root} is a symlink`, EXIT.ENVIRONMENT, [
      'deck init refuses to write through a symlink.',
    ]);
  }

  const p = paths(root);
  ensureDir(root);
  ensureDir(p.sources);
  ensureDir(p.assets);
  ensureDir(p.state);
  ensureDir(p.approvals);

  writeAtomic(p.deckYaml, deckYaml(theme));
  writeAtomic(p.storyboard, storyboardYaml());
  writeJson(p.assetManifest, { schema: 'deck.assets/1', assets: [] });
  writeJson(p.stateJson, {
    schema: 'deck.state/1',
    phase: 'drafting',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    theme,
    last_render: null,
  });
  writeAtomic(path.join(p.sources, 'README.md'), sourcesReadme());
  writeAtomic(path.join(root, '.gitignore'), gitignore());
  registerDeck(root);

  process.stdout.write(`deck workspace created: ${root}\n`);
  process.stdout.write(`  theme:       ${theme}\n`);
  process.stdout.write(`  storyboard:  ${path.relative(process.cwd(), p.storyboard) || p.storyboard}\n`);
  process.stdout.write('\nNext:\n');
  process.stdout.write(`  cd ${dir}\n`);
  process.stdout.write('  deck validate      # check the storyboard\n');
  process.stdout.write('  deck prompts       # get the ChatGPT illustration prompts\n');
  process.stdout.write('  deck render        # preview, always allowed\n');
  process.stdout.write('  deck lint          # the geometry gate\n');
  return EXIT.OK;
}

/** @param {string} theme */
function deckYaml(theme) {
  return `# deck.yaml - what changes per deck.
#
# Modelled on the design kit's 03_依頼内容テンプレート.yaml. Following that file,
# an empty string or an empty list means "keep the default", never "remove it".
#
# The THEME holds everything that does not change per deck: canvas, colours,
# type bands, page geometry, lint thresholds. Editing a theme token invalidates
# rendered output but NOT content approval.
schema: deck.request/1

request:
  project_name: "新しい資料"
  purpose: "（この資料が何のためのものかを記入）"
  audience: "（誰に向けた資料かを記入）"
  theme: ${theme}
  language: ja-JP

  # Imported source material lives under sources/ and is immutable once there.
  content_source_files: []

  # Both default to true and are here to be read, not changed: the renderer may
  # re-wrap a line but may not summarise, rephrase, truncate or invent.
  preserve_title_and_subtitle_verbatim: true
  preserve_body_verbatim: true

  output:
    # PDF is the primary deliverable. PPTX is out of this increment and is
    # refused by name rather than ignored.
    formats: [pdf, png]
    png_scale: 2
    page_numbers: true

  additional_instructions: ""

# Per-deck token overrides, merged over the theme.
# theme_overrides:
#   colors:
#     accent_teal: { hex: "#0F8A9A", use: "..." }
`;
}

function storyboardYaml() {
  return `# storyboard.yaml - THE content source of truth.
#
# Every text field here is VERBATIM. The renderer may re-wrap a line; nothing
# may summarise, rephrase, truncate or invent. Layout line breaks live in
# line_breaks_after as character offsets, so the words stay one exact string.
#
# \`subtitle: null\` means an INTENTIONALLY ABSENT subtitle. It must never be
# back-filled: the content digest covers it, so adding one invalidates content
# approval.
schema: deck.storyboard/1
title: "新しい資料"

slides:
  - id: cover
    page_type: cover
    purpose: "資料の主題と対象を一目で伝える"
    section_label: "ご提案"
    title: "ここにタイトルを書く"
    subtitle: "ここに副題を書く"
    speaker_notes: null
    slots:
      - id: cover-art
        brief: "資料の主題を表す水彩イラスト。文字は一切入れない。"
        width_px: 760
        height_px: 941
    source_refs: []

  - id: agenda
    page_type: agenda
    purpose: "全体の流れを示し、いまどこを話しているかを明確にする"
    section_label: "本日の流れ"
    title: "本日の目次"
    subtitle: null
    agenda:
      items:
        - "現状の整理"
        - "ご提案の内容"
        - "次のステップ"
      active: 1
    speaker_notes: null
    slots: []
    source_refs: []

  - id: ch-01
    page_type: section-divider
    purpose: "第1章の始まりを示す"
    section_label: "第01章"
    title: "現状の整理"
    subtitle: "いま見えていること"
    speaker_notes: null
    slots: []
    source_refs: []

  - id: three-points
    page_type: standard-3col
    purpose: "三つの論点を並べて比較できるようにする"
    section_label: "現状の整理"
    title: "三つの論点"
    subtitle: "それぞれ独立して検討できる"
    body:
      - kind: cards
        cards:
          - heading: "一つめ"
            body: "ここに本文を書く。"
            icon: teal
          - heading: "二つめ"
            body: "ここに本文を書く。"
            icon: orange
          - heading: "三つめ"
            body: "ここに本文を書く。"
            icon: teal
    footer:
      label: "要点"
      text: "三つの論点はいずれも独立して進められる。"
    speaker_notes: null
    slots: []
    source_refs: []
`;
}

function sourcesReadme() {
  return `# sources/

Imported source material. IMMUTABLE once imported.

A storyboard slide cites what it came from in \`source_refs\`, as a path under
this directory. Keeping the sources next to the storyboard is what makes
"verbatim" checkable later: without the original, nobody can tell whether a
line was rephrased.

Nothing in here is read at render time. It is evidence, not input.
`;
}

function gitignore() {
  return `# Build output. Reproducible from storyboard.yaml + the theme.
out/

# Per-deck state, including approvals.
#
# COMMIT THIS if you want approvals to travel with the deck - they are a record
# of what the PO signed off and are small. Ignore it if the deck is shared and
# approvals are personal. Uncomment to ignore:
# .deck/
`;
}
