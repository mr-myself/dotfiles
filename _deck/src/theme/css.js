import { DeckError, EXIT } from '../util/fail.js';
import { assertInertStylesheet, cssColor, cssFontStack, cssIdent, cssNumber, cssString } from './css-safe.js';

/**
 * Turn theme tokens into CSS custom properties.
 *
 * deck.css refers only to --deck-* properties, so the theme's VALUES live in
 * theme.yaml and the theme's ARRANGEMENT lives in the stylesheet, and neither
 * duplicates the other. Changing a colour is a one-line YAML edit with no CSS
 * change, which is what "a theme is data" has to mean in practice.
 *
 * EVERY VALUE HERE IS SANITISED. These tokens are overridable from deck.yaml,
 * so they are untrusted input that lands inside a <style> element: a font-family
 * entry containing `</style><script>...` was a working injection. Names go
 * through cssIdent, lengths through cssNumber, colours through cssColor, and
 * family names through cssFontStack, which CSS-escapes rather than
 * HTML-escapes. See theme/css-safe.js.
 *
 * @param {any} theme
 * @returns {string}
 */
export function themeVariables(theme) {
  const lines = [];
  const px = (v, where) => `${cssNumber(v, where)}px`;

  lines.push(`  --deck-canvas-w: ${px(theme.canvas.width, 'canvas.width')};`);
  lines.push(`  --deck-canvas-h: ${px(theme.canvas.height, 'canvas.height')};`);
  for (const [side, v] of Object.entries(theme.canvas.safe_margins_px)) {
    const name = cssIdent(side, `canvas.safe_margins_px.${side}`);
    lines.push(`  --deck-margin-${name}: ${px(v, `canvas.safe_margins_px.${side}`)};`);
  }
  for (const [rawName, token] of Object.entries(theme.colors)) {
    const name = cssIdent(rawName, `colors.${rawName}`);
    lines.push(`  --deck-color-${name}: ${cssColor(token.hex, `colors.${rawName}.hex`)};`);
  }
  for (const [rawName, value] of Object.entries(theme.spacing || {})) {
    const name = cssIdent(rawName, `spacing.${rawName}`);
    // A [min, max] band has no single CSS value; the midpoint is used and the
    // band stays the lint contract. A scalar is used as written.
    const v = Array.isArray(value)
      ? (cssNumber(value[0], `spacing.${rawName}[0]`) + cssNumber(value[1], `spacing.${rawName}[1]`)) / 2
      : cssNumber(value, `spacing.${rawName}`);
    lines.push(`  --deck-space-${name}: ${v}px;`);
  }
  const p = theme.pagination.position;
  lines.push(`  --deck-folio-right: ${px(p.right_px, 'pagination.position.right_px')};`);
  lines.push(`  --deck-folio-bottom: ${px(p.bottom_px, 'pagination.position.bottom_px')};`);
  lines.push(`  --deck-folio-width: ${px(p.width_px, 'pagination.position.width_px')};`);
  lines.push(`  --deck-folio-height: ${px(p.height_px, 'pagination.position.height_px')};`);
  const r = theme.pagination.rule;
  if (r) {
    lines.push(`  --deck-folio-rule-right: ${px(r.right_px, 'pagination.rule.right_px')};`);
    lines.push(`  --deck-folio-rule-y: ${px(r.y_px, 'pagination.rule.y_px')};`);
    lines.push(`  --deck-folio-rule-width: ${px(r.width_px, 'pagination.rule.width_px')};`);
    lines.push(`  --deck-folio-rule-height: ${px(r.height_px, 'pagination.rule.height_px')};`);
    lines.push(`  --deck-folio-rule-color: ${cssColor(r.color, 'pagination.rule.color')};`);
  }
  // The cover's text-column ratio is a per-page-type token, so it is exposed
  // as a variable rather than written into the stylesheet as a literal.
  const coverRatio = theme.page_types?.cover?.text_area_ratio;
  if (coverRatio) {
    const ratio = Array.isArray(coverRatio) ? coverRatio[0] : coverRatio;
    lines.push(`  --deck-cover-text-ratio: ${cssNumber(ratio, 'page_types.cover.text_area_ratio')};`);
  }
  lines.push(`  --deck-font-stack: ${cssFontStack(theme.fonts.stack, 'fonts.stack')};`);
  return assertInertStylesheet(`:root {\n${lines.join('\n')}\n}`, 'the theme\'s generated custom properties');
}

/**
 * @font-face rules for the pinned fonts, as file:// URLs.
 *
 * Local files, no network. A render that reached out for a webfont would be a
 * render whose output depended on the network being up and on a CDN not having
 * changed a glyph, and neither belongs in a deliverable.
 *
 * @param {any} theme
 * @param {(absPath: string) => string} toUrl
 * @returns {string}
 */
export function fontFaces(theme, toUrl) {
  const faces = theme.fonts.pinned.map((f, i) => {
    const weights = f.variable && f.weights && f.weights.length > 1
      ? `${cssNumber(Math.min(...f.weights), `fonts.pinned[${i}].weights`)} ${cssNumber(Math.max(...f.weights), `fonts.pinned[${i}].weights`)}`
      : String(cssNumber((f.weights && f.weights[0]) || 400, `fonts.pinned[${i}].weights`));
    // The URL comes from pathToFileURL on a path deck resolved and verified,
    // so it is already percent-encoded; the family name is theme data and is
    // CSS-escaped.
    const url = toUrl(f.file);
    if (/["\\]/.test(url)) {
      throw new DeckError(`the font URL for ${f.family} contains a quote or backslash after encoding`, EXIT.PROCESS_FAILED, [url]);
    }
    return `@font-face {
  font-family: ${cssString(f.family, `fonts.pinned[${i}].family`)};
  src: url("${url}") format("truetype${f.variable ? '-variations' : ''}");
  font-weight: ${weights};
  font-style: normal;
  font-display: block;
}`;
  }).join('\n');
  return assertInertStylesheet(faces, 'the theme\'s generated @font-face rules');
}
