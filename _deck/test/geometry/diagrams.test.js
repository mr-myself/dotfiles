import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { DECK_HOME, theme } from '../helpers.js';
import { closeBrowser, measure } from './fixture.js';

process.env.DECK_HOME = DECK_HOME;
const T = await theme();
const { TEMPLATES } = await import('../../src/render/templates.js');
const { themeVariables, fontFaces } = await import('../../src/theme/css.js');
const { fileUrl } = await import('../../src/render/html.js');

after(closeBrowser);

/**
 * THE DIAGRAM PAGE TYPES, MEASURED.
 *
 * The deck turned every relationship into a table because a table was the
 * only structure it had. These four draw the relationship instead - and a
 * drawn relationship can be WRONG in ways a table cannot: an arrow can point
 * backwards, a step can be out of order, a label can land on a connector, a
 * comparison's rows can drift apart so that two cells which answer the same
 * question no longer line up.
 *
 * None of that is visible to a content check and none of it is visible to a
 * human skimming the YAML. It is visible in the rendered geometry, which is
 * what these assert. What they do NOT assert is whether the picture is a good
 * picture; that is in the report, from looking.
 */

async function renderSlide(slide) {
  const inner = TEMPLATES[slide.page_type]({
    theme: T, slide, index: 0, total: 6, assets: {}, pageNumbers: true,
  });
  const toUrl = (rel) => fileUrl(path.join(T.__dir, rel));
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>
${fontFaces(T, toUrl)}
${themeVariables(T)}
${fs.readFileSync(T.__css, 'utf8')}
</style></head><body>
<section class="deck-page">
  <div class="deck-canvas" data-deck-canvas data-deck-canvas-width="${T.canvas.width}"
       data-deck-canvas-height="${T.canvas.height}" data-deck-slide-id="${slide.id}"
       data-deck-page-type="${slide.page_type}">
    <div class="region region--content" data-deck-region="content-region"></div>${inner}
  </div>
</section></body></html>`;
  return measure(html);
}

const byId = (slide, id) => slide.elements.find((e) => e.id === id);
const head = (title, extra) => ({
  purpose: 'テスト', section_label: 'ラベル', title, subtitle: 'リード文', ...extra,
});

// ------------------------------------------------------------- comparison

const CMP = {
  id: 'cmp',
  page_type: 'comparison',
  ...head('3つの候補と、その評価'),
  comparison: {
    axes: ['初期費用', '社内で運用できるか', '他システム連携'],
    columns: [
      { label: 'A社', caption: '国内シェア最大', cells: ['高い', '研修なしで運用できる見込み', '会計のみ'] },
      { label: 'B社', caption: '海外製', cells: ['安い', '英語の運用が要るため、担当者の育成が前提になる', 'ほぼ全て'] },
      { label: 'C社', caption: '新興', cells: ['中程度', '要検証', '会計と勤怠'] },
    ],
  },
};

test('CORRESPONDING ROWS SHARE A BASELINE ACROSS COLUMNS', async () => {
  // The whole point of a comparison page. Three columns whose cells differ in
  // length: if the layout let each column stack independently, the second
  // row's cells would sit at three different heights and two answers to the
  // same question would stop looking like answers to the same question.
  const slide = await renderSlide(CMP);
  for (let r = 1; r <= 3; r += 1) {
    const tops = [1, 2, 3].map((c) => {
      const el = byId(slide, `cmp-cell-${r}-${c}`);
      assert.ok(el, `cell ${r}-${c} must render`);
      return el.rect.y;
    });
    const spread = Math.max(...tops) - Math.min(...tops);
    assert.ok(spread < 1.5, `row ${r} must share one baseline; spread was ${spread}px (${tops})`);
  }
});

test('and the axis label shares that baseline too', async () => {
  const slide = await renderSlide(CMP);
  for (let r = 1; r <= 3; r += 1) {
    const axis = byId(slide, `cmp-axis-${r}`);
    const cell = byId(slide, `cmp-cell-${r}-1`);
    assert.ok(Math.abs(axis.rect.y - cell.rect.y) < 1.5,
      `axis ${r} sits on its row: ${axis.rect.y} vs ${cell.rect.y}`);
  }
});

test('every column spans the same vertical extent, whatever its text length', async () => {
  const slide = await renderSlide(CMP);
  const heads = [1, 2, 3].map((c) => byId(slide, `cmp-head-${c}`));
  const tops = heads.map((h) => h.rect.y);
  assert.ok(Math.max(...tops) - Math.min(...tops) < 1.5, 'the column heads share a top');
});

test('the author\'s recommendation is marked, and deck never marks one itself', async () => {
  const picked = JSON.parse(JSON.stringify(CMP));
  picked.comparison.columns[1].emphasis = true;
  const withPick = await renderSlide(picked);
  const plain = await renderSlide(CMP);
  // The emphasised head differs from the same head without emphasis.
  const a = byId(withPick, 'cmp-head-2');
  const b = byId(plain, 'cmp-head-2');
  assert.notDeepEqual(a.backing.composited, b.backing.composited,
    'an emphasised column is visibly distinguished');
  // ...and with no emphasis declared, no column is distinguished.
  const heads = [1, 2, 3].map((c) => byId(plain, `cmp-head-${c}`));
  const fills = heads.map((h) => JSON.stringify(h.backing.composited));
  assert.equal(new Set(fills).size, 1, 'deck does not pick a winner on its own');
});

// ---------------------------------------------------------------- process

const PROC = {
  id: 'proc',
  page_type: 'process',
  ...head('進め方'),
  process: {
    direction: 'horizontal',
    steps: [
      { label: '9月', heading: '候補を絞る', items: ['3社に見積もり依頼', '現場の要件を確認'] },
      { label: '10月', heading: '試用する', items: ['1部署で1か月'] },
      { label: '11月', heading: '決める', items: ['契約の可否'] },
    ],
  },
};

test('STEPS RENDER IN STORYBOARD ORDER, left to right', async () => {
  const slide = await renderSlide(PROC);
  const xs = [1, 2, 3].map((n) => byId(slide, `step-${n}`).rect.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs,
    `steps must run in order; got x = ${xs}`);
  // The headings are the storyboard's, in the storyboard's order.
  const headings = [1, 2, 3].map((n) => byId(slide, `step-heading-${n}`).text.trim());
  assert.deepEqual(headings, ['候補を絞る', '試用する', '決める']);
});

test('THE ARROWS POINT FORWARD, and sit between consecutive steps', async () => {
  const slide = await renderSlide(PROC);
  for (const n of [1, 2]) {
    const arrow = byId(slide, `step-arrow-${n}`);
    const before = byId(slide, `step-${n}`);
    const after = byId(slide, `step-${n + 1}`);
    assert.ok(arrow && arrow.visible, `the gap after step ${n} carries an arrow`);
    assert.ok(arrow.rect.x >= before.rect.x + before.rect.w - 1,
      'the arrow starts after the step it leaves');
    assert.ok(arrow.rect.x + arrow.rect.w <= after.rect.x + 1,
      'and ends before the step it points at');
  }
  // The LAST step has no arrow out of it: it points at nothing.
  assert.equal(byId(slide, `step-arrow-3`), undefined,
    'an arrow out of the final step would point at nothing');
});

test('the step number comes from the position, not from the text', async () => {
  const slide = await renderSlide(PROC);
  assert.deepEqual([1, 2, 3].map((n) => byId(slide, `step-num-${n}`).text.trim()), ['01', '02', '03']);
});

test('a step with several items keeps them INSIDE the step', async () => {
  const slide = await renderSlide(PROC);
  const step = byId(slide, 'step-1');
  for (const j of [1, 2]) {
    const item = byId(slide, `step-1-item-${j}`);
    assert.ok(item.rect.x >= step.rect.x - 1 && item.rect.y >= step.rect.y - 1,
      'items are contained by their step, never promoted to steps of their own');
    assert.ok(item.rect.y + item.rect.h <= step.rect.y + step.rect.h + 1);
  }
  // Three steps, not five: the items did not become steps.
  assert.equal(slide.elements.filter((e) => e.role === 'step').length, 3);
});

test('a vertical process stacks downward, and its arrows follow', async () => {
  const v = JSON.parse(JSON.stringify(PROC));
  v.process.direction = 'vertical';
  const slide = await renderSlide(v);
  const ys = [1, 2, 3].map((n) => byId(slide, `step-${n}`).rect.y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys, `vertical steps run downward; got ${ys}`);
  const arrow = byId(slide, 'step-arrow-1');
  assert.ok(arrow.rect.h > arrow.rect.w, 'a vertical arrow is taller than it is wide');
});

// -------------------------------------------------------------- ecosystem

const HUB = {
  id: 'hub',
  page_type: 'ecosystem',
  ...head('関係'),
  ecosystem: {
    layout: 'hub',
    centre: { label: '給与システム', caption: '人事が運用する' },
    nodes: [
      { label: '勤怠', caption: '打刻を渡す', direction: 'from' },
      { label: '会計', caption: '仕訳を受け取る', direction: 'to' },
      { label: '人事', caption: 'マスタを持つ', direction: 'both' },
      { label: '経営', caption: '集計を見る', direction: 'to' },
    ],
  },
};

test('A LABEL NEVER SITS ON A CONNECTOR', async () => {
  // The kit's 交差とラベルへの重なりを避け. Every label is inside an opaque
  // box above the connector layer; this measures that no label box contains
  // any part of a connector's drawn span between the two boxes it joins.
  const slide = await renderSlide(HUB);
  const connectors = byId(slide, 'ecosystem-connectors');
  assert.ok(connectors, 'the connector layer renders');

  const labels = slide.elements.filter((e) => e.role === 'ecosystem-label' || e.role === 'ecosystem-caption');
  assert.ok(labels.length >= 8, 'every node and the centre carry their own label');
  // A connector runs from the centre box edge to a node box edge, so the only
  // boxes it may touch are those two. Any OTHER node box overlapping a
  // connector's straight run would mean a line crossing a label.
  const boxes = [1, 2, 3, 4].map((n) => byId(slide, `eco-node-${n}`).rect);
  const centre = byId(slide, 'eco-centre').rect;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = 0; j < boxes.length; j += 1) {
      if (i === j) continue;
      assert.ok(!overlaps(boxes[i], boxes[j]), `node ${i + 1} and node ${j + 1} must not overlap`);
    }
    assert.ok(!overlaps(boxes[i], centre), `node ${i + 1} must not overlap the centre`);
  }
});

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test('the hub is in the middle, with its nodes around it', async () => {
  const slide = await renderSlide(HUB);
  const centre = byId(slide, 'eco-centre').rect;
  const nodes = [1, 2, 3, 4].map((n) => byId(slide, `eco-node-${n}`).rect);
  // At least one node on each side of the centre: that is what "around" means.
  assert.ok(nodes.some((n) => n.cy < centre.cy), 'something above');
  assert.ok(nodes.some((n) => n.cy > centre.cy), 'something below');
  assert.ok(nodes.some((n) => n.cx < centre.cx), 'something left');
  assert.ok(nodes.some((n) => n.cx > centre.cx), 'something right');
});

test('LAYERS: the base is the LAST layer, and the items sit inside their layer', async () => {
  const slide = await renderSlide({
    id: 'layers',
    page_type: 'ecosystem',
    ...head('分解'),
    ecosystem: {
      layout: 'layers',
      layers: [
        { label: 'やりたいこと', items: ['給与計算の自動化', '年末調整の電子化'] },
        { label: '共通の土台', items: ['マスタの整備', '勤怠データの電子化'] },
      ],
    },
  });
  const upper = byId(slide, 'eco-layer-1').rect;
  const base = byId(slide, 'eco-layer-2').rect;
  assert.ok(base.y > upper.y, 'the shared base is drawn beneath what rests on it');
  // 包含関係: a layer's items are INSIDE the layer.
  for (const id of ['eco-layer-1-item-1', 'eco-layer-1-item-2']) {
    const item = byId(slide, id).rect;
    assert.ok(item.y >= upper.y - 1 && item.y + item.h <= upper.y + upper.h + 1,
      `${id} is contained by its layer`);
  }
});

// --------------------------------------------------------------- timeline

const TL = {
  id: 'tl',
  page_type: 'timeline',
  ...head('段取り'),
  timeline: {
    entries: [
      { when: '10月', label: '試用の結果を見る', items: ['現場の反応'] },
      { when: '年内', label: '契約するか決める' },
      { when: '年始', label: '移行を始める', items: ['1部署から'] },
    ],
  },
};

test('A TIMELINE PRESERVES THE ORDER OF ITS ENTRIES', async () => {
  // Nothing is sorted: `when` is free text the source wrote - 来週火曜 is a
  // legitimate value - and sorting it would reorder the facts.
  const slide = await renderSlide(TL);
  const xs = [1, 2, 3].map((n) => byId(slide, `tl-entry-${n}`).rect.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, `entries run in order; got ${xs}`);
  assert.deepEqual([1, 2, 3].map((n) => byId(slide, `tl-when-${n}`).text.trim()),
    ['10月', '年内', '年始'], 'and carry the source\'s own wording, unsorted');
});

test('an out-of-alphabetical order is kept exactly as written', async () => {
  // The order is the author's. 「来週」 before 「10/16」 is their statement
  // about time, and deck has no business improving it.
  const odd = JSON.parse(JSON.stringify(TL));
  odd.timeline.entries = [
    { when: '来週', label: 'A' },
    { when: '10/16', label: 'B' },
    { when: 'あとで', label: 'C' },
  ];
  const slide = await renderSlide(odd);
  assert.deepEqual([1, 2, 3].map((n) => byId(slide, `tl-when-${n}`).text.trim()),
    ['来週', '10/16', 'あとで']);
});

test('several things at one time stay inside ONE entry', async () => {
  const grouped = JSON.parse(JSON.stringify(TL));
  grouped.timeline.entries[0].items = ['現場の反応', '工数の実測', '費用の確認'];
  const slide = await renderSlide(grouped);
  const entry = byId(slide, 'tl-entry-1').rect;
  for (const j of [1, 2, 3]) {
    const item = byId(slide, `tl-1-item-${j}`).rect;
    assert.ok(item.y >= entry.y - 1 && item.y + item.h <= entry.y + entry.h + 1,
      'a grouped item stays in its entry, which is what keeps the time relationship true');
  }
  assert.equal(slide.elements.filter((e) => e.role === 'timeline-entry').length, 3,
    'grouping does not create extra points in time');
});

test('the axis carries one tick per entry, over the entry it belongs to', async () => {
  const slide = await renderSlide(TL);
  const axis = byId(slide, 'timeline-axis');
  assert.ok(axis && axis.visible, 'the axis renders');
  assert.ok(axis.rect.y < byId(slide, 'tl-entry-1').rect.y, 'and runs above the entries');
});

// ------------------------------------------------- the decoration varies

test('THE WATERCOLOUR DIFFERS FROM SLIDE TO SLIDE, and is stable per slide', async () => {
  // Every page rendered the identical wash, so a deck read as one slide
  // repeated. The variation is seeded from the slide id: a given slide always
  // renders the same, so a re-render is byte-identical and inserting a slide
  // does not reshuffle the artwork after it.
  const a = await renderSlide({ ...TL, id: 'alpha' });
  const b = await renderSlide({ ...TL, id: 'beta' });
  const again = await renderSlide({ ...TL, id: 'alpha' });
  const wash = (s) => {
    const d = s.elements.find((e) => e.id === 'decor-topright');
    return d ? `${Math.round(d.rect.w)}x${Math.round(d.rect.h)}` : 'none';
  };
  assert.notEqual(wash(a), 'none');
  assert.notEqual(wash(a), wash(b), 'two slides must not carry the same wash');
  assert.equal(wash(a), wash(again), 'and one slide must always carry its own');
});
