import fs from 'node:fs';
import path from 'node:path';
import {
  loadDeck, resolveAssets, briefDigest, resolveSlotRef, slotFileToken, slotKey,
} from '../deck.js';
import { DeckError, EXIT, usage } from '../util/fail.js';
import { ensureDir, writeAtomic } from '../util/fs.js';
import { writeReport } from '../util/report.js';

/**
 * `deck prompts [--slot ID] [--out FILE]`
 *
 * THE MANUAL CHATGPT WORKFLOW. There is no image-generation API here by
 * decision: the PO draws the illustrations by hand in ChatGPT, and deck's job
 * is to emit a prompt that stands alone and to accept the file that comes
 * back.
 *
 * "Paste-ready" is the acceptance test, and it is a strong one: a person must
 * be able to take ONE entry to ChatGPT, get an image, and run the printed
 * import command with no further thought. So every entry carries, in order:
 *
 *   - which slide the slot belongs to, and what the slide is FOR
 *   - the exact pixel size and the aspect ratio
 *   - the theme's style brief, INLINED, so the prompt needs no attachment to
 *     be intelligible
 *   - what to depict, from the slide's purpose and the slot's own brief
 *   - an explicit no-text instruction
 *   - which reference images to attach, named - or an honest note when the
 *     theme ships none
 *   - the exact `deck gate assets import` command, ready to copy
 *
 * The register follows the PO's own house style in the design kit's
 * モック作例/生成プロンプト.txt: a Japanese metadata header, then an English
 * prompt body in topic paragraphs, literal strings introduced with the word
 * `exactly`, hex colours inline in prose, approximate dimensions given as
 * "about NxM", and a closing block of explicit negatives.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function promptsCommand(argv) {
  let only = null;
  let out = null;
  let single = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--slot') {
      if (!argv[i + 1]) usage('--slot requires a slot id');
      only = argv[i + 1];
      i += 1;
    } else if (a === '--single') {
      single = true;
    } else if (a === '--out') {
      if (!argv[i + 1]) usage('--out requires a file path');
      out = argv[i + 1];
      i += 1;
    } else {
      usage(`unknown argument for deck prompts: ${a}`);
    }
  }
  if (single && only !== null) {
    usage('deck prompts --single and --slot do nothing together', [
      '--single emits ONE brief covering every slot, to paste into a single ChatGPT conversation.',
      '--slot emits ONE slot, for regenerating a single image later.',
      'Pick one.',
    ]);
  }

  const { root, p, storyboard, theme, manifest, request } = loadDeck();
  const assets = resolveAssets(root, manifest, storyboard);
  const styleBrief = readStyleBrief(theme);
  const refs = theme.__referenceImages;

  /** @type {{slide: any, slot: any}[]} */
  const all = [];
  for (const slide of storyboard.slides) {
    for (const slot of slide.slots || []) all.push({ slide, slot });
  }

  if (only !== null) {
    // RESOLVED, NOT SEARCHED. `all.find` took the first slot with that id,
    // and now that two slides can each have a col-1-art, "the first" is an
    // arbitrary slide. Same resolver the import command uses, so the two
    // cannot disagree about what a bare id means.
    const ref = resolveSlotRef(storyboard, only);
    if (ref && ref.ambiguous) {
      usage(`"${only}" is a slot on ${ref.ambiguous.length} slides`, [
        'Name the slide too:',
        ...ref.ambiguous.map((k) => `  deck gate prompts --slot ${k}`),
      ]);
    }
    if (!ref) {
      usage(`no slot "${only}" in this deck`, [
        `Slots: ${all.map(({ slide, slot }) => slotKey(slide.id, slot.id)).join(', ') || '(none)'}`,
      ]);
    }
    const found = { slide: ref.slide, slot: ref.slot };
    // REUSE_UNCHANGED APPLIES HERE TOO. The combined output already excluded
    // these, but naming one explicitly still printed a full regeneration
    // prompt - which flatly contradicts the promise that a real photo, logo,
    // product screen or QR code is never regenerated. The restriction belongs
    // to the slot, not to the code path that happens to reach it.
    if (found.slot.reuse_unchanged) {
      throw new DeckError(
        `slot "${only}" is marked reuse_unchanged, so deck does not emit a generation prompt for it`,
        EXIT.USAGE,
        [
          `Brief: ${found.slot.brief}`,
          'These are real photos, logos, product screens and QR codes: never regenerated, never recoloured,',
          'never cropped in a way that loses content. Supply the real file instead:',
          '',
          `  deck gate assets import ${slotKey(found.slide.id, found.slot.id)} <file>`,
        ],
      );
    }
    // One slot at a time goes to stdout, so it can be piped to pbcopy.
    process.stdout.write(`${entry(found.slide, found.slot, { theme, request, styleBrief, refs, assets })}\n`);
    return EXIT.OK;
  }

  if (single) {
    return writeSingleBrief({
      root, p, out, generated: all.filter(({ slot }) => !slot.reuse_unchanged),
      reused: all.filter(({ slot }) => slot.reuse_unchanged),
      theme, request, styleBrief, refs, assets,
    });
  }

  const generated = all.filter(({ slot }) => !slot.reuse_unchanged);
  const reused = all.filter(({ slot }) => slot.reuse_unchanged);

  const body = [
    '# deck prompts',
    '',
    `Deck: **${request.request.project_name}** - theme \`${theme.name}\``,
    '',
    'Each entry below is self-contained. Take one to ChatGPT, attach the',
    'reference images it names, paste the prompt, save the image it returns,',
    'then run the import command at the bottom of the entry.',
    '',
    `Generated at ${new Date().toISOString()}`,
    '',
    ...(reused.length > 0 ? [
      '## Slots deck will NOT ask ChatGPT for',
      '',
      'These are marked `reuse_unchanged`: real photos, logos, product screens,',
      'QR codes. They are never regenerated, never recoloured, and never cropped',
      'in a way that loses content. Import the real file and deck will fit it with',
      'aspect-preserving containment, leaving the bytes untouched.',
      '',
      ...reused.map(({ slide, slot }) => `- \`${slot.id}\` on slide \`${slide.id}\` - ${slot.brief}\n  \`\`\`\n  deck gate assets import ${slotKey(slide.id, slot.id)} /path/to/the/real/file.png\n  \`\`\``),
      '',
    ] : []),
    '## Illustration prompts',
    '',
    ...(generated.length === 0 ? ['_This deck declares no illustration slots._', ''] : []),
    ...generated.map(({ slide, slot }) => entry(slide, slot, { theme, request, styleBrief, refs, assets })),
  ].join('\n');

  const target = out ? path.resolve(out) : p.promptsMd;
  ensureDir(path.dirname(target));
  writeAtomic(target, `${body}\n`);

  writeReport({
    dir: p.out,
    name: 'prompts',
    command: 'prompts',
    process: 'ok',
    verdict: 'pass',
    summary: `${generated.length} illustration prompt(s) emitted, ${reused.length} reuse-unchanged slot(s) listed`,
    body: {
      file: path.relative(root, target),
      counts: { prompts: generated.length, reuse_unchanged: reused.length, filled: Object.keys(assets).length },
      reference_images: refs,
      reference_images_available: refs.length > 0,
      theme: theme.name,
      slots: all.map(({ slide, slot }) => ({
        slot_id: slot.id,
        slide_id: slide.id,
        reuse_unchanged: slot.reuse_unchanged === true,
        width_px: slot.width_px,
        height_px: slot.height_px,
        brief_digest: briefDigest(slot),
        filled: Boolean(assets[slotKey(slide.id, slot.id)]),
        stale: Boolean(assets[slotKey(slide.id, slot.id)]?.stale),
        import_command: `deck gate assets import ${slotKey(slide.id, slot.id)} <file>`,
      })),
    },
  });

  process.stdout.write(`deck prompts: wrote ${generated.length} prompt(s) to ${path.relative(process.cwd(), target) || target}\n`);
  if (reused.length > 0) {
    process.stdout.write(`  ${reused.length} reuse-unchanged slot(s) listed separately; deck asks ChatGPT for none of them\n`);
  }
  if (refs.length === 0) {
    process.stdout.write(`  NOTE: theme "${theme.name}" ships no reference images, so the prompts say so instead of naming files that do not exist.\n`);
    process.stdout.write(`        Put your own style references in ${theme.__referenceDir} and re-run.\n`);
  }
  const stale = all.filter(({ slide, slot }) => assets[slotKey(slide.id, slot.id)]?.stale);
  for (const { slide, slot } of stale) {
    process.stdout.write(`  slot "${slot.id}" (slide ${slide.id}) has an imported asset whose brief has since CHANGED - it needs re-requesting\n`);
  }
  return EXIT.OK;
}

/** @param {any} theme */
function readStyleBrief(theme) {
  if (!theme.__styleBrief || !fs.existsSync(theme.__styleBrief)) {
    return null;
  }
  const text = fs.readFileSync(theme.__styleBrief, 'utf8');
  // The brief is inlined into the prompt, so its heading and its notes to
  // theme authors are stripped: the prompt has to read as a prompt, not as a
  // quoted document.
  //
  // The comment strip is a BLOCK match, not a line filter. HTML comments in
  // Markdown routinely span several lines, and filtering lines that start
  // with `<!--` removed the opening line and pasted the rest of the comment
  // into the middle of a prompt sent to ChatGPT.
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#[^\n]*\n/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One paste-ready entry.
 * @param {any} slide
 * @param {any} slot
 */
function entry(slide, slot, { theme, request, styleBrief, refs, assets }) {
  const ratio = aspectRatio(slot.width_px, slot.height_px);
  const existing = assets[slotKey(slide.id, slot.id)];
  const lines = [];

  lines.push(`### \`${slot.id}\` - slide \`${slide.id}\` (${slide.page_type})`);
  lines.push('');
  if (existing && !existing.stale) {
    lines.push(`> This slot is ALREADY FILLED by \`${existing.stored_file}\` (sha256 \`${existing.sha256.slice(0, 16)}...\`).`);
    lines.push('> The brief has not changed since it was imported, so it does not need regenerating.');
    lines.push('> Moving or resizing the container does not require a new image.');
    lines.push('');
  } else if (existing && existing.stale) {
    lines.push(`> This slot is filled by \`${existing.stored_file}\`, but the brief has CHANGED since that import.`);
    lines.push('> Regenerate with the prompt below and import again.');
    lines.push('');
  }

  // --- the Japanese metadata header, as in the PO's own prompt file ------
  lines.push('```text');
  lines.push('用途: 資料内イラスト枠の生成');
  lines.push(`対象スライド: ${slide.id}（${slide.page_type}）`);
  lines.push(`枠ID: ${slot.id}`);
  lines.push(`出力サイズ: ${slot.width_px}x${slot.height_px} px（アスペクト比 ${ratio}）`);
  lines.push(`資料の目的: ${request.request.purpose}`);
  lines.push(`想定読者: ${request.request.audience}`);
  lines.push(`添付する参考画像: ${refs.length > 0 ? refs.join('、') : 'なし（下記の注記を参照）'}`);
  lines.push('前提: 画像内に文字・数字・ロゴを一切入れない。文字はすべて資料側のHTML/CSSが描画する。');
  lines.push('');
  lines.push('使用するプロンプト');
  lines.push('');

  // --- the English prompt body ------------------------------------------
  lines.push('Use case: editorial illustration for a Japanese business slide.');
  lines.push(`Asset: a single ${slot.width_px}x${slot.height_px} px illustration (aspect ratio ${ratio}) that will be placed into a reserved frame on one slide. It is artwork for a slide, not a slide.`);
  lines.push('');
  lines.push(`Output composition: exactly one image, ${slot.width_px}x${slot.height_px} px, aspect ratio ${ratio}. No collage, no panels, no before/after comparison, no device mockup frame, no drop shadow around the whole image, no border. The subject sits inside the frame with comfortable margins and is not cropped at an awkward point.`);
  lines.push('');
  lines.push(`What it must depict: ${slot.brief}`);
  lines.push(`The slide it supports is for: ${slide.purpose}`);
  if (slide.title) lines.push(`The slide's heading reads "${slide.title}" - the illustration should sit beside that idea, and must NOT render those words.`);
  lines.push('');
  if (styleBrief) {
    lines.push('Style, inlined so this prompt stands alone:');
    lines.push('');
    lines.push(styleBrief);
    lines.push('');
  } else {
    lines.push(`Style: theme "${theme.name}" ships no style brief, so no style guidance can be inlined here. Add one at ${theme.slots?.style_brief_file || 'style-brief.md'} in the theme directory and re-run \`deck prompts\`.`);
    lines.push('');
  }
  lines.push(`Palette, as hex values: the page sits on ${theme.colors.page_bg.hex}; the deck's heading navy is ${theme.colors.heading_navy.hex}; its teal accent is ${theme.colors.accent_teal.hex}; its second accent is ${theme.colors.rule_orange.hex}. Keep the illustration in that family, softly and without saturation spikes. Real photographic colours - skin, wood, foliage, stone - stay natural.`);
  lines.push('');
  lines.push('Important, and these are hard constraints:');
  lines.push('- Put NO text, letters, numbers, labels, captions, watermarks, signatures or logos in the image. Not in any language, not small, not blurred, not as decorative lettering. Every word on the slide is drawn by the deck itself; a word baked into this image cannot be corrected without regenerating it, which is precisely the failure this workflow exists to avoid.');
  lines.push('- No page numbers, no UI chrome, no browser window, no slide frame.');
  lines.push('- Do not invent a company name, a place name, a price, a date or a statistic.');
  lines.push('- Flat, crisp rendering. No embossing, no heavy gloss, no lens flare, no perspective tilt on the whole image.');
  lines.push('- Leave the background transparent or a flat wash matching the page colour; do not paint a hard rectangle edge.');
  lines.push('```');
  lines.push('');

  // --- attachments -------------------------------------------------------
  if (refs.length > 0) {
    // RELATIVE, not absolute. prompts.md is pasted into a chat with a third
    // party, and an absolute path carries the user's name and their whole
    // directory layout with it.
    lines.push(`**Attach these to ChatGPT for style consistency** (in the theme's \`reference/\` directory, theme \`${theme.name}\`):`);
    lines.push('');
    for (const r of refs) lines.push(`- \`${r}\``);
  } else {
    lines.push('**Reference images to attach:** none.');
    lines.push('');
    lines.push(`Theme \`${theme.name}\` ships no \`reference/*.png\`. deck says so here rather than naming`);
    lines.push('files that do not exist. The deck this theme was measured from is confidential client');
    lines.push('material and does not belong in a shared repository, so the images could not be bundled.');
    lines.push('Put one or two of your own finished pages in the theme\'s `reference/` directory and re-run');
    lines.push('`deck prompts`; every entry will then name them. Consider `deck prompts --single` instead:');
    lines.push('one conversation keeps the style consistent without reference images.');
  }
  lines.push('');

  // --- the import command -----------------------------------------------
  lines.push('**Then run, with the file ChatGPT gave you:**');
  lines.push('');
  lines.push('```sh');
  lines.push(`deck gate assets import ${slotKey(slide.id, slot.id)} ~/Downloads/<the-file-chatgpt-gave-you>.png`);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/** @param {number} w @param {number} h */
export function aspectRatio(w, h) {
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * `deck prompts --single` - ONE pasteable brief covering the whole deck.
 *
 * The PO's own words for what they wanted:
 *
 *   アウトプットの中にどこにどういう画像をつけろみたいなプロンプトも一緒に
 *   含めてもらってそのままchatgptのchatに貼る、みたいなのが楽かもね
 *
 * So: one block of text that already says where each image goes and what it
 * must depict, pasted into a single conversation.
 *
 * This is a QUALITY fix as much as an ergonomic one. The theme ships no
 * reference images - they would have to come from confidential client work -
 * and without them each slot generated in its own conversation comes back in
 * a different style. One conversation IS the shared visual anchor: the style
 * brief is stated once at the top and every subsequent image inherits the
 * context of the ones before it.
 *
 * The text must survive being pasted into a chat box as PLAIN TEXT, so
 * nothing here depends on Markdown rendering for its meaning: no bold for
 * emphasis that matters, no tables, no nested lists. Rules are drawn with
 * dashes and structure is carried by blank lines and numbering.
 */
function writeSingleBrief({ root, p, out, generated, reused, theme, request, styleBrief, refs, assets }) {
  const L = [];
  const rule = '='.repeat(70);
  const thin = '-'.repeat(70);

  L.push(rule);
  L.push(`ILLUSTRATIONS FOR: ${request.request.project_name}`);
  L.push(rule);
  L.push('');
  L.push(`This deck needs ${generated.length} illustration${generated.length === 1 ? '' : 's'}.`);
  L.push('I will ask for them ONE AT A TIME, in the order listed below.');
  L.push('');
  L.push('HOW I WOULD LIKE TO WORK');
  L.push('');
  L.push('  1. Read the STYLE and the RULES below. They apply to every image.');
  L.push('  2. Generate IMAGE 1 only. Do not generate the others yet.');
  L.push('  3. I will save it and say "next".');
  L.push('  4. Generate IMAGE 2, holding the style identical to IMAGE 1.');
  L.push('  5. Continue in order until all images are done.');
  L.push('');
  L.push('Keeping every image in this one conversation is the point: each new');
  L.push('image should look like it came from the same hand as the previous');
  L.push('ones. If a later image drifts from the earlier ones, match the');
  L.push('earlier ones.');
  L.push('');

  L.push(thin);
  L.push('RULES THAT APPLY TO EVERY IMAGE');
  L.push(thin);
  L.push('');
  L.push('  * PUT NO TEXT IN THE IMAGE. No letters, no numbers, no labels, no');
  L.push('    captions, no watermarks, no signatures, no logos, no UI labels.');
  L.push('    Not in any language, not small, not blurred, not as decorative');
  L.push('    lettering.');
  L.push('');
  L.push('    This matters more than it looks. Every word on these slides is');
  L.push('    drawn by the document itself, so a word baked into one of these');
  L.push('    pictures cannot be corrected or translated later without');
  L.push('    regenerating the picture.');
  L.push('');
  L.push('  * One complete image each time. No collage, no panels, no');
  L.push('    before/after pairs, no device mockup frames, no borders.');
  L.push('  * Do not invent a company name, a place name, a price, a date or a');
  L.push('    statistic.');
  L.push('  * Flat and crisp. No embossing, no heavy gloss, no lens flare, no');
  L.push('    perspective tilt applied to the whole image.');
  L.push('  * Leave the edges soft against a plain background. Do not paint a');
  L.push('    hard rectangle edge.');
  L.push('');

  L.push(thin);
  L.push('STYLE — the same for all of them');
  L.push(thin);
  L.push('');
  if (styleBrief) {
    for (const line of styleBrief.split('\n')) L.push(line ? `  ${line}` : '');
  } else {
    L.push(`  Theme "${theme.name}" ships no style brief, so there is no style`);
    L.push('  guidance to inline here. Add one and re-run `deck prompts --single`.');
  }
  L.push('');
  L.push('  Palette, as hex values:');
  L.push(`    page background  ${theme.colors.page_bg.hex}`);
  L.push(`    heading navy     ${theme.colors.heading_navy.hex}`);
  L.push(`    teal accent      ${theme.colors.accent_teal.hex}`);
  L.push(`    second accent    ${theme.colors.rule_orange.hex}`);
  L.push('  Keep the illustrations in that family, softly and without');
  L.push('  saturation spikes. Real photographic colours — skin, wood,');
  L.push('  foliage, stone — stay natural.');
  L.push('');

  L.push(thin);
  L.push(`THE IMAGES — ${generated.length} in total, in this order`);
  L.push(thin);
  L.push('');
  if (generated.length === 0) {
    L.push('  (this deck declares no illustration slots)');
    L.push('');
  }
  generated.forEach(({ slide, slot }, i) => {
    const n = i + 1;
    const ratio = aspectRatio(slot.width_px, slot.height_px);
    L.push(`IMAGE ${n} of ${generated.length}   —   file name: ${filenameFor(slide, slot, n)}`);
    L.push('');
    L.push(`  Goes on   : slide "${slide.id}" (${slide.page_type}), ${placementOf(slide, slot, theme)}`);
    L.push(`  Size      : ${slot.width_px} x ${slot.height_px} px, aspect ratio ${ratio}`);
    L.push(`  That slide: ${slide.purpose}`);
    if (slide.title) L.push(`  Its heading reads "${slide.title}" — do NOT render those words in the image.`);
    L.push('');
    L.push('  Depict:');
    for (const line of wrap(slot.brief, 64)) L.push(`    ${line}`);
    L.push('');
    L.push('  (No text, letters, numbers or logos inside this image.)');
    L.push('');
    const existing = assets[slotKey(slide.id, slot.id)];
    if (existing && !existing.stale) {
      L.push('  NOTE: this slot is already filled and does not need regenerating.');
      L.push('  Skip it unless I say otherwise.');
      L.push('');
    } else if (existing && existing.stale) {
      L.push('  NOTE: this slot has an image already, but its brief has changed.');
      L.push('  Please generate a replacement.');
      L.push('');
    }
  });

  if (refs.length > 0) {
    L.push(thin);
    L.push('REFERENCE IMAGES');
    L.push(thin);
    L.push('');
    L.push('  I am attaching these to this conversation. Match their style.');
    for (const r of refs) L.push(`    - ${r}`);
    L.push('');
  }

  if (reused.length > 0) {
    L.push(thin);
    L.push('NOT FOR YOU TO GENERATE — I supply these myself');
    L.push(thin);
    L.push('');
    L.push('  Listed so the deck\'s image inventory is complete and nothing');
    L.push('  looks forgotten. These are real photographs, logos, product');
    L.push('  screens or QR codes. They are never regenerated.');
    L.push('');
    for (const { slide, slot } of reused) {
      L.push(`    ${slot.id}  (slide "${slide.id}")  —  ${slot.brief}`);
    }
    L.push('');
  }

  L.push(rule);
  L.push('END OF BRIEF — the rest is for me, not for you');
  L.push(rule);
  L.push('');
  // THE HANDOVER, AS ONE INSTRUCTION. Listing an import command per image
  // asks the PO to match file names to slot ids by hand, which is the one step
  // in this flow where a mistake is invisible: a wrong illustration in the
  // right slot renders cleanly and lint cannot see it. The file names above
  // already carry the slot id, so the drop directory can do the matching.
  // A RELATIVE PATH, NOT AN ABSOLUTE ONE. This file is pasted into ChatGPT,
  // and an absolute path carries the PO's name and directory layout - which
  // for this tool means client names. The agent tells them the full path in
  // the pane, where it goes to nobody else.
  L.push('Save each returned image under the file name given with it, then put');
  L.push('all of them in the deck\'s drop directory:');
  L.push('');
  L.push('  inbox/');
  L.push('');
  generated.forEach(({ slide, slot }, i) => {
    L.push(`  ${filenameFor(slide, slot, i + 1)}   ->  ${slotKey(slide.id, slot.id)}`);
  });
  if (reused.length > 0) {
    L.push('');
    L.push('And the ones you are supplying yourself (real photos, logos, screens):');
    for (const { slot } of reused) {
      L.push(`  <your file>   ->  slot ${slot.id}   (name it ${slot.id}.png)`);
    }
  }
  L.push('');
  L.push('Then say so, and they are imported by name - no paths to type:');
  L.push('');
  L.push('  deck gate inbox');
  L.push('');
  L.push('Anything it cannot place is listed rather than guessed at.');
  L.push('');

  const body = L.join('\n');
  const target = out ? path.resolve(out) : path.join(p.out, 'prompts-single.md');
  ensureDir(path.dirname(target));
  writeAtomic(target, `${body}\n`);

  writeReport({
    dir: p.out,
    name: 'prompts-single',
    command: 'prompts',
    process: 'ok',
    verdict: 'pass',
    summary: `one combined brief for ${generated.length} illustration(s), ${reused.length} supplied by hand`,
    body: {
      file: path.relative(root, target),
      mode: 'single',
      counts: { prompts: generated.length, reuse_unchanged: reused.length },
      reference_images: refs,
      images: generated.map(({ slide, slot }, i) => ({
        order: i + 1,
        slot_id: slot.id,
        slide_id: slide.id,
        filename: filenameFor(slide, slot, i + 1),
        width_px: slot.width_px,
        height_px: slot.height_px,
        import_command: `deck gate assets import ${slotKey(slide.id, slot.id)} <file>`,
      })),
    },
  });

  process.stdout.write(`deck prompts --single: one brief for ${generated.length} illustration(s)\n`);
  process.stdout.write(`  ${path.relative(process.cwd(), target) || target}\n`);
  if (reused.length > 0) {
    process.stdout.write(`  ${reused.length} slot(s) marked reuse_unchanged are listed as yours to supply, not to generate\n`);
  }
  if (refs.length === 0) {
    process.stdout.write('  NOTE: this theme ships no reference images. One conversation is the next best\n');
    process.stdout.write('        anchor for a consistent style, which is what --single is for.\n');
  }
  process.stdout.write('\nPaste the whole file into one ChatGPT conversation and work down it.\n');
  return EXIT.OK;
}

/**
 * The returned file's name, which maps it back to its slot unambiguously.
 *
 * The ordinal is first so the files sort in the order they were asked for,
 * and the SLIDE AND SLOT are both in the name so an import is never a guess.
 *
 * The slide id is in there because `col-1-art` names a position on a page
 * type, not one picture: a deck with four three-column slides asks for twelve
 * illustrations and three of them are "the first column's". Without the slide
 * id the PO gets back twelve files with four distinct names, and `inbox` is
 * reduced to guessing - which is exactly what it exists to avoid.
 *
 * @param {any} slide @param {any} slot @param {number} n
 */
export function filenameFor(slide, slot, n) {
  return `${String(n).padStart(2, '0')}-${slotFileToken(slide.id, slot.id)}.png`;
}

/** Where on the slide the image sits, in words rather than coordinates. */
function placementOf(slide, slot, theme) {
  const g = (theme.page_types?.[slide.page_type]?.slots || {})[slot.id] || {};
  // A FLOW SLOT HAS NO COORDINATES, and saying nothing about where it goes is
  // how an illustration comes back composed for the wrong shape. These are
  // laid out by the template, so the template's own words are the answer.
  if (g.flow === 'card-art') {
    return `the picture at the TOP of column ${g.card} of three, above that column's heading`;
  }
  if (g.flow === 'diagram-art') {
    // THE SIZE IS REPRESENTATIVE, NOT EXACT, and saying so is the point. The
    // band absorbs whatever the diagram above it did not use, so its height
    // depends on that diagram's content. An illustration whose subject sits
    // hard against the top or bottom edge loses it to the crop.
    return 'a wide band across the FULL WIDTH of the page, under the diagram - a landscape strip, not a square. '
      + 'It is cropped to the band, which may be a little shorter than the size below, so keep the subject away from the top and bottom edges';
  }
  const parts = [];
  if (g.right === 0) parts.push('against the right edge');
  else if (g.left === 0) parts.push('against the left edge');
  else if (typeof g.left === 'number') parts.push(`${g.left} px from the left`);
  if (g.top === 0) parts.push('running to the top');
  else if (typeof g.top === 'number') parts.push(`${g.top} px from the top`);
  if (g.zone === 'bleed') parts.push('bleeding off the page');
  const full = slot.width_px >= theme.canvas.width * 0.4 ? 'a large panel' : 'a small panel';
  return parts.length ? `${full} ${parts.join(', ')}` : full;
}

/** Wrap to a width, so a long brief stays readable pasted as plain text. */
function wrap(text, width) {
  const out = [];
  let line = '';
  // Japanese does not use spaces, so wrapping is per character with a
  // latin-word guard: breaking mid-word in English reads worse than a long
  // line, while breaking between kana is normal.
  for (const ch of String(text)) {
    line += ch;
    if (line.length >= width && !/[A-Za-z0-9]$/.test(line)) {
      out.push(line);
      line = '';
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}
