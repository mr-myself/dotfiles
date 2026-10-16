import { requiredText } from '../lint/rules/content-integrity.js';
import { loadSourceTexts } from './sources.js';
import { collapse, combinedIndex } from './text.js';

/**
 * THE COPY SHEET: gate 5, in Japanese prose, with provenance.
 *
 * The PO must never have to open storyboard.yaml. So the second approval gate
 * shows them the EXACT copy - every title, subtitle, body line and table cell
 * - as readable text, numbered so they can say 「3枚目のタイトルをこう変えて」
 * and have the agent find it.
 *
 * PROVENANCE IS COMPUTED, NOT DECLARED. Each fragment is marked 【引用】 when
 * its wording is found verbatim in a source text and 【作成】 when it is not.
 * The agent does not get to label its own output: if it could, the one label
 * that matters - "this sentence is mine, not the minutes'" - would be the one
 * it had an incentive to get wrong. Computing it from the source means a
 * paraphrase shows up as 【作成】, which is exactly the honest answer.
 *
 * A 【作成】 mark is NOT a defect. Writing headings and connective prose is the
 * agent's job. The mark exists so the PO reading twenty lines knows which five
 * are the meeting's own words.
 *
 * WHAT THE MARK CANNOT SAY: 【引用】 means the characters occur in the source,
 * not that they were used in the sense the source used them. See fidelity.js.
 */

/** Japanese labels for the field paths requiredText() produces. */
const FIELD_LABELS = [
  [/^title$/, 'タイトル'],
  [/^subtitle$/, 'サブタイトル'],
  [/^section_label$/, '小見出し（ラベル）'],
  [/^footer\.text$/, 'フッター'],
  [/^footer\.label$/, 'フッターのラベル'],
  [/^agenda\.items\[(\d+)\]$/, 'アジェンダ項目 $1'],
  [/^body\[(\d+)\] paragraph$/, '本文'],
  [/^body\[(\d+)\] bullet\[(\d+)\]$/, '箇条書き $2'],
  [/^body statement$/, 'ステートメント'],
  [/^cards\[(\d+)\]\.heading$/, 'カード $1 の見出し'],
  [/^cards\[(\d+)\]\.body$/, 'カード $1 の本文'],
  [/^cards\[(\d+)\]\.items\[(\d+)\]$/, 'カード $1 の箇条書き $2'],
  [/^table\.columns\[(\d+)\]\.heading$/, '表の見出し $1'],
  [/^table\.rows\[(\d+)\]\[(\d+)\]$/, '表 $1 行 $2 列'],
  [/^table\.note$/, '表の注記'],
];

/** @param {string} field */
export function fieldLabel(field) {
  for (const [re, label] of FIELD_LABELS) {
    const m = re.exec(field);
    if (m) {
      // 1-based for the PO: 「カード 1」, not 「カード 0」.
      return label.replace(/\$(\d)/g, (_, n) => String(Number(m[Number(n)]) + 1));
    }
  }
  return field;
}

const PAGE_TYPE_JA = {
  cover: '表紙',
  agenda: 'アジェンダ',
  'section-divider': '章の区切り',
  'standard-3col': '3カラム',
  table: '表',
  statement: 'ステートメント',
};

/**
 * @param {import('../workspace.js').Paths} p
 * @param {any} storyboard
 * @returns {{text: string, slides: any[], totals: {quoted: number, written: number}}}
 */
export function copySheet(p, storyboard) {
  const sources = loadSourceTexts(p);
  const index = combinedIndex(sources);
  const totals = { quoted: 0, written: 0 };
  const slides = [];
  const lines = [];

  lines.push(`# ${storyboard.title}`);
  lines.push('');
  lines.push(`スライド ${(storyboard.slides || []).length} 枚。これが実際に出る文字そのままです。`);
  lines.push('');
  lines.push('【引用】= 元資料にそのままある文言　【作成】= こちらで書いた見出し・つなぎの文');
  lines.push('');
  lines.push('直したいところは「3枚目のタイトルを〜」のように枚数で言ってください。');
  if (sources.length === 0) {
    lines.push('');
    lines.push('※ 元資料が読み込まれていないため、引用の判定ができていません。');
  }
  lines.push('');

  (storyboard.slides || []).forEach((slide, i) => {
    const n = i + 1;
    const type = PAGE_TYPE_JA[slide.page_type] || slide.page_type;
    lines.push(`## ${n}枚目（${type}）`);
    const fragments = requiredText(slide).map((frag) => {
      const from = sources.length === 0 ? null : index.quoteFrom(frag.text);
      const quoted = from !== null;
      if (quoted) totals.quoted += 1; else totals.written += 1;
      return {
        field: frag.field, label: fieldLabel(frag.field), text: frag.text, quoted, source_id: from,
      };
    });
    if (fragments.length === 0) {
      lines.push('（文字なし）');
    }
    for (const f of fragments) {
      const mark = sources.length === 0 ? '【—】' : (f.quoted ? '【引用】' : '【作成】');
      lines.push(`- ${f.label}: ${mark} ${collapse(f.text)}`);
    }
    // Slots are not copy, but the PO needs to know a picture goes here - and
    // that it will carry no words.
    for (const slot of slide.slots || []) {
      lines.push(`- 図版枠「${slot.id}」: ${collapse(slot.brief)}（${slot.width_px}x${slot.height_px}px・文字は入りません）`);
    }
    lines.push('');
    slides.push({
      index: n, id: slide.id, page_type: slide.page_type, fragments, slots: slide.slots || [],
    });
  });

  lines.push('---');
  lines.push(`引用 ${totals.quoted} 件 / 作成 ${totals.written} 件。`);
  lines.push('この内容でよければ「OK」、直すところがあればそのまま言ってください。');
  lines.push('');

  return { text: lines.join('\n'), slides, totals };
}
