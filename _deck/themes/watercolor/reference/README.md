# reference/

Style reference images for `deck prompts` to tell you to attach to ChatGPT.

**This directory ships empty, deliberately.**

The `watercolor` theme was measured from a real client deck. That deck is the
PO's confidential material, and confidential client work does not belong in a
shared dotfiles repository - so its pages could not be bundled here as style
references, however useful they would be.

## What to put here

One or two finished pages whose illustration style you want the next slot to
match. PNG, JPEG or WebP. Nothing else is read.

`deck prompts` lists by name every image it finds here, in every prompt entry,
under "Attach these to ChatGPT for style consistency". When the directory is
empty it says so plainly instead of naming files that do not exist, and warns
that consistency across slots will be noticeably worse without them.

`deck doctor` reports the count either way.

## Why this matters more than it looks

Each slot is generated in a separate ChatGPT conversation. Without a shared
visual anchor, slot 3 comes back in a different style from slot 1, and the
difference is obvious the moment the two slides are seen one after the other.
The style brief in `style-brief.md` carries the intent in words; these images
carry it in a form an image model follows much more closely.
