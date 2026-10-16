import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECK_HOME, theme } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const T = await theme();
const { PAGE_TYPE_CONTENT, validateSemantics } = await import('../../src/deck.js');
const { TEMPLATES } = await import('../../src/render/templates.js');
const { pageTypes } = await import('../../src/schema.js');

/** Validate one slide in isolation. */
function check(slide) {
  return validateSemantics({ slides: [{ id: 's', purpose: '目的', ...slide }] }, T);
}

/** Render one slide and return its HTML. */
function render(slide) {
  const full = { id: 's', purpose: '目的', ...slide };
  return TEMPLATES[full.page_type]({ theme: T, slide: full, index: 0, total: 1, assets: {} });
}

test('every implemented page type has a content contract', () => {
  for (const name of pageTypes().implemented) {
    assert.ok(PAGE_TYPE_CONTENT[name], `page type "${name}" has no entry in PAGE_TYPE_CONTENT`);
  }
});

test('MULTIPLE BLOCKS OF A FIRST-ONLY KIND ARE REFUSED, NOT SILENTLY DROPPED', () => {
  // Reproduced by review: two statements plus a footer validated successfully
  // while the HTML contained only the first statement. Accepting content and
  // then not rendering it is the one failure this tool exists to prevent.
  const twoStatements = {
    page_type: 'statement',
    title: 'T',
    body: [{ kind: 'statement', text: '一つめ' }, { kind: 'statement', text: '二つめ' }],
  };
  const errors = check(twoStatements);
  assert.ok(errors.some((e) => /2 "statement" blocks/.test(e)), errors.join('\n'));

  // ...and the reason it is refused: the renderer really does drop the second.
  const html = render(twoStatements);
  assert.ok(html.includes('一つめ'));
  assert.ok(!html.includes('二つめ'), 'the second statement is genuinely lost, which is why this is refused');
});

test('two cards blocks are refused; the renderer draws only the first', () => {
  const slide = {
    page_type: 'standard-3col',
    title: 'T',
    body: [
      { kind: 'cards', cards: [{ heading: '一枚目' }] },
      { kind: 'cards', cards: [{ heading: '二枚目' }] },
    ],
  };
  assert.ok(check(slide).some((e) => /2 "cards" blocks/.test(e)));
  const html = render(slide);
  assert.ok(html.includes('一枚目') && !html.includes('二枚目'));
});

test('MANY lead blocks are accepted, because the renderer draws them ALL', () => {
  // The contract must be honest in both directions: refusing content that
  // WOULD be rendered is as wrong as accepting content that would not.
  const slide = {
    page_type: 'standard-3col',
    title: 'T',
    body: [
      { kind: 'paragraph', text: '一つめの段落' },
      { kind: 'paragraph', text: '二つめの段落' },
      { kind: 'bullets', items: ['箇条書き一', '箇条書き二'] },
      { kind: 'cards', cards: [{ heading: 'カード' }] },
    ],
  };
  assert.deepEqual(check(slide), []);
  const html = render(slide);
  for (const text of ['一つめの段落', '二つめの段落', '箇条書き一', '箇条書き二', 'カード']) {
    assert.ok(html.includes(text), `"${text}" must actually be rendered`);
  }
});

test('A FIELD THE PAGE TYPE DOES NOT RENDER IS REFUSED', () => {
  for (const [slide, needle] of [
    [{ page_type: 'cover', title: 'T', footer: { text: '要点' } }, /footer/],
    [{ page_type: 'section-divider', title: 'T', footer: { text: '要点' } }, /footer/],
    // statement DOES render a footer now - that banner is the framing the page
    // was missing - so the refused field here is one it still does not draw.
    [{ page_type: 'agenda', title: 'T', agenda: { items: ['a'] }, table: { columns: [{ heading: 'a' }, { heading: 'b' }], rows: [['1', '2']] } }, /table/],
    [{ page_type: 'statement', title: 'T', section_label: 'S', body: [{ kind: 'statement', text: 'x' }], agenda: { items: ['a'] } }, /agenda/],
    [{ page_type: 'statement', title: 'T', section_label: 'S', body: [{ kind: 'statement', text: 'x' }], table: { columns: [{ heading: 'a' }, { heading: 'b' }], rows: [['1', '2']] } }, /table/],
  ]) {
    const errors = check(slide);
    assert.ok(errors.some((e) => needle.test(e)), `${slide.page_type}: ${errors.join('; ') || 'NO ERROR'}`);
  }
});

test('every field a page type DOES render is accepted', () => {
  assert.deepEqual(check({
    page_type: 'agenda', title: 'T', subtitle: null,
    agenda: { items: ['一', '二'], active: 1 },
    footer: { text: '要点' },
  }), []);
  assert.deepEqual(check({
    page_type: 'table', title: 'T', subtitle: null,
    table: { columns: [{ heading: 'a' }, { heading: 'b' }], rows: [['1', '2']] },
    footer: { text: '要点' },
  }), []);
});

test('a block missing its kind-specific field is refused', () => {
  assert.ok(check({ page_type: 'standard-3col', title: 'T', body: [{ kind: 'cards', cards: [{ heading: 'h' }] }, { kind: 'paragraph' }] })
    .some((e) => /no text/.test(e)));
  assert.ok(check({ page_type: 'standard-3col', title: 'T', body: [{ kind: 'cards', cards: [{ heading: 'h' }] }, { kind: 'bullets', items: [] }] })
    .some((e) => /no items/.test(e)));
  assert.ok(check({ page_type: 'standard-3col', title: 'T', body: [{ kind: 'cards', cards: [] }] })
    .some((e) => /no cards/.test(e)));
  assert.ok(check({ page_type: 'statement', title: 'T', body: [{ kind: 'statement', text: '   ' }] })
    .some((e) => /no text/.test(e)));
});

test('a block carrying a field its kind does not render is refused', () => {
  assert.ok(check({ page_type: 'statement', title: 'T', body: [{ kind: 'statement', text: 'x', items: ['y'] }] })
    .some((e) => /also carries "items"/.test(e)));
  assert.ok(check({ page_type: 'standard-3col', title: 'T', body: [{ kind: 'cards', cards: [{ heading: 'h' }], text: 'stray' }] })
    .some((e) => /also carries "text"/.test(e)));
});

test('a line break naming a field the slide does not have is refused', () => {
  assert.ok(check({
    page_type: 'statement', title: 'T', subtitle: null, section_label: 'S',
    body: [{ kind: 'statement', text: 'x' }],
    line_breaks_after: { subtitle: [2] },
  }).some((e) => /line_breaks_after\.subtitle/.test(e)));

  // ...and one that DOES name a present field is fine.
  assert.deepEqual(check({
    page_type: 'statement', title: 'ある見出し', subtitle: null, section_label: 'S',
    body: [{ kind: 'statement', text: 'x' }],
    line_breaks_after: { title: [2] },
  }), []);
});

test('A LINE BREAK PAST THE END OF THE TEXT IS REFUSED, not silently ignored', () => {
  assert.throws(
    () => render({ page_type: 'statement', title: 'みじかい', body: [{ kind: 'statement', text: 'x' }], line_breaks_after: { title: [99] } }),
    /outside the text/,
  );
});

test('a table row of the wrong width is refused rather than padded', () => {
  assert.throws(() => render({
    page_type: 'table', title: 'T', subtitle: null,
    table: { columns: [{ heading: 'a' }, { heading: 'b' }], rows: [['only one']] },
  }), /has 1 cells but there are 2 columns/);
});

test('TABLE COLUMN WIDTHS ARE ACTUALLY APPLIED', () => {
  // width_fr used to be emitted into a custom property the stylesheet never
  // read, so every table came out equal-width whatever the storyboard asked.
  const html = render({
    page_type: 'table', title: 'T', subtitle: null,
    table: {
      columns: [{ heading: 'a', width_fr: 3 }, { heading: 'b', width_fr: 1 }],
      rows: [['1', '2']],
    },
  });
  assert.match(html, /<th[^>]*style="width:75%/, html.slice(0, 400));
  assert.match(html, /<th[^>]*style="width:25%/);
});

test('page_numbers:false suppresses the folio; the default keeps it', () => {
  const slide = { id: 's', purpose: 'p', page_type: 'statement', title: 'T', body: [{ kind: 'statement', text: 'x' }] };
  const on = TEMPLATES.statement({ theme: T, slide, index: 0, total: 3, assets: {} });
  const off = TEMPLATES.statement({ theme: T, slide, index: 0, total: 3, assets: {}, pageNumbers: false });
  assert.match(on, /data-deck-id="page-number"/);
  assert.ok(!off.includes('data-deck-id="page-number"'));
});


// ---------------------------------------------------------------------------
// GENERATED FROM THE CAPABILITY TABLE.
//
// The tests above are selected examples: they prove the cases someone thought
// of. These are derived from PAGE_TYPE_CONTENT itself, so a template that
// gains or loses a capability without the table being updated fails here
// rather than drifting silently. Every entry produces both an acceptance and
// a rejection case, and the acceptance case is RENDERED and searched for its
// own text, so the table cannot claim a capability the template does not have.
// ---------------------------------------------------------------------------

/** A minimal valid slide for a page type, with its required fields. */
function baseSlide(pageType) {
  const base = { page_type: pageType, title: '見出し', subtitle: null };
  if (pageType === 'agenda') base.agenda = { items: ['一'], active: 1 };
  if (pageType === 'table') {
    base.table = { columns: [{ heading: 'あ' }, { heading: 'い' }], rows: [['1', '2']] };
  }
  if (pageType === 'standard-3col') base.body = [{ kind: 'cards', cards: [{ heading: 'カード' }] }];
  if (pageType === 'statement') {
    base.body = [{ kind: 'statement', text: '主張' }];
    // A statement page REQUIRES its eyebrow: it is the framing that tells the
    // reader why the deck stopped here, and without it the page reads as a
    // title slide that wandered in. See validateSlideShape.
    base.section_label = 'ここが要点';
  }
  // The diagram page types each draw ONE structured field, and it is required:
  // a comparison with no comparison is not a page, it is an empty frame.
  if (pageType === 'comparison') {
    base.comparison = {
      axes: ['軸'],
      columns: [{ label: 'A', cells: ['あ'] }, { label: 'B', cells: ['い'] }],
    };
  }
  if (pageType === 'process') {
    base.process = { steps: [{ heading: '一歩目' }, { heading: '二歩目' }] };
  }
  if (pageType === 'ecosystem') {
    base.ecosystem = {
      layout: 'hub',
      centre: { label: '中心' },
      nodes: [{ label: '周辺一' }, { label: '周辺二' }],
    };
  }
  if (pageType === 'timeline') {
    base.timeline = { entries: [{ when: '一月', label: 'あ' }, { when: '二月', label: 'い' }] };
  }
  return base;
}

/** A body block of a kind, carrying a distinctive marker string. */
function blockOf(kind, marker) {
  if (kind === 'cards') return { kind: 'cards', cards: [{ heading: marker }] };
  if (kind === 'bullets') return { kind: 'bullets', items: [marker] };
  return { kind, text: marker };
}

/** The top-level field a page type may or may not render, with a marker. */
function fieldOf(field, marker) {
  if (field === 'footer') return { footer: { text: marker } };
  if (field === 'agenda') return { agenda: { items: [marker], active: 1 } };
  if (field === 'table') {
    return { table: { columns: [{ heading: marker }, { heading: 'x' }], rows: [['1', '2']] } };
  }
  if (field === 'comparison') {
    return { comparison: { axes: [marker], columns: [{ label: 'A', cells: ['あ'] }, { label: 'B', cells: ['い'] }] } };
  }
  if (field === 'process') return { process: { steps: [{ heading: marker }, { heading: '次' }] } };
  if (field === 'ecosystem') {
    return { ecosystem: { layout: 'hub', centre: { label: marker }, nodes: [{ label: 'あ' }, { label: 'い' }] } };
  }
  if (field === 'timeline') {
    return { timeline: { entries: [{ when: '一月', label: marker }, { when: '二月', label: 'い' }] } };
  }
  return {};
}

const ALL_BLOCK_KINDS = ['paragraph', 'bullets', 'cards', 'statement'];
const ALL_FIELDS = ['footer', 'agenda', 'table', 'comparison', 'process', 'ecosystem', 'timeline'];

for (const [pageType, caps] of Object.entries(PAGE_TYPE_CONTENT)) {
  test(`[generated] ${pageType}: a minimal slide validates and renders`, () => {
    const slide = baseSlide(pageType);
    assert.deepEqual(check(slide), [], `${pageType} should accept its own minimal form`);
    assert.ok(render(slide).includes('見出し'), `${pageType} must render its title`);
  });

  for (const kind of ALL_BLOCK_KINDS) {
    const supported = kind in caps.blocks;
    test(`[generated] ${pageType}: a "${kind}" block is ${supported ? 'rendered' : 'refused'}`, () => {
      const marker = `MARKER-${kind}`;
      const slide = { ...baseSlide(pageType) };
      if (supported) {
        // Replace rather than append: the minimal slide may already carry one.
        slide.body = [blockOf(kind, marker)];
        if (pageType === 'standard-3col' && kind !== 'cards') {
          slide.body = [blockOf('cards', 'カード'), blockOf(kind, marker)];
        }
        assert.deepEqual(check(slide), [], `${pageType} claims to render "${kind}"`);
        assert.ok(render(slide).includes(marker),
          `PAGE_TYPE_CONTENT says ${pageType} renders "${kind}", but the template did not draw it`);
      } else {
        slide.body = [...(slide.body || []), blockOf(kind, marker)];
        const errors = check(slide);
        assert.ok(errors.length > 0,
          `PAGE_TYPE_CONTENT says ${pageType} cannot lay out "${kind}", so it must be refused`);
        assert.ok(errors.some((e) => e.includes(kind)), errors.join('; '));
      }
    });
  }

  for (const field of ALL_FIELDS) {
    const supported = caps.fields.includes(field);
    // A page type's own required field is covered by the minimal-slide case.
    const isOwnRequired = (pageType === 'agenda' && field === 'agenda')
      || (pageType === 'table' && field === 'table')
      // Each diagram page type's own field is required, so the minimal-slide
      // case above already covers it.
      || pageType === field;
    if (isOwnRequired) continue;

    test(`[generated] ${pageType}: the "${field}" field is ${supported ? 'rendered' : 'refused'}`, () => {
      const marker = `MARKER-${field}`;
      const slide = { ...baseSlide(pageType), ...fieldOf(field, marker) };
      if (supported) {
        assert.deepEqual(check(slide), [], `${pageType} claims to render "${field}"`);
        assert.ok(render(slide).includes(marker),
          `PAGE_TYPE_CONTENT says ${pageType} renders "${field}", but the template did not draw it`);
      } else {
        const errors = check(slide);
        assert.ok(errors.length > 0,
          `PAGE_TYPE_CONTENT says ${pageType} does not render "${field}", so it must be refused`);
        assert.ok(errors.some((e) => e.includes(field)), errors.join('; '));
      }
    });
  }

  // Multiplicity, for the kinds the table caps.
  for (const [kind, max] of Object.entries(caps.blocks)) {
    if (!Number.isFinite(max)) continue;
    test(`[generated] ${pageType}: ${max + 1} "${kind}" blocks are refused`, () => {
      const slide = { ...baseSlide(pageType) };
      slide.body = Array.from({ length: max + 1 }, (_, i) => blockOf(kind, `M${i}`));
      const errors = check(slide);
      assert.ok(errors.some((e) => /blocks/.test(e)),
        `${pageType} renders only ${max} "${kind}" block(s); more must be refused. Got: ${errors.join('; ') || 'NO ERROR'}`);
    });
  }
}

// ---------------------------------------------------------------------------
// EVERY IMPLEMENTED PAGE TYPE HAS A FIXTURE SLIDE.
//
// The PO's observation, generalised: "テーマが宣言しているスロットを使う
// フィクスチャが一つも無いから世に出ている". A page type nobody has rendered
// is a page type whose first render happens on the PO's real deck, which is
// how the three-column layout shipped with slot coordinates that could not be
// used. The fixture is the documented example of each type, and this is what
// stops it falling behind the vocabulary.
// ---------------------------------------------------------------------------
test('every implemented page type appears in test/fixtures/full-deck', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const YAML = (await import('yaml')).default;

  const file = path.join(DECK_HOME, 'test', 'fixtures', 'full-deck', 'storyboard.yaml');
  const fixture = YAML.parse(fs.readFileSync(file, 'utf8'));
  const used = new Set(fixture.slides.map((s) => s.page_type));

  for (const pageType of pageTypes().implemented) {
    assert.ok(used.has(pageType),
      `page_type "${pageType}" is implemented and no fixture slide uses it. Add one to `
      + 'test/fixtures/full-deck/storyboard.yaml so there is a rendered example of it, '
      + 'and so the geometry tests cover it.');
  }
});
