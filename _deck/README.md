# deck

AI-assisted slide production. A sibling of `squad` and `vet`: one executable,
no daemon, state on disk, machine-readable reports next to human ones.

**You give it a sentence. It interviews you and produces the deck.**

```
deck "野沢温泉 次回MTG資料"             launch: one agent, talking Japanese
deck "営業会議 11月" --source <url>     with the source given up front
deck list | resume | close | rm        lifecycle, as squad has
```

The agent asks for what it needs, reads your source material, agrees the
agenda with you, agrees the exact copy with you, writes `storyboard.yaml`
itself, renders, lints, **fixes what the linter finds**, and hands over a PDF.
You never open `storyboard.yaml`.

### Two layers

Everything below is **the gate**: deterministic, no agent, no network. The
agent runs these on itself, and you can run them directly.

```
deck gate init <dir>                   scaffold a deck workspace
deck gate doctor                       report Chrome, poppler, fonts, node
deck gate source                       was the material fully retrieved?
deck gate ledger                       does every quote occur in the source?
deck gate agenda                       is every open item on it or excluded?
deck gate copy                         the readable Japanese copy sheet
deck gate fidelity                     do the numbers trace to the source?
deck gate validate                     schema- and semantics-check the deck
deck gate approve agenda|content       record the SHA-256 of a revision
deck gate status                       phase, approved revision, slot state
deck gate prompts --single             ONE illustration brief for the deck
deck gate inbox                        import whatever was dropped in inbox/
deck gate render [--release]           storyboard -> HTML -> PDF -> PNGs
deck gate lint                         the layout gate, on measured geometry
deck gate export                       verify and list the deliverable
```

A bare `deck render` is refused by name rather than read as a deck titled
"render"; `deck -- render` is the escape hatch if that really is the title.

> The rest of this document discusses the gates by their short names -
> `deck lint`, `deck render --release` - because that is what they are called.
> The command to type is `deck gate lint`. Typing the short form prints the
> long one rather than doing something surprising.

### Why one agent and not three

`squad` runs two independent review lenses because judging code is subjective
and a second reader sees what the first missed. Here the review is `deck
lint`: twelve rules over measured geometry, the same answer every time. A
second opinion pane would spend tokens re-reading a deterministic result.

### What is checked rather than trusted

The agent writes the words, so the honesty of the deck cannot rest on asking
it nicely:

| gate | refuses |
|---|---|
| `source` | a partial fetch, read off the SAVED RESPONSE rather than the agent's account of it: an unfollowed pagination cursor, a block reporting `has_children` whose children were never listed, a declared block count that disagrees with the bytes, a `raw_file` that does not exist. An agenda built on half the minutes looks exactly like one built on all of it. |
| `ledger` | an entry whose `quote` does not occur in **the source it cites**. A paraphrase reads exactly like a quotation; this is the one check that catches an invented decision. Where the source genuinely does not state an owner or a period, `source_omits` records the absence - inventing that metadata is the failure this gate exists to prevent, so it must not be the only way past it. |
| `agenda` | an unresolved decision or pending action that is neither on the agenda nor in the exclusion list with a reason. Nobody can see an absence. Also anything whose `source_omits` is non-empty: a hole in the minutes is a question for the room. |
| `fidelity` | a number, date or table cell on a slide that appears in no source. The other half of content-integrity: that rule checks storyboard -> rendered DOM, this one checks source -> storyboard. |
| `copy` | nothing - it is a view. But its 【引用】/【作成】 marks are **computed** from the source text, so the agent cannot label its own prose as a quotation. |

The repair loop's cap is a file the helper increments, not something the agent
is asked to remember: a cap policed by an agent's memory of how many times it
has looped is a cap a long transcript loses. Resetting it is bound to a newly
approved revision of the wording, so it cannot be reset into oblivion.

`deck gate approve` refuses while any of those gates is failing. An approval
says "this is the revision to ship", and one recorded over a failing gate is
an approval the PO believes means the checks passed. `--force` exists for a PO
who accepts a finding knowingly, and every approval - forced or not - is
appended to `.deck/approvals/history.jsonl`.

**The agenda approval records `agenda.json`**, not the storyboard. The agenda
gate runs before the storyboard is written, so hashing the storyboard spine
meant every normal run approved the scaffold and then invalidated the approval
the moment the agent wrote a real title. The exclusions are in that digest:
the PO agreed to leave those things out, for those reasons.

## The idea

Authoritative text and layout live in **HTML/CSS on a fixed 16:9 pixel
canvas**, rendered by the installed Google Chrome to PDF and rasterized to PNG
with `pdftoppm`. Illustrations are images dropped into declared **slots**.

The seam is strict:

| HTML/CSS renders | slot images carry |
|---|---|
| section label, title, subtitle, body, cards, tables, rules, icon circles, footer banner, page number | watercolour illustrations, people, scenery, decorative washes |
| measurable geometry, one-word edits, no re-render churn | **no text, ever** |

Because the layout is real DOM, every geometry check is a **measurement**
rather than an opinion. That is the product.

### Why it exists

The reference deck this was built from is 23 slides, each one full-bleed
1672x941 PNG plus exactly two shapes: a white rectangle named `folio-cover`
and a text box named `page-number` holding "05/23".

Under that white rectangle, the PNG still says **"05/22"**. The deck grew from
22 pages to 23, every baked-in page number became wrong at once, and the fix
was to paint over the raster and overlay real text.

Anything that depends on the deck's structure must not be baked into a raster.
Here the folio is derived from the slide's index: inserting a slide renumbers
the deck and nothing is re-rendered.

## The illustration workflow

There is **no image-generation API**, by decision. The PO draws the
illustrations by hand in ChatGPT; `deck prompts` emits a prompt that stands
alone and `deck assets import` accepts the file that comes back.

### `deck prompts --single` — one paste, one conversation

The usual way to work. It writes `out/prompts-single.md`: the style brief once
at the top, an instruction to generate the images **one at a time in order in
that same conversation**, then every slot in deck order with where it goes, its
exact pixel size and aspect ratio, what it must depict, and a filename that maps
the returned file back to its slot. The closing section holds the import
commands.

That single conversation is not just convenience. The theme ships no reference
images — they would have to come from confidential client work — so without one
each slot generated separately comes back in a different style. One conversation
**is** the shared visual anchor.

It reads as plain text in a chat box: nothing depends on Markdown rendering.

### `deck prompts` and `--slot`

`deck prompts` writes one self-contained entry per slot to `out/prompts.md`;
`--slot ID` sends one entry to stdout, which is the right tool for regenerating
a single image later. `--single` and `--slot` are mutually exclusive.

Each entry carries the slot id and its slide, the exact pixel size and aspect
ratio, the theme's style brief **inlined**, what to depict (from the slide's
purpose and the slot's brief), an explicit no-text instruction, which
`reference/*.png` to attach, and the exact import command, ready to copy.

Slots marked `reuse_unchanged` never appear as something to generate, in any
mode — naming one with `--slot` is refused. `--single` lists them in a separate
section so the deck's image inventory stays complete.

Nothing deck writes for you to share carries an absolute local path.

An imported asset is **reused** when its container merely moves or resizes,
and is only re-requested when the slot's **brief** materially changes. The
PO's file is never mutated: it is copied, hashed, and fitted at render time
with aspect-preserving containment. Slots marked `reuse_unchanged` — real
photos, logos, product screens, QR codes — get no generation prompt at all.

## Approval

`deck approve agenda` signs off the spine: slide ids, order, page types,
titles. `deck approve content` signs off the exact words.

Both record a SHA-256 over a **canonical projection**, not over the file
bytes, so reformatting the YAML does not invalidate an approval while changing
one character of a title does. `subtitle: null` means an intentionally absent
subtitle and is part of the signed content: back-filling one breaks approval.

`deck render --release` refuses when the content digest does not match the
approved one, and says *what changed* — slide, field, approved wording,
current wording. A plain `deck render` is a preview and is always allowed: the
PO has to be able to look before approving.

Changing wording, slide order or slide count invalidates content approval.
Changing only the theme or the layout does not.

## Freshness: two digests, not one

The **content digest** answers "are these the approved words?" and deliberately
excludes the theme, the CSS, layout line breaks, slot geometry and which asset
fills a slot — because changing any of those must not invalidate a content
approval.

All of them change what the page looks like. So there is a second digest, the
**render fingerprint**, covering everything that can move a pixel: the content,
the layout, the theme's full token set, the stylesheet's bytes, which asset by
hash filled which slot, and the render scale.

`deck render` writes it into `out/geometry.json`. `deck lint` refuses geometry
whose fingerprint is not the current one, and says whether the words changed or
only the layout. `deck export` refuses a lint report that inspected a different
render. `deck status` uses the same calculation, so the three commands cannot
disagree about whether the output is current. A re-render deletes the previous
lint report rather than leaving a verdict about a layout that no longer exists.

The rule for anyone extending it: **if a value can change a pixel, it belongs in
the fingerprint.** `renderOptions()` in `src/digest.js` is the single place the
output options are resolved, and it is passed into the fingerprint whole, so an
option added there is covered automatically. `page_numbers` was missing once,
and toggling it produced different HTML with an identical fingerprint.

## Publishing a render

A render builds into `out/.staging-<pid>-<time>/` and is published only after
the PDF is written, every page is rasterized at the right size, and the geometry
is measured.

Publication is **not atomic**, and nothing pretends otherwise. POSIX gives
atomic rename of one path; a render publishes five. So three things stand
behind it instead:

- **Rollback is unconditional.** If any step fails, every artifact already
  moved aside is put back, with the half-installed new one removed first.
- **Backups survive a failed rollback.** If restoration itself fails, the
  backup directory is kept and the error names it. A stale deliverable is
  recoverable; a lost one is not.
- **`out/artifacts.json` records the SHA-256 of every byte published**, and
  `deck lint` and `deck export` verify them. This is what detects a mixed set:
  the render fingerprint describes the *inputs*, so reverting the inputs makes
  it match again while the files on disk are still half one render and half
  another. Hashes of the delivered bytes do not have that hole.

An advisory per-workspace lock serialises renders. A lock whose owner is still
**alive is never broken, at any age**; one whose owner is gone is broken after
a short grace; an empty lock is treated as mid-initialisation rather than
invalid; and release verifies ownership before unlinking. Each of those is a
way the lock could previously be stolen.

## Process status vs semantic verdict

Following `squad` exactly. Every deterministic command writes two things:

- `<name>-status.txt` — one line, the **process** status. `0` means "this
  command ran to completion", and nothing more.
- `<name>.json` — the report, whose `verdict` field is the **semantic**
  answer.

A lint run that completed and found violations is a successful process with a
failing verdict: status `0`, verdict `fail`, exit code `1`. A lint run that
crashed has no verdict at all: status `4`, verdict forced to `fail`, and a
summary that says so in the first sentence. Reading only one of the two fields
can never make a crashed run look like an approving one.

Exit codes: `0` passed, `1` ran and the verdict failed, `2` usage, `3`
environment, `4` the command itself failed.

A failing command does not only print and exit: it **publishes the failure**,
replacing the previous report with one that says `process: failed` and forcing
the verdict to `fail`. Otherwise a crashed run after a successful one would
leave `verdict: pass` and status `0` on disk, which is exactly the stale-success
trap these two files exist to avoid.

## `deck lint`

Nine rules, over geometry measured in Chrome under **print media** — the same
media Chrome's PDF path uses, so the geometry linted is the geometry shipped.

0. **Content integrity.** Every text field the storyboard says must appear is
   checked for *painted* output: present, visible, non-empty, not reduced to
   nothing by opacity, and carrying the right words. It exists because every
   other rule skips what it cannot measure, so `display: none` on a title
   passed all of them in silence — and the verbatim end-to-end check could not
   see it either, because `textContent` still contains hidden text.
1. **Two-axis centring.** An element declares a contract naming its reference
   region, and each axis fails independently. The reference is declared, never
   guessed: this theme's margins are asymmetric on both axes, so the canvas
   centre is `(836, 470.5)` while the safe-content centre is `(841, 474)`.
   `measure: content-union` measures the inner ink — recursively, down to text
   line boxes and painted leaves, because a full-width wrapper is centred by
   definition and so is a full-width wrapper *inside* it. "The box is centred
   but its contents are not" is the exact bug this exists to catch.

   The ink union removes the font's **leading** and nothing else. A text rect
   is the font's ascent+descent box, which on Noto Sans JP overhangs its line
   box by several pixels; an earlier attempt clipped the rect to the element's
   box, which removed the leading *and* removed genuinely painted ink — a
   centred 200 px box holding text that paints out to 624 px reported its ink
   centre as the box centre. The overhang is now compared against the leading
   per side: within it, it is leading and is trimmed; beyond it, it is real
   overflow and is kept, horizontally and vertically.
2. **Overflow / clipping** — scroll vs client dimensions, text lines against
   clipping ancestors and the canvas, active line clamps and ellipses.
3. **Collision** — unrelated foreground *ink*, with real DOM **ancestry**,
   declared backgrounds, declared groups, decorative overlap and the
   bleed/pagination zones exempt. Ancestry is a DOM fact, not a guess made
   from rectangles: geometric containment is not an exemption, because two
   unrelated elements sharing a rectangle is the worst collision there is.
4. **Safe margins** — body content against the theme's margins, with the
   footer, pagination, decorative and bleed zones separately permitted.
5. **Alignment grid** — a violated *declared* anchor fails; an undeclared
   near-miss is a suggestion.
6. **Type size** — an absolute readable floor plus the theme's per-role bands.
7. **Contrast** — against the **composited** backing, including the element's
   own background. The foreground and the background are composited through
   the same **layer stack**, separately: CSS `opacity` on a group is a layer
   boundary, and multiplying the text's alpha by it double-counts the
   background the text covers inside its own layer. White text in a black
   group at opacity 0.4 over a white page is really white on `#999999`, about
   2.7:1. Over a gradient or an image, the case is
   reported as `unsupported` (a blocking severity) unless the component
   declares its effective backing.
8. **Repetition** — across slides of the same page type, with declared
   variants compared only against their own kind.
9. **Proximity** — declared semantic groups, their internal cohesion and their
   separation from unrelated groups.

Every finding carries slide, element, expected vs measured values, and an
**annotated PNG** with the offending box drawn on it.

### What this gate cannot prove

Stated here, in the code, and in every report, because a gate that overstates
its coverage is worse than no gate — the PO stops looking.

- **Optical balance.** Two columns with identical boxes can still look wrong.
- **Glyph ink.** A measured line box is the font's metrics, not the shape of
  the characters. Noto Sans JP reserves 1.44 em against roughly 0.88 em of
  ink, so optical alignment of large display type is out of reach — and the
  margin rule measures layout boxes for exactly this reason, reporting a font
  box past the margin as a suggestion rather than a failure.
- **Anything inside a slot illustration.** A raster is opaque to every rule
  here. That is why slot prompts *forbid* text in the image rather than
  checking for it afterwards.
- **Whether the composition is any good.** The occupancy rule measures how
  much of the content region has anything on it, which is a far cruder
  question: a well-filled page can still be badly arranged. A deliberately
  sparse page is a suggestion and never a failure, and a page type whose
  emptiness is the design — `statement`, `cover`, `section-divider` — is
  exempt by name in the theme.
- **The words.** Five errors reached a real page and no rule here could have
  caught any of them: a slide asserting the opposite of what the meeting had
  concluded, an internal note to the PO rendered as a slide, a percentage for
  the whole village used as the basis for a much narrower group, a name
  garbled by an automatic transcript. All five were plainly visible in the
  copy sheet. The defence is a readable page in front of the PO early, which
  is why the agent renders a draft before asking for content approval — not
  another rule.

A text run that overflows its own element box sideways, within the canvas and
with no clipping ancestor, breaches the margin without failing rule 4. The
overflow rule catches the clipped and off-canvas cases; neither pretends to
the rest.

Those limits belong to a human or a vision reviewer.

## The theme

A theme is **data**: `theme.yaml` (tokens) + `deck.css` (arrangement) +
`style-brief.md` (inlined into prompts) + `reference/*.png` (attached to
ChatGPT). The stylesheet refers only to `--deck-*` custom properties generated
from the tokens, so changing a colour is a one-line YAML edit.

`watercolor` is derived from the reference deck. Values marked
`measured: true` were sampled from a **generated raster** and are approximate
by construction; `#03224F` is the one exact colour, taken from the deck's
page-number XML. The divergences from the design kit — margins, folio format —
are recorded in `theme.yaml` as decisions rather than left to be rediscovered.

The Japanese font is **pinned as a local file** with a recorded SHA-256 and a
bundled OFL licence. Hiragino is installed on the author's Mac and that is
precisely why it cannot be the strategy. Glyph coverage is checked against the
deck's actual characters before Chrome starts, and a missing glyph is a loud
failure rather than tofu in a delivered PDF.

### The declared contrast exception

The design kit's inactive-agenda grey `#B8B8B8` scores **1.93:1** on this
background. The low contrast is the design — inactive items recede so the
current one reads — so it is recorded as an explicit exception in
`theme.yaml`, with a reason, and **reported on every `deck lint` and every
`deck doctor` run**. What is forbidden is the third option: letting it pass
unremarked. A theme that declares an exception without a reason is refused.

## Linting measured geometry

`out/geometry.json` is **structurally validated before any rule runs**:
reconciled against the storyboard for slide identity, count and order, and
checked that every coordinate a rule will read is a finite number. Every rule
is written to skip what it cannot measure, so absent data produced silence and
silence reads as a pass — replacing `slides` with `[]` gave "verdict: pass,
slides checked: 0, rules run: 9/9". Malformed measurements now block.

## Rendering untrusted content

`deck.yaml` can override any theme token, and those tokens reach a `<style>`
element and `style` attributes. So they are treated as untrusted input:
lengths are parsed as numbers and refused otherwise, identifiers are
constrained, strings are escaped with CSS hex escapes (not HTML entities — a
stylesheet does not decode entities), and the assembled stylesheet is checked
for anything that could terminate its own element.

The backstop runs on the **assembled** stylesheet, after every source is
combined — including the theme's own `deck.css`, which is the one source that
passes through no sanitiser. Disabling JavaScript protects the automated
render; it does nothing for a person who opens `out/html/<slide>.html`, and
that file is an output deck hands over.

Chrome runs with **page JavaScript disabled**, the **OS sandbox on**
(`playwright-core` defaults a launched Chrome to `--no-sandbox`), an **exact
allowlist** of the file URLs the render declared, and `offline: true`. A page
that navigates away from itself — a `<meta http-equiv="refresh">` works with
JavaScript off, because it is the browser rather than a script — is refused
with a clear message rather than dying on Chrome's "execution context was
destroyed". deck
needs `--allow-file-access-from-files` so a `file://` document can load the
theme's font; removing script execution removes what that flag would otherwise
expose. `page.evaluate` still works — it runs through the debugger, not the
page's script context — so geometry collection is unaffected.

Nothing deck reads, writes or deletes may leave the workspace, **including on
the failure path** — cleanup runs before anything else touches `out/`, and a
failure report is not written through a symlink that containment has already
rejected. Paths are resolved to their real location first, because the
destructive case is a symlinked *parent*: a leaf symlink is merely unlinked,
but if `out` is a link elsewhere then `out/html` resolves into someone else's
directory. A containment root is itself checked before it is trusted as one.

Writes go to an exclusively created temp file with an unpredictable name and
are then renamed over the destination. `rename` replaces a directory entry, so
neither a planted symlink nor a **hard link** at the destination can redirect
the write — `assertInside` sees a legitimate in-workspace path and cannot tell
that the inode is shared with a file outside.

Fonts are untrusted too. A theme ships its own font *and* its own recorded
hash, so verification proves the file is the intended one and says nothing
about whether it is well formed. Coverage is stored as sorted ranges rather
than expanded codepoints: a 68-byte font declaring `1..0xFFFFFFFF` used to
allocate until Node's `Set` hit its maximum size. The BMP branch is bounded
separately — its values are 16-bit so no single segment is expensive, but
thousands of overlapping maximal segments were, so segments must be sorted and
disjoint as the specification requires and the total work is capped.

## Not in this increment

Refused by name rather than ignored: PPTX export, Notion ingestion, the
ivory-forest theme, any image-generation API, UI mockup production, tmux
orchestration, and the page types `standard`, `comparison`, `process`,
`ecosystem`, `timeline`, `media` and `background-only`.

## Tests

```sh
./test-deck-wiring.sh           # the shell seam: paths, argv, exit codes, files
npm test --prefix _deck         # units, Chrome geometry fixtures, end-to-end
npm run test:unit --prefix _deck
npm run test:geometry --prefix _deck
npm run test:e2e --prefix _deck
```

The geometry fixtures drive real Chrome, including adversarial ones: style
element breakout, attribute breakout, local-file reads, and outbound HTTP and
WebSocket attempts against a real listening server. The end-to-end fixture takes
a small Japanese deck through init → validate → prompts → import → render →
lint → export on a path containing both a space and Japanese characters, and
reads the PDF's page order out of the PDF.

`test/unit/report-schema.test.js` validates **actually emitted** reports against
their schemas, rather than hand-written samples that would drift the same way
the schema once did.
