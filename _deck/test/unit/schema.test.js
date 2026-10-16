import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECK_HOME, request, storyboard } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;
const { pageTypes, validate } = await import('../../src/schema.js');
const { parseYaml } = await import('../../src/util/yaml.js');

test('a minimal storyboard validates', () => {
  assert.deepEqual(validate('storyboard.schema.json', storyboard(), ''), []);
});

test('an unknown key is REFUSED, not ignored', () => {
  // The dangerous case is a file that parses but does not match: a typo'd
  // `subtitel:` would be dropped, and the slide would render with no subtitle,
  // which is indistinguishable from `subtitle: null` written on purpose.
  const errors = validate('storyboard.schema.json', storyboard({
    slides: [{ id: 'a', page_type: 'cover', purpose: 'p', subtitel: 'typo' }],
  }), '');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown key "subtitel"/);
});

test('subtitle: null is valid and distinct from an absent subtitle', () => {
  assert.deepEqual(validate('storyboard.schema.json', storyboard({
    slides: [{ id: 'a', page_type: 'cover', purpose: 'p', subtitle: null }],
  }), ''), []);
});

test('a slide id that is not a stable slug is refused', () => {
  for (const bad of ['Has Caps', 'has space', 'has_underscore', '-leading', '']) {
    const errors = validate('storyboard.schema.json', storyboard({
      slides: [{ id: bad, page_type: 'cover', purpose: 'p' }],
    }), '');
    assert.ok(errors.length > 0, `expected "${bad}" to be refused`);
  }
});

test('every design-kit page type parses, so a kit-authored storyboard is readable', () => {
  const { implemented, unimplemented } = pageTypes();
  for (const name of [...implemented, ...unimplemented.keys()]) {
    assert.deepEqual(
      validate('storyboard.schema.json', storyboard({
        slides: [{ id: 'a', page_type: name, purpose: 'p' }],
      }), ''),
      [],
      `page_type "${name}" should parse`,
    );
  }
});

test('a page type outside the vocabulary is refused by the schema', () => {
  const errors = validate('storyboard.schema.json', storyboard({
    slides: [{ id: 'a', page_type: 'invented', purpose: 'p' }],
  }), '');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /allowed:/);
});

test('every unimplemented page type carries a reason', () => {
  const { unimplemented, implemented } = pageTypes();
  assert.ok(unimplemented.size > 0);
  for (const [name, reason] of unimplemented) {
    assert.ok(reason && reason.length > 20, `${name} needs a real reason, got: ${reason}`);
    assert.ok(!implemented.has(name), `${name} cannot be both implemented and not`);
  }
});

test('the implemented set is exactly the ten page types that render', () => {
  // Six layout page types plus the four DIAGRAM types. The four were listed
  // as unimplemented and refused by name until the deck that needed them
  // turned every relationship it had into a table.
  const { implemented } = pageTypes();
  assert.deepEqual([...implemented].sort(), [
    'agenda', 'comparison', 'cover', 'ecosystem', 'process',
    'section-divider', 'standard-3col', 'statement', 'table', 'timeline',
  ]);
});

test('and every implemented page type has a template and a content contract', async () => {
  // The three tables that have to agree: what the schema admits, what the
  // renderer can draw, and what validation accepts. A name in one and not the
  // others is how a page type gets accepted and then rendered as nothing.
  const { TEMPLATES } = await import('../../src/render/templates.js');
  const { PAGE_TYPE_CONTENT } = await import('../../src/deck.js');
  const { implemented, unimplemented } = pageTypes();
  for (const name of implemented) {
    assert.ok(TEMPLATES[name], `implemented page type "${name}" has no template`);
    assert.ok(PAGE_TYPE_CONTENT[name], `implemented page type "${name}" has no content contract`);
  }
  // `unimplemented` is a Map of name -> reason.
  for (const [name, reason] of unimplemented) {
    assert.ok(!TEMPLATES[name], `"${name}" is listed unimplemented but has a template`);
    assert.ok(!PAGE_TYPE_CONTENT[name], `"${name}" is listed unimplemented but has a content contract`);
    assert.ok(reason && reason.length > 10, `"${name}" must be refused with a reason, not just refused`);
  }
});

test('a card block is capped at three cards rather than reflowed', () => {
  const four = { kind: 'cards', cards: [1, 2, 3, 4].map((n) => ({ heading: `h${n}` })) };
  const errors = validate('storyboard.schema.json', storyboard({
    slides: [{ id: 'a', page_type: 'standard-3col', purpose: 'p', body: [four] }],
  }), '');
  assert.ok(errors.length > 0);
});

test('deck.yaml validates, and an unknown request key is refused', () => {
  assert.deepEqual(validate('deck.schema.json', request(), ''), []);
  const errors = validate('deck.schema.json', request({ bogus: 1 }), '');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown key "bogus"/);
});

test('malformed YAML is reported with the parser\'s own message, not swallowed', () => {
  assert.throws(
    () => parseYaml('slides:\n  - id: a\n   bad indent\n', 'storyboard.yaml'),
    (err) => {
      assert.match(err.message, /could not be parsed as YAML/);
      assert.ok(err.details.length > 0);
      return true;
    },
  );
});

test('a duplicate YAML key is an error, because the dropped one would be content', () => {
  assert.throws(
    () => parseYaml('title: first\ntitle: second\n', 'storyboard.yaml'),
    (err) => {
      assert.match(err.details.join(' '), /unique/i);
      return true;
    },
  );
});

test('empty YAML is refused rather than treated as an empty deck', () => {
  assert.throws(() => parseYaml('\n# only a comment\n', 'storyboard.yaml'), /is empty/);
});

test('the asset manifest schema requires a brief digest on every entry', () => {
  const errors = validate('asset-manifest.schema.json', {
    schema: 'deck.assets/1',
    assets: [{
      slot_id: 's', slide_id: 'a', stored_file: 'assets/x.png', original_path: '/x.png',
      sha256: 'a'.repeat(64), imported_at: new Date().toISOString(),
    }],
  }, '');
  assert.ok(errors.some((e) => /brief_digest/.test(e)));
});
