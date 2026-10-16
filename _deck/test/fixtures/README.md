# The fixture deck

`full-deck/` is one slide of **every implemented page type**, with **every
slot filled**, built from invented content about a fictional municipality
choosing a payroll system. Nothing in it is confidential and nothing in it is
quoted from anywhere.

## Why it exists

This directory was empty. No test in this repository rendered a deck that used
the slots the themes declare, and that is how `standard-3col` came to ship
three slot coordinates — `col-N-art` at `top: 277` — that sat inside the card
body box and could not be used at all. The cards are flow content and do not
wrap around an absolutely positioned box, so the theme's own flagship layout,
a picture above each of three columns, produced the picture printed *through*
the text. The PO found it by building a real deck, measured 38 collision
findings, and shipped with illustrations on only two pages.

Nothing rendered it, so nothing caught it. In the PO's words: テーマが宣言して
いるスロットを使うフィクスチャが一つも無いから世に出ている.

It does two jobs, and both are load-bearing.

### As documentation

Render it and look at it before you write a storyboard. Not having a worked
example of each page type was, by the PO's account, the direct cause of the
first real deck being unreadable — the first PDF was, in their words, 中身を見
れないほどに見た目がくそすぎて判断できない.

```sh
node test/fixtures/full-deck/build.mjs /tmp/fixture-deck
cd /tmp/fixture-deck
deck gate render
open out/png/001.png
```

`storyboard.yaml` is also worth reading on its own: it is a valid storyboard
using every field deck renders, including all four diagram page types, so it
answers "what do I write for a `comparison`" without a trip through the schema.
`deck gate schema storyboard` is the other half of that answer.

### As a test

`test/geometry/fixture-deck.test.js` renders it, lints it, and requires **zero
blocking findings of any rule**. The documented example of each page type must
not itself violate a rule. That test also asserts two things in the direction
that actually catches problems:

- every slot the **theme** declares is used by some fixture slide, so a slot
  nobody has ever rendered cannot ship again;
- every page type deck says it implements has a fixture slide
  (`test/unit/content.test.js`), so the vocabulary cannot outrun the examples.

It is additionally where the occupancy thresholds in
`themes/watercolor/theme.yaml` come from. They are measured off these renders
rather than chosen, and the test re-measures and fails if they drift apart.

## The illustrations

`build.mjs` generates a stand-in PNG per slot — a soft two-colour wash,
deterministic from the slot id, so the asset manifest's SHA-256 is stable
across machines. They are **generated, not committed**: this repository holds
no binaries, and a committed PNG is a thing nobody can review in a diff.

They contain no text, which is the rule every real slot image is held to —
HTML/CSS renders every word on the slide, which is what keeps a page-number
change from forcing a re-render of every raster.

They are plainly stand-ins and are not meant to look like the reference
artwork. The reference illustrations live in the PO's confidential client deck
and cannot be copied here; see `themes/watercolor/reference/README.md`.

## When you add a page type

Add a slide here. Two tests fail if you do not, and that is deliberate.
