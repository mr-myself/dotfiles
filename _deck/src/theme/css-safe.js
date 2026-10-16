import { DeckError, EXIT } from '../util/fail.js';

/**
 * Sanitisers for everything a theme contributes to a stylesheet or a style
 * attribute.
 *
 * WHY THIS FILE EXISTS. A theme is data, and `deck.yaml` can override any of
 * its tokens. That data was being interpolated straight into a `<style>`
 * element and into `style="..."` attributes, so a schema-valid deck.yaml could
 * ship executable HTML. Both of these were reproduced:
 *
 *   fonts.stack: ['Evil</style><script>fetch(...)</script><style>']
 *   page_types.cover.slots.cover-art.left: '0px"><img src=x onerror=...><div z="'
 *
 * Neither is exotic: the first is just a string that reaches a stylesheet, the
 * second a string that reaches an attribute.
 *
 * The defence is layered, because each layer fails differently:
 *
 *   1. values that should be NUMBERS are parsed as numbers and rejected
 *      otherwise, so no string ever reaches a length;
 *   2. CSS identifiers are constrained to a conservative character class;
 *   3. CSS strings are escaped with CSS hex escapes, which is what CSS
 *      actually specifies, rather than with HTML entities, which a stylesheet
 *      does not decode;
 *   4. the assembled stylesheet is checked for anything that could terminate
 *      the style element, as a backstop in case a future token type is added
 *      and someone forgets steps 1 to 3.
 *
 * Layer 4 is what makes this safe against the NEXT mistake rather than only
 * the two that were found.
 */

/**
 * A finite number, or a refusal naming the token.
 * @param {unknown} value
 * @param {string} where for the error message
 * @returns {number}
 */
export function cssNumber(value, where) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A numeric STRING is accepted only when it is exactly a number: "12" and
  // "1.5" are fine; "12px", '0px"><img' and "calc(1)" are not.
  if (typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  throw new DeckError(`${where} must be a plain number`, EXIT.VERDICT_FAILED, [
    `Got: ${JSON.stringify(value)}`,
    'Theme geometry is interpolated into CSS, so only numbers are accepted. Units are added by deck.',
  ]);
}

/** A number formatted as a CSS pixel length. @param {unknown} v @param {string} where */
export function cssPx(v, where) {
  return `${cssNumber(v, where)}px`;
}

/**
 * A #rrggbb colour, or a refusal.
 * @param {unknown} value
 * @param {string} where
 */
export function cssColor(value, where) {
  if (typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value.trim())) return value.trim();
  throw new DeckError(`${where} must be a #rrggbb colour`, EXIT.VERDICT_FAILED, [
    `Got: ${JSON.stringify(value)}`,
  ]);
}

/**
 * A CSS custom-property name fragment: letters, digits, hyphen, underscore.
 *
 * Token names become `--deck-color-<name>`, so a name containing a colon or a
 * semicolon would end the declaration and start another.
 *
 * @param {unknown} value
 * @param {string} where
 */
export function cssIdent(value, where) {
  if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) return value;
  throw new DeckError(`${where} is not a usable CSS identifier`, EXIT.VERDICT_FAILED, [
    `Got: ${JSON.stringify(value)}`,
    'Allowed: a letter or underscore, then letters, digits, hyphens and underscores.',
  ]);
}

/**
 * A quoted CSS string, escaped the way CSS specifies.
 *
 * Every character that could end the string, the declaration, a comment or the
 * surrounding element becomes a CSS hex escape. HTML entity escaping would be
 * WRONG here: a stylesheet does not decode entities, so `&quot;` inside a font
 * name is a literal ampersand-q-u-o-t and the quote is still unescaped.
 *
 * @param {unknown} value
 * @param {string} where
 */
export function cssString(value, where) {
  if (typeof value !== 'string') {
    throw new DeckError(`${where} must be a string`, EXIT.VERDICT_FAILED, [`Got: ${JSON.stringify(value)}`]);
  }
  const escaped = value.replace(/[^A-Za-z0-9  -￿_.-]/g, (ch) => {
    // A CSS hex escape, space-terminated so the following character cannot be
    // absorbed into it.
    const code = ch.codePointAt(0).toString(16);
    return `\\${code} `;
  });
  return `"${escaped}"`;
}

/** Generic font families are CSS KEYWORDS: quoting one stops it being generic. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

/**
 * A font-family list, each entry quoted and escaped.
 * @param {unknown} stack
 * @param {string} where
 */
export function cssFontStack(stack, where) {
  if (!Array.isArray(stack) || stack.length === 0) {
    throw new DeckError(`${where} must be a non-empty list of family names`, EXIT.VERDICT_FAILED);
  }
  return stack.map((f, i) => {
    if (typeof f !== 'string') {
      throw new DeckError(`${where}[${i}] must be a string`, EXIT.VERDICT_FAILED);
    }
    // The generic set is closed, so this branch cannot be an injection seam.
    return GENERIC_FAMILIES.has(f.trim()) ? f.trim() : cssString(f, `${where}[${i}]`);
  }).join(', ');
}

/**
 * THE BACKSTOP. Refuse a stylesheet that could escape its own element.
 *
 * Runs over the fully assembled stylesheet, after every token has been through
 * the sanitisers above, so it should never fire. That is the point: if it ever
 * does, a new token type reached the stylesheet without being sanitised, and
 * deck stops instead of shipping a page with a script in it.
 *
 * @param {string} css
 * @param {string} where
 */
export function assertInertStylesheet(css, where) {
  const lowered = css.toLowerCase();
  for (const needle of ['</style', '<script', '<!--', '-->', '</svg', '<iframe', 'javascript:']) {
    const at = lowered.indexOf(needle);
    if (at !== -1) {
      throw new DeckError(
        `${where} contains "${needle}", which could terminate the stylesheet or start markup`,
        EXIT.PROCESS_FAILED,
        [
          `Near: ...${css.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ')}...`,
          "This is deck's backstop against a theme token reaching CSS unsanitised.",
        ],
      );
    }
  }
  return css;
}
