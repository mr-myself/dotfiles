import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { DeckError, EXIT } from './util/fail.js';
import { deckHome } from './workspace.js';

/**
 * Schema validation.
 *
 * `additionalProperties: false` everywhere, and the reason is vet's: a file
 * that PARSES but does not match the schema is the dangerous case. A typo'd
 * `subtitel:` would otherwise be silently dropped and the slide would render
 * with no subtitle, which is indistinguishable from the PO having written
 * `subtitle: null` on purpose. Refusing the file is strictly better than
 * rendering a page that quietly lost a line.
 *
 * ajv's draft 2020-12 entry point is used rather than the default export,
 * which is draft-07 and silently ignores `$schema`.
 */

let ajv = null;
/**
 * Compiled validators, cached by schema name.
 *
 * ajv keys schemas by their `$id` and THROWS on a second compile of the same
 * id - so a command that validates two files, or validates once and reads the
 * page-type table once, used to die with "schema already exists". Caching the
 * compiled function is both the fix and the faster path.
 *
 * @type {Map<string, import('ajv').ValidateFunction>}
 */
const compiled = new Map();

function instance() {
  if (ajv) return ajv;
  ajv = new Ajv2020.default({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats.default(ajv);
  return ajv;
}

/** @param {string} name @returns {import('ajv').ValidateFunction} */
function validator(name) {
  const cached = compiled.get(name);
  if (cached) return cached;
  const fn = instance().compile(loadSchema(name));
  compiled.set(name, fn);
  return fn;
}

/** @param {string} name e.g. "storyboard.schema.json" */
export function loadSchema(name) {
  const file = path.join(deckHome(), 'schemas', name);
  if (!fs.existsSync(file)) {
    throw new DeckError(`deck's bundled schema is missing: ${file}`, EXIT.ENVIRONMENT);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The page-type vocabulary, split into implemented and refused-by-name. */
export function pageTypes() {
  const data = JSON.parse(fs.readFileSync(path.join(deckHome(), 'schemas', 'page-types.data.json'), 'utf8'));
  // Validated against its own schema so the two cannot drift: the list of
  // implemented page types is load-bearing for `deck validate`'s refusals.
  const v = validator('page-types.json');
  if (!v(data)) {
    throw new DeckError('deck\'s own page-type table does not match its schema', EXIT.PROCESS_FAILED,
      (v.errors || []).map(formatError));
  }
  return {
    implemented: new Set(data.implemented),
    unimplemented: new Map(data.unimplemented.map((u) => [u.name, u.reason])),
  };
}

/**
 * @param {string} schemaName
 * @param {unknown} value
 * @param {string} label for the error message
 * @returns {string[]} empty when valid
 */
export function validate(schemaName, value, label) {
  const v = validator(schemaName);
  if (v(value)) return [];
  return (v.errors || []).map((e) => `${label}${formatError(e)}`);
}

/** @param {import('ajv').ErrorObject} e */
function formatError(e) {
  const at = e.instancePath || '(root)';
  if (e.keyword === 'additionalProperties') {
    return `${at}: unknown key "${e.params.additionalProperty}" - deck refuses a file with keys it does not understand, because a typo'd key would silently drop content`;
  }
  if (e.keyword === 'enum') {
    return `${at}: ${e.message} (allowed: ${(e.params.allowedValues || []).join(', ')})`;
  }
  if (e.keyword === 'const') {
    return `${at}: ${e.message} (${JSON.stringify(e.params.allowedValue)})`;
  }
  return `${at}: ${e.message}`;
}
