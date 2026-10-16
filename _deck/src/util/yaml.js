import fs from 'node:fs';
import YAML from 'yaml';
import { DeckError, EXIT } from './fail.js';

/**
 * Parse YAML strictly. Duplicate keys and tab indentation are errors, not
 * warnings: a storyboard is the content source of truth and a silently
 * dropped duplicate `title:` would lose the PO's words.
 *
 * @param {string} text
 * @param {string} label path used in the error message
 * @returns {any}
 */
export function parseYaml(text, label) {
  /** @type {YAML.Document.Parsed} */
  let doc;
  try {
    doc = YAML.parseDocument(text, { uniqueKeys: true, strict: true });
  } catch (err) {
    throw new DeckError(`${label}: could not be parsed as YAML`, EXIT.VERDICT_FAILED, [
      String(err && err.message ? err.message : err),
    ]);
  }
  if (doc.errors.length > 0) {
    throw new DeckError(`${label}: could not be parsed as YAML`, EXIT.VERDICT_FAILED,
      doc.errors.map((e) => e.message));
  }
  if (doc.warnings.length > 0) {
    throw new DeckError(`${label}: YAML that parses but is not trustworthy`, EXIT.VERDICT_FAILED,
      doc.warnings.map((w) => w.message));
  }
  const value = doc.toJS({ mapAsMap: false });
  if (value === null || value === undefined) {
    throw new DeckError(`${label}: is empty`, EXIT.VERDICT_FAILED);
  }
  return value;
}

/** @param {string} file @returns {any} */
export function loadYaml(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new DeckError(`could not read ${file}`, EXIT.PROCESS_FAILED, [String(err.message)]);
  }
  return parseYaml(text, file);
}
