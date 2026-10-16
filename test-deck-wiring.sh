#!/usr/bin/env bash
# Tests for deck's wiring: the symlink-resolving executable, the state-root
# overrides, the scaffolded workspace, prompt emission, and the exit-code
# contract that separates a failing VERDICT from a failed PROCESS.
#
#   ./test-deck-wiring.sh
#
# Everything runs against a scaffolded workspace in a temp dir. Stubs for
# claude, codex, curl and tmux sit first on PATH so that a command which tried
# to launch an agent, reach the network or touch a tmux server would be caught
# rather than silently succeeding. deck has no agent and no network by design;
# these assertions are what keeps it that way.
#
# The Node-level behaviour - schemas, approval hashing, the lint rules, the
# geometry fixtures against real Chrome - lives in `npm test --prefix _deck`.
# This file is about the shell seam: path resolution, argv, exit codes, and the
# files deck leaves on disk.
#
# Two things here are deliberately unusual for this repo. Paths containing a
# SPACE and paths containing JAPANESE characters both get their own sections,
# because the PO's own decks live under both and a tool that only works on an
# ASCII path with no spaces works on nobody's machine.

set -uo pipefail

DECK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deck"
[[ -f "$DECK" ]] || { echo "cannot find deck next to this script" >&2; exit 1; }

PASS=0
FAIL=0

ok() { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
no() { printf '  FAIL %s\n' "$1"; printf '       %s\n' "${2:-}"; FAIL=$((FAIL + 1)); }

check_eq() {
  local label="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then ok "$label"; else no "$label" "want [$want] got [$got]"; fi
}

check_ne() {
  local label="$1" a="$2" b="$3"
  if [[ "$a" != "$b" ]]; then ok "$label"; else no "$label" "both were [$a]"; fi
}

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then ok "$label"; else no "$label" "missing [$needle] in: $haystack"; fi
}

check_absent() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then ok "$label"; else no "$label" "unexpected [$needle] in: $haystack"; fi
}

check_file() {
  local label="$1" path="$2"
  if [[ -f "$path" ]]; then ok "$label"; else no "$label" "no such file: $path"; fi
}

check_no_file() {
  local label="$1" path="$2"
  if [[ ! -e "$path" ]]; then ok "$label"; else no "$label" "file exists but should not: $path"; fi
}

check_dir() {
  local label="$1" path="$2"
  if [[ -d "$path" ]]; then ok "$label"; else no "$label" "no such directory: $path"; fi
}

# This script runs without `set -e`, so mktemp is checked explicitly. An empty
# ROOT would turn every "$ROOT/bin" below into an absolute /bin, and the EXIT
# trap into an `rm -rf` of something that is not ours.
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/deck-wiring-test.XXXXXX")" || exit 1
[[ -n "$ROOT" && -d "$ROOT" ]] || {
  echo "cannot create a temporary directory; refusing to run" >&2
  exit 1
}
trap 'rm -rf "${ROOT:?}"' EXIT

mkdir -p "$ROOT/bin"

# ------------------------------------------------------------- agent stubs
#
# deck launches no agent and makes no network call. If it ever did, these
# record it and the assertions at the end of this file fail. They deliberately
# do NOT behave like the real CLIs.
for stub_bin in claude codex; do
  cat > "$ROOT/bin/$stub_bin" <<STUB
#!/usr/bin/env bash
printf '$stub_bin %s\n' "\$*" >> "\$AGENT_STUB_LOG"
exit 0
STUB
  chmod +x "$ROOT/bin/$stub_bin"
done

# ------------------------------------------------------------- network stub
#
# A render that reached out for a webfont or an image would make its output
# depend on a CDN. deck pins its font as a local file for that reason, and
# this proves nothing calls out at the shell level.
for net_bin in curl wget; do
  cat > "$ROOT/bin/$net_bin" <<STUB
#!/usr/bin/env bash
printf '$net_bin %s\n' "\$*" >> "\$NET_STUB_LOG"
exit 1
STUB
  chmod +x "$ROOT/bin/$net_bin"
done

# --------------------------------------------------------------- tmux stub
#
# deck has no tmux orchestration in this increment. Logging every invocation
# proves it, and the no-kill assertions at the end of this file hold whatever
# a future increment adds.
cat > "$ROOT/bin/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_STUB_LOG"
exit 0
STUB
chmod +x "$ROOT/bin/tmux"

export AGENT_STUB_LOG="$ROOT/agent.log"
export NET_STUB_LOG="$ROOT/net.log"
export TMUX_STUB_LOG="$ROOT/tmux.log"
: > "$AGENT_STUB_LOG"
: > "$NET_STUB_LOG"
: > "$TMUX_STUB_LOG"
export PATH="$ROOT/bin:$PATH"

# Hermetic roots: never the PO's real state.
export DECK_STATE_ROOT="$ROOT/state"

echo "deck wiring tests"
echo ""

# ============================================================== executable ==
echo "the executable (symlink resolution, dependency preflight, usage)"

# TWO HELPS, TWO AUDIENCES. The top level is the PO's: a title and a
# lifecycle. `deck gate --help` is the agent's: the deterministic commands.
HELP_OUT="$ROOT/help.out"
"$DECK" --help > "$HELP_OUT" 2>&1
check_eq "deck --help exits 0" "0" "$?"
HELP="$(cat "$HELP_OUT")"
check_contains "deck --help leads with a TITLE, not a subcommand" "$HELP" "deck <title>"
check_contains "deck --help says the PO never opens storyboard.yaml" "$HELP" "You never open storyboard.yaml"
for verb in list resume close rm clean "gate <command>" gen-helpers; do
  check_contains "deck --help documents '$verb'" "$HELP" "$verb"
done
check_contains "deck --help documents --source" "$HELP" "--source"
check_contains "deck --help names DECK_REPAIR_MAX_ROUNDS" "$HELP" "DECK_REPAIR_MAX_ROUNDS"
check_contains "deck --help names DECK_STATE_ROOT" "$HELP" "DECK_STATE_ROOT"
check_contains "deck --help names DECK_HOME" "$HELP" "DECK_HOME"
check_contains "deck --help names the escape hatch for a gate-named deck" "$HELP" "deck -- <title>"

GATE_HELP="$("$DECK" gate --help 2>&1)"
check_eq "deck gate --help exits 0" "0" "$?"
for verb in init doctor validate approve status prompts "assets import" render lint export; do
  check_contains "deck gate --help documents '$verb'" "$GATE_HELP" "$verb"
done
for verb in source ledger agenda copy fidelity inbox; do
  check_contains "deck gate --help documents the new gate '$verb'" "$GATE_HELP" "deck gate $verb"
done
check_contains "deck gate --help documents --release" "$GATE_HELP" "render --release"
check_contains "deck gate --help documents the exit-code contract" "$GATE_HELP" "A successful process with a failing answer"
check_contains "deck gate --help says what is out of scope" "$GATE_HELP" "Not in this increment"
check_contains "deck gate --help refuses pptx by name" "$GATE_HELP" "PPTX export"
check_contains "deck gate --help documents --single" "$GATE_HELP" "deck gate prompts --single"

"$DECK" > /dev/null 2>&1
check_eq "a bare deck is a usage error" "1" "$?"

BOGUS="$("$DECK" gate definitely-not-a-subcommand 2>&1)"
check_eq "an unknown gate is a usage error" "2" "$?"
check_contains "an unknown gate lists the real ones" "$BOGUS" "Known: init, doctor"
check_contains "an unknown gate points at the gate help" "$BOGUS" "deck gate --help"

# A GATE NAME IS NOT A DECK TITLE. Without this, `deck render` out of habit
# would quietly start an agent: slow, token-spending and nothing like what was
# meant. Checked for every gate name, so a gate added later is covered.
for verb in init doctor source ledger agenda copy fidelity inbox validate approve status prompts assets render lint export; do
  OLD_SPELLING="$("$DECK" "$verb" 2>&1)"
  check_eq "the old spelling 'deck $verb' is refused, not launched" "2" "$?"
  check_contains "and it points at the gate spelling" "$OLD_SPELLING" "deck gate $verb"
done
check_contains "and it names the -- escape hatch" "$OLD_SPELLING" "deck -- "
check_eq "no agent was launched by any of those refusals" "" "$(cat "$AGENT_STUB_LOG")"

# THE SYMLINK CONVENTION. The PO installs deck as ~/.local/bin/deck, so the
# script must find _deck relative to its RESOLVED REAL PATH and not to $0.
# A chain of symlinks is used rather than one, because the resolver loops and
# a one-shot readlink would pass a single-link test.
mkdir -p "$ROOT/link1" "$ROOT/link2"
ln -s "$DECK" "$ROOT/link1/deck-a"
ln -s "$ROOT/link1/deck-a" "$ROOT/link2/deck"
LINKED_OUT="$("$ROOT/link2/deck" --help 2>&1)"
check_eq "deck runs through a CHAIN of symlinks" "0" "$?"
check_contains "the symlinked deck prints the same usage" "$LINKED_OUT" "deck <title>"
check_absent "the symlinked deck does not report missing sources" "$LINKED_OUT" "sources are missing"

# A RELATIVE symlink target, which is what `ln -s ../../deck` produces.
mkdir -p "$ROOT/rel/bin"
( cd "$ROOT/rel/bin" && ln -s "../../../$(basename "$(dirname "$DECK")")/deck" deck 2>/dev/null )
# The relative hop above only works when the repo is reachable that way; a
# direct relative link inside $ROOT is the portable version of the same check.
cp "$DECK" "$ROOT/copy-deck"
ln -s "copy-deck" "$ROOT/rel-link"
# Probed with `gate`, not `--help`: the top-level help deliberately answers
# even on a broken install, because that is where someone looks when it is
# broken. A gate needs the Node sources, so it is what must complain.
REL_HELP="$("$ROOT/rel-link" --help 2>&1)"
check_eq "a relocated deck still answers --help" "0" "$?"
REL_OUT="$("$ROOT/rel-link" gate doctor 2>&1)"
REL_RC=$?
check_ne "a RELATIVE symlink target resolves to a real path" "0" "$REL_RC"
check_contains "and when it cannot find _deck it says exactly where it looked" "$REL_OUT" "deck resolved its own path to"

# The copied deck, with DECK_HOME pointed at the real one, must work: that is
# the escape hatch the error message advertises.
DH_OUT="$(DECK_HOME="$(dirname "$DECK")/_deck" "$ROOT/copy-deck" gate --help 2>&1)"
check_eq "DECK_HOME lets a relocated deck find its sources" "0" "$?"
check_contains "and it prints the gate usage" "$DH_OUT" "deck gate init <dir>"

# A missing node is reported as an environment error, not a stack trace.
NODE_OUT="$(DECK_NODE=definitely-not-node "$DECK" gate doctor 2>&1)"
check_eq "a missing node is an environment error" "2" "$?"
check_contains "and it names the binary it looked for" "$NODE_OUT" "definitely-not-node"

echo ""

# =================================================================== doctor ==
echo "deck doctor (reports, installs nothing)"

DOC_OUT="$ROOT/doctor.out"
"$DECK" gate doctor > "$DOC_OUT" 2>&1
DOC_RC=$?
DOC="$(cat "$DOC_OUT")"
check_eq "doctor exits 0 when everything required is present" "0" "$DOC_RC"
check_contains "doctor reports Chrome" "$DOC" "Google Chrome"
check_contains "doctor reports pdftoppm" "$DOC" "pdftoppm"
check_contains "doctor reports pdfinfo" "$DOC" "pdfinfo"
check_contains "doctor reports node" "$DOC" "node"
check_contains "doctor reports the pinned font" "$DOC" "Noto Sans JP"
check_contains "doctor verifies the font hash" "$DOC" "sha256 verified"
check_contains "doctor reports glyph coverage" "$DOC" "codepoints"
check_contains "doctor says it installs nothing" "$DOC" "installs nothing"
# THE DECLARED THEME EXCEPTION IS REPORTED, never silent.
check_contains "doctor prints the declared contrast exception" "$DOC" "declared theme exceptions"
check_contains "doctor names the agenda grey exception" "$DOC" "agenda-text"
check_contains "doctor gives the exception's reason" "$DOC" "intentional"
# deck pins its own font; the system's Japanese fonts are informational only.
check_contains "doctor states that deck does not use the system fonts" "$DOC" "it pins its own"

DOC_JSON="$("$DECK" gate doctor --json 2>&1)"
check_eq "doctor --json exits 0" "0" "$?"
check_contains "doctor --json separates process from verdict" "$DOC_JSON" '"process": "ok"'
check_contains "doctor --json carries a verdict" "$DOC_JSON" '"verdict": "pass"'
if printf '%s' "$DOC_JSON" | "${DECK_NODE:-node}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s)})' 2>/dev/null; then
  ok "doctor --json emits parseable JSON"
else
  no "doctor --json emits parseable JSON" "it did not parse"
fi

echo ""

# ===================================================================== init ==
echo "deck init (the scaffolded workspace)"

WS="$ROOT/plain"
INIT_OUT="$("$DECK" gate init "$WS" 2>&1)"
check_eq "init succeeds" "0" "$?"
check_contains "init names the theme" "$INIT_OUT" "watercolor"
check_contains "init tells the PO what to do next" "$INIT_OUT" "deck validate"

check_file "deck.yaml is scaffolded" "$WS/deck.yaml"
check_file "storyboard.yaml is scaffolded" "$WS/storyboard.yaml"
check_file "assets/manifest.json is scaffolded" "$WS/assets/manifest.json"
check_file ".deck/state.json is scaffolded" "$WS/.deck/state.json"
check_file "sources/README.md explains immutability" "$WS/sources/README.md"
check_file ".gitignore is scaffolded" "$WS/.gitignore"
check_dir ".deck/approvals exists" "$WS/.deck/approvals"
check_dir "sources/ exists" "$WS/sources"
check_dir "assets/ exists" "$WS/assets"
# out/ is build output and must not be scaffolded; it is created by a render.
check_no_file "out/ is NOT scaffolded" "$WS/out"

SB="$(cat "$WS/storyboard.yaml")"
check_contains "the scaffold storyboard says content is verbatim" "$SB" "VERBATIM"
check_contains "the scaffold storyboard explains subtitle: null" "$SB" "INTENTIONALLY ABSENT"
check_contains "the scaffold storyboard uses subtitle: null for real" "$SB" "subtitle: null"
DY="$(cat "$WS/deck.yaml")"
check_contains "the scaffold deck.yaml explains empty-means-keep" "$DY" "keep the default"
check_contains "the scaffold deck.yaml records the theme" "$DY" "theme: watercolor"

# init must refuse to scaffold over anything.
NONEMPTY="$ROOT/nonempty"
mkdir -p "$NONEMPTY"
printf 'mine\n' > "$NONEMPTY/existing.txt"
NE_OUT="$("$DECK" gate init "$NONEMPTY" 2>&1)"
check_eq "init refuses a non-empty directory" "3" "$?"
check_contains "init says what it found" "$NE_OUT" "existing.txt"
check_eq "the existing file is untouched" "mine" "$(cat "$NONEMPTY/existing.txt")"

BADTHEME="$("$DECK" gate init "$ROOT/bad-theme" --theme no-such-theme 2>&1)"
check_eq "init refuses an unknown theme" "3" "$?"
check_contains "init lists the themes it has" "$BADTHEME" "watercolor"
check_no_file "a refused theme scaffolds NOTHING" "$ROOT/bad-theme/deck.yaml"

NOARG="$("$DECK" gate init 2>&1)"
check_eq "init without a directory is a usage error" "2" "$?"

echo ""

# ============================================================== state roots ==
echo "state roots (never the PO's real state)"

# The registry lands under DECK_STATE_ROOT, and nowhere else.
check_file "DECK_STATE_ROOT receives the deck registry" "$DECK_STATE_ROOT/decks.json"
check_contains "the registry records this workspace" "$(cat "$DECK_STATE_ROOT/decks.json")" "plain"

# Per-deck state lives WITH the deck, so moving the directory keeps approvals.
check_no_file "per-deck state is NOT under the state root" "$DECK_STATE_ROOT/plain"
check_file "per-deck state is inside the deck" "$WS/.deck/state.json"

# XDG_STATE_HOME is the fallback, exactly as squad and vet do it.
XDG_ROOT="$ROOT/xdg"
( DECK_STATE_ROOT= XDG_STATE_HOME="$XDG_ROOT" "$DECK" gate init "$ROOT/xdg-deck" ) > /dev/null 2>&1
check_eq "an init under XDG_STATE_HOME succeeds" "0" "$?"
check_file "XDG_STATE_HOME/deck is used when DECK_STATE_ROOT is empty" "$XDG_ROOT/deck/decks.json"

echo ""

# ================================================================= validate ==
echo "deck validate (shape, then the semantics a schema cannot express)"

VAL_OUT="$(cd "$WS" && "$DECK" gate validate 2>&1)"
VAL_RC=$?
check_eq "the scaffolded deck validates" "0" "$VAL_RC"
check_contains "validate reports the slide count" "$VAL_OUT" "slide(s) OK"
check_contains "validate prints the agenda digest" "$VAL_OUT" "agenda digest:"
check_contains "validate prints the content digest" "$VAL_OUT" "content digest:"
check_contains "validate names the intentionally absent subtitles" "$VAL_OUT" "intentionally absent subtitles"

check_file "validate writes a machine-readable report" "$WS/out/validate.json"
check_file "validate writes a PROCESS status file" "$WS/out/validate-status.txt"
check_file "validate writes a readable summary" "$WS/out/validate.txt"
check_eq "the process status is 0 for a completed run" "0" "$(tr -d '[:space:]' < "$WS/out/validate-status.txt")"
check_contains "the report separates process from verdict" "$(cat "$WS/out/validate.json")" '"process": "ok"'
check_contains "the report carries a passing verdict" "$(cat "$WS/out/validate.json")" '"verdict": "pass"'

# A FAILING VERDICT IS STILL A SUCCESSFUL PROCESS. This is the distinction the
# whole report format exists for, and it is asserted on real files.
BROKEN="$ROOT/broken"
"$DECK" gate init "$BROKEN" > /dev/null 2>&1
sed 's/page_type: cover/page_type: media/' "$BROKEN/storyboard.yaml" > "$BROKEN/storyboard.tmp"
mv "$BROKEN/storyboard.tmp" "$BROKEN/storyboard.yaml"
BAD_OUT="$(cd "$BROKEN" && "$DECK" gate validate 2>&1)"
BAD_RC=$?
check_eq "an unimplemented page type fails the VERDICT with exit 1" "1" "$BAD_RC"
check_contains "and it is refused BY NAME" "$BAD_OUT" "media"
check_contains "and the refusal gives the reason" "$BAD_OUT" "not implemented"
check_eq "but the PROCESS still completed, so its status is 0" "0" "$(tr -d '[:space:]' < "$BROKEN/out/validate-status.txt")"
check_contains "and the report says verdict fail" "$(cat "$BROKEN/out/validate.json")" '"verdict": "fail"'
check_contains "while still saying process ok" "$(cat "$BROKEN/out/validate.json")" '"process": "ok"'

# A typo'd key is refused rather than silently dropping the line.
TYPO="$ROOT/typo"
"$DECK" gate init "$TYPO" > /dev/null 2>&1
sed 's/    subtitle: "ここに副題を書く"/    subtitel: "ここに副題を書く"/' "$TYPO/storyboard.yaml" > "$TYPO/storyboard.tmp"
mv "$TYPO/storyboard.tmp" "$TYPO/storyboard.yaml"
TYPO_OUT="$(cd "$TYPO" && "$DECK" gate validate 2>&1)"
check_eq "a typo'd key fails validation" "1" "$?"
check_contains "and the message names the key" "$TYPO_OUT" "subtitel"

# Running outside a workspace is an environment error that says what to do.
OUTSIDE="$(cd "$ROOT" && "$DECK" gate validate 2>&1)"
check_eq "validate outside a deck is an environment error" "3" "$?"
check_contains "and it tells the PO to run deck init" "$OUTSIDE" "deck init"

echo ""

# ================================================================== prompts ==
echo "deck prompts (the manual ChatGPT workflow)"

P_OUT="$(cd "$WS" && "$DECK" gate prompts 2>&1)"
check_eq "prompts exits 0" "0" "$?"
check_file "prompts writes out/prompts.md" "$WS/out/prompts.md"
PM="$(cat "$WS/out/prompts.md")"

check_contains "an entry names its slot" "$PM" 'cover-art'
check_contains "an entry names its slide" "$PM" 'slide `cover`'
check_contains "an entry gives the exact pixel size" "$PM" "760x941 px"
check_contains "an entry gives the aspect ratio" "$PM" "760:941"
check_contains "an entry carries the slide's purpose" "$PM" "資料の主題と対象を一目で伝える"
check_contains "an entry carries the slot's own brief" "$PM" "水彩イラスト"
# THE NO-TEXT INSTRUCTION is the whole reason the seam holds.
check_contains "an entry forbids text in the image" "$PM" "Put NO text, letters, numbers"
check_contains "and explains why that matters" "$PM" "cannot be corrected without regenerating"
check_contains "an entry inlines the theme's style brief" "$PM" "Soft watercolour illustration"
check_contains "an entry gives the palette as hex, in prose" "$PM" "#03224F"
check_contains "an entry says which references to attach" "$PM" "Reference images to attach"
# THE IMPORT COMMAND must be ready to copy.
check_contains "an entry prints the exact import command" "$PM" "deck gate assets import cover:cover-art"
check_contains "the house-style Japanese header is present" "$PM" "使用するプロンプト"
check_contains "the header states the no-text premise in Japanese" "$PM" "画像内に文字"

check_file "prompts writes a machine-readable report" "$WS/out/prompts.json"
check_contains "the report lists the slot" "$(cat "$WS/out/prompts.json")" '"slot_id": "cover-art"'
check_contains "the report carries the import command" "$(cat "$WS/out/prompts.json")" 'deck gate assets import cover:cover-art'

# One slot at a time, for piping to pbcopy.
ONE="$(cd "$WS" && "$DECK" gate prompts --slot cover-art 2>&1)"
check_eq "a single slot goes to stdout" "0" "$?"
check_contains "the single entry is complete" "$ONE" "deck gate assets import cover:cover-art"
check_absent "the single entry is not the whole file" "$ONE" "## Illustration prompts"

BADSLOT="$(cd "$WS" && "$DECK" gate prompts --slot nope 2>&1)"
check_eq "an unknown slot is a usage error" "2" "$?"
check_contains "and it lists the real slots" "$BADSLOT" "cover-art"

OUTFILE="$ROOT/elsewhere.md"
( cd "$WS" && "$DECK" gate prompts --out "$OUTFILE" ) > /dev/null 2>&1
check_eq "--out writes where it is told" "0" "$?"
check_file "the --out file exists" "$OUTFILE"

echo ""

# ========================================================= prompts --single ==
echo "deck prompts --single (one block the PO pastes into one conversation)"

SG_OUT="$(cd "$WS" && "$DECK" gate prompts --single 2>&1)"
check_eq "prompts --single exits 0" "0" "$?"
check_file "it writes out/prompts-single.md" "$WS/out/prompts-single.md"
SG="$(cat "$WS/out/prompts-single.md")"

check_contains "the style is stated for every image" "$SG" "STYLE"
check_contains "the style brief itself is inlined" "$SG" "Soft watercolour illustration"
check_contains "it asks for one image at a time" "$SG" "ONE AT A TIME"
check_contains "it says to generate only the first" "$SG" "Generate IMAGE 1 only"
check_contains "it says to hold the style across the conversation" "$SG" "this one conversation"
check_contains "each image is numbered in deck order" "$SG" "IMAGE 1 of"
check_contains "each image names its slide" "$SG" 'slide "cover"'
check_contains "each image gives its exact size" "$SG" "760 x 941 px"
check_contains "each image gives its aspect ratio" "$SG" "aspect ratio 760:941"
check_contains "each image says where it sits" "$SG" "against the right edge"
check_contains "each image says what to depict" "$SG" "Depict:"
# THE NO-TEXT RULE: once prominently, and again per slot.
check_contains "the no-text rule is stated prominently" "$SG" "PUT NO TEXT IN THE IMAGE"
check_contains "and explains why it matters" "$SG" "cannot be corrected or translated later"
check_contains "and is restated compactly per slot" "$SG" "(No text, letters, numbers or logos inside this image.)"
# A FILENAME CONVENTION, so an import is never a guess.
check_contains "each image has a file name" "$SG" "file name: 01-cover-cover-art.png"
# THE HANDOVER IS A DIRECTORY, not a command per image. Listing one import
# command per slot asked the PO to match file names to slot ids by hand, and a
# wrong illustration in the right slot renders cleanly - lint cannot see it.
check_contains "the closing section names ONE drop directory" "$SG" "inbox/"
check_contains "and maps each file name to its slot" "$SG" "01-cover-cover-art.png   ->  cover:cover-art"
check_contains "and gives the one command that imports them all" "$SG" "deck gate inbox"
check_contains "and promises not to guess at a file it cannot place" "$SG" "cannot place is listed"
# THE BRIEF IS PASTED INTO CHATGPT, so it must not carry a local path: for this
# tool a directory name is usually a client name.
check_absent "the drop directory is RELATIVE, so no local path is pasted out" "$SG" "$WS"
check_absent "and the brief does not leak the home directory" "$SG" "$HOME"
# PLAIN TEXT: nothing depends on markdown rendering for meaning.
check_absent "no markdown tables" "$SG" "|---"
check_absent "no markdown bullet syntax carrying structure" "$SG" "* **"

SG_JSON="$WS/out/prompts-single.json"
check_file "prompts --single writes a machine-readable report" "$SG_JSON"
check_contains "the report records the filename convention" "$(cat "$SG_JSON")" '"filename": "01-cover-cover-art.png"'

BOTH="$(cd "$WS" && "$DECK" gate prompts --single --slot cover-art 2>&1)"
check_eq "--single and --slot together is a usage error" "2" "$?"
check_contains "and it says to pick one" "$BOTH" "Pick one"

SG_ELSEWHERE="$ROOT/single-elsewhere.md"
( cd "$WS" && "$DECK" gate prompts --single --out "$SG_ELSEWHERE" ) > /dev/null 2>&1
check_eq "--single honours --out" "0" "$?"
check_file "the --out file exists" "$SG_ELSEWHERE"

# NOTHING THE PO PASTES MAY CARRY AN ABSOLUTE LOCAL PATH. prompts.md and
# prompts-single.md go into a chat with a third party, and an absolute path
# carries the user's name and their whole directory layout with it.
check_absent "prompts.md leaks no home directory" "$(cat "$WS/out/prompts.md")" "$HOME"
check_absent "prompts-single.md leaks no home directory" "$SG" "$HOME"
check_absent "prompts-single.md leaks no workspace path" "$SG" "$WS"

echo ""

# ============================================ paths with spaces and Japanese ==
echo "a workspace path containing a SPACE"

SPACE_WS="$ROOT/a deck with spaces"
SP_OUT="$("$DECK" gate init "$SPACE_WS" 2>&1)"
check_eq "init succeeds on a path with a space" "0" "$?"
check_file "deck.yaml lands in the spaced path" "$SPACE_WS/deck.yaml"
( cd "$SPACE_WS" && "$DECK" gate validate ) > /dev/null 2>&1
check_eq "validate succeeds from a spaced path" "0" "$?"
( cd "$SPACE_WS" && "$DECK" gate prompts ) > /dev/null 2>&1
check_eq "prompts succeeds from a spaced path" "0" "$?"
check_file "prompts.md lands in the spaced path" "$SPACE_WS/out/prompts.md"
# A spaced path must survive INTO the emitted prompt, unmangled.
check_contains "the theme's reference dir is reported unmangled" \
  "$(cat "$SPACE_WS/out/prompts.md")" "deck gate assets import cover:cover-art"

echo ""
echo "a workspace path containing JAPANESE characters"

JP_WS="$ROOT/日本語の 資料フォルダ"
JP_OUT="$("$DECK" gate init "$JP_WS" 2>&1)"
check_eq "init succeeds on a Japanese path" "0" "$?"
check_file "deck.yaml lands in the Japanese path" "$JP_WS/deck.yaml"
( cd "$JP_WS" && "$DECK" gate validate ) > /dev/null 2>&1
check_eq "validate succeeds from a Japanese path" "0" "$?"
( cd "$JP_WS" && "$DECK" gate prompts ) > /dev/null 2>&1
check_eq "prompts succeeds from a Japanese path" "0" "$?"
check_file "prompts.md lands in the Japanese path" "$JP_WS/out/prompts.md"
check_contains "Japanese content survives into the prompt" \
  "$(cat "$JP_WS/out/prompts.md")" "資料の主題を表す水彩イラスト"

# A state root that itself contains a space and Japanese.
JP_STATE="$ROOT/状態 ルート"
( cd "$JP_WS" && DECK_STATE_ROOT="$JP_STATE" "$DECK" gate validate ) > /dev/null 2>&1
check_eq "a state root with a space and Japanese works" "0" "$?"

# And a deck run from a SUBDIRECTORY of a Japanese path: the workspace is found
# by walking up.
mkdir -p "$JP_WS/下位 ディレクトリ"
SUB_OUT="$(cd "$JP_WS/下位 ディレクトリ" && "$DECK" gate validate 2>&1)"
check_eq "validate works from a subdirectory" "0" "$?"
check_contains "and it validated the parent's storyboard" "$SUB_OUT" "slide(s) OK"

echo ""

# ================================================================= approval ==
echo "deck approve and the --release gate"

APP="$ROOT/approval"
"$DECK" gate init "$APP" > /dev/null 2>&1
A_OUT="$(cd "$APP" && "$DECK" gate approve content 2>&1)"
check_eq "approve content exits 0" "0" "$?"
check_contains "approve records a digest" "$A_OUT" "digest:"
check_contains "approve records a timestamp" "$A_OUT" "approved at:"
check_contains "approve lists the slides it signed off" "$A_OUT" "slides:"
check_file "the approval is recorded on disk" "$APP/.deck/approvals/content.json"
check_contains "the approval carries a SHA-256" "$(cat "$APP/.deck/approvals/content.json")" '"digest"'

A_BAD="$(cd "$APP" && "$DECK" gate approve nonsense 2>&1)"
check_eq "approving an unknown thing is a usage error" "2" "$?"
check_contains "and it says what IS approvable" "$A_BAD" "agenda, content"

A_NONE="$(cd "$APP" && "$DECK" gate approve 2>&1)"
check_eq "approve with no argument is a usage error" "2" "$?"

# Approving a deck that does not validate is refused: an approval that can
# never be satisfied is worse than none.
BADAPP="$ROOT/bad-approval"
"$DECK" gate init "$BADAPP" > /dev/null 2>&1
sed 's/page_type: table/page_type: media/; s/page_type: agenda/page_type: media/' \
  "$BADAPP/storyboard.yaml" > "$BADAPP/storyboard.tmp"
mv "$BADAPP/storyboard.tmp" "$BADAPP/storyboard.yaml"
BA_OUT="$(cd "$BADAPP" && "$DECK" gate approve content 2>&1)"
check_eq "approving an invalid storyboard is refused" "1" "$?"
check_contains "and it says to run the validate gate" "$BA_OUT" "deck gate validate"
check_no_file "nothing is recorded for a refused approval" "$BADAPP/.deck/approvals/content.json"

# The release gate, at the shell level. The Node suite covers the digest
# arithmetic; this covers the exit code and the message the PO reads.
UNAPPROVED="$ROOT/unapproved"
"$DECK" gate init "$UNAPPROVED" > /dev/null 2>&1
REL_OUT="$(cd "$UNAPPROVED" && "$DECK" gate render --release 2>&1)"
check_eq "--release without an approval fails the VERDICT with exit 1" "1" "$?"
check_contains "and it says the content was never approved" "$REL_OUT" "never been approved"
check_contains "and it says a preview render is always allowed" "$REL_OUT" "preview"
check_no_file "a refused release renders NO pdf" "$UNAPPROVED/out/deck.pdf"

# Change one word after approving, and the refusal must say what changed.
sed 's/title: "ここにタイトルを書く"/title: "別のタイトル"/' "$APP/storyboard.yaml" > "$APP/storyboard.tmp"
mv "$APP/storyboard.tmp" "$APP/storyboard.yaml"
CH_OUT="$(cd "$APP" && "$DECK" gate render --release 2>&1)"
check_eq "--release after an edit fails the VERDICT with exit 1" "1" "$?"
check_contains "and it says the storyboard no longer matches" "$CH_OUT" "no longer matches the approved content"
check_contains "and it names the slide and field" "$CH_OUT" "title changed"
check_contains "and it shows the approved wording" "$CH_OUT" "ここにタイトルを書く"
check_contains "and it shows the current wording" "$CH_OUT" "別のタイトル"
check_contains "and it says how to proceed" "$CH_OUT" "deck approve content"

echo ""

# =================================================================== status ==
echo "deck status"

ST_OUT="$(cd "$APP" && "$DECK" gate status 2>&1)"
check_eq "status exits 0" "0" "$?"
check_contains "status reports a phase" "$ST_OUT" "phase"
check_contains "status reports the theme" "$ST_OUT" "watercolor"
check_contains "status reports the approval as stale after the edit" "$ST_OUT" "STALE"
check_contains "status lists slots" "$ST_OUT" "slots"
check_contains "status says whether a pdf exists" "$ST_OUT" "deck.pdf"

ST_JSON="$(cd "$APP" && "$DECK" gate status --json 2>&1)"
check_contains "status --json says the phase is re-derived" "$ST_JSON" '"phase_is_derived": true'

echo ""

# ===================================================================== lint ==
echo "deck lint without a render"

L_OUT="$(cd "$WS" && "$DECK" gate lint 2>&1)"
check_eq "lint before a render is an environment error" "3" "$?"
check_contains "and it says to render first" "$L_OUT" "deck render"
check_contains "and it says it lints MEASURED geometry" "$L_OUT" "MEASURED"

E_OUT="$(cd "$WS" && "$DECK" gate export 2>&1)"
check_eq "export before a render is an environment error" "3" "$?"
check_contains "and it says export does not render" "$E_OUT" "does not render"

echo ""

# ================================================= filesystem containment ==
echo "deck does not read, write or delete outside the workspace"

# A LEAF symlink is merely unlinked, which is harmless; the damage comes
# through a symlinked PARENT, where out/html resolves into someone else's
# directory and rm -r deletes a real tree there.
VICTIM="$ROOT/victim"
mkdir -p "$VICTIM/html" "$VICTIM/png"
printf 'DO NOT DELETE\n' > "$VICTIM/html/precious.txt"
printf 'DO NOT DELETE\n' > "$VICTIM/png/precious.txt"

SYM_WS="$ROOT/symlinked-out"
"$DECK" gate init "$SYM_WS" > /dev/null 2>&1
rm -rf "$SYM_WS/out"
ln -s "$VICTIM" "$SYM_WS/out"
SYM_OUT="$(cd "$SYM_WS" && "$DECK" gate render 2>&1)"
SYM_RC=$?
check_ne "rendering through a symlinked out/ is refused" "0" "$SYM_RC"
check_contains "and it says the path escapes the workspace" "$SYM_OUT" "outside the deck workspace"
check_eq "the file outside the workspace survives" "DO NOT DELETE" "$(cat "$VICTIM/html/precious.txt")"
check_eq "and so does the other one" "DO NOT DELETE" "$(cat "$VICTIM/png/precious.txt")"

# A style brief that traverses out of the theme would be READ and its contents
# embedded into prompts.md, which the PO pastes into a chat with a third party.
SECRET="$ROOT/secret-notes.txt"
printf 'SECRET-SENTINEL-VALUE\n' > "$SECRET"
TRAV_WS="$ROOT/traversal"
"$DECK" gate init "$TRAV_WS" > /dev/null 2>&1
{
  printf '\ntheme_overrides:\n'
  printf '  slots:\n'
  printf '    style_brief_file: "../../../../../../../..%s"\n' "$SECRET"
} >> "$TRAV_WS/deck.yaml"
TRAV_OUT="$(cd "$TRAV_WS" && "$DECK" gate prompts 2>&1)"
check_ne "a traversing style_brief_file is refused" "0" "$?"
check_absent "and the secret never reaches stdout" "$TRAV_OUT" "SECRET-SENTINEL-VALUE"
if [[ -f "$TRAV_WS/out/prompts.md" ]]; then
  check_absent "and it never reaches prompts.md" "$(cat "$TRAV_WS/out/prompts.md")" "SECRET-SENTINEL-VALUE"
else
  ok "no prompts.md was written for a refused run"
fi
check_eq "the secret file is untouched" "SECRET-SENTINEL-VALUE" "$(cat "$SECRET")"

echo ""

# ================================================ failure publishing (C7) ==
echo "a failed command never leaves a passing report behind"

FAILWS="$ROOT/failure"
"$DECK" gate init "$FAILWS" > /dev/null 2>&1
# THE SCAFFOLD RESERVES A COVER ILLUSTRATION AND SHIPS NO PICTURE, which the
# slot-fill rule now blocks on - correctly, and that is checked on its own
# below. This section is about a crashed run never being readable as a clean
# one, so it needs a deck that lints clean to begin with.
node "$(dirname "$DECK")/_deck/test/fixtures/full-deck/build.mjs" >/dev/null 2>&1 || true
FILL_ART="$ROOT/fill-art.png"
node --input-type=module -e '
import fs from "node:fs";
const [out, home] = process.argv.slice(1);
const { washPng } = await import(`${home}/test/fixtures/full-deck/build.mjs`);
fs.writeFileSync(out, washPng(760, 941, "cover-art"));
' "$FILL_ART" "$(dirname "$DECK")/_deck" >/dev/null 2>&1
( cd "$FAILWS" && "$DECK" gate assets import cover-art "$FILL_ART" ) > /dev/null 2>&1
check_eq "the scaffold's cover illustration can be imported" "0" "$?"
( cd "$FAILWS" && "$DECK" gate render ) > /dev/null 2>&1
check_eq "the baseline render succeeds" "0" "$?"
( cd "$FAILWS" && "$DECK" gate lint ) > /dev/null 2>&1
check_eq "the baseline lint passes" "0" "$?"
check_contains "and its report says pass" "$(cat "$FAILWS/out/lint/report.json")" '"verdict": "pass"'
check_eq "and its status file says 0" "0" "$(tr -d '[:space:]' < "$FAILWS/out/lint/report-status.txt")"

printf 'not json at all' > "$FAILWS/out/geometry.json"
( cd "$FAILWS" && "$DECK" gate lint ) > /dev/null 2>&1
check_ne "a lint with unreadable geometry fails" "0" "$?"
check_contains "the previous PASS is replaced by a failure report" "$(cat "$FAILWS/out/lint/report.json")" '"process": "failed"'
check_contains "whose verdict is forced to fail" "$(cat "$FAILWS/out/lint/report.json")" '"verdict": "fail"'
check_eq "and whose status file says 4" "4" "$(tr -d '[:space:]' < "$FAILWS/out/lint/report-status.txt")"
check_contains "and whose summary says it did not complete" "$(cat "$FAILWS/out/lint/report.json")" "FAILED to complete"

echo ""

# ============================================================ no agents, no net ==
echo "nothing is launched and nothing is fetched"

check_eq "no agent binary was invoked by any command in this suite" "" "$(cat "$AGENT_STUB_LOG")"
check_eq "no curl or wget was invoked by any command in this suite" "" "$(cat "$NET_STUB_LOG")"
check_eq "tmux was never called" "" "$(cat "$TMUX_STUB_LOG")"
check_absent "nothing in this suite ever killed a window" "$(cat "$TMUX_STUB_LOG")" "kill-window"
check_absent "nothing in this suite ever killed a session" "$(cat "$TMUX_STUB_LOG")" "kill-session"
check_absent "nothing in this suite ever killed a server" "$(cat "$TMUX_STUB_LOG")" "kill-server"

# ========================================================== the launcher ==
#
# THE AGENT LAYER. Everything above this line is the gate: deterministic, no
# agent, no network, and the invariants just asserted prove it. Below the line
# is the thing that drives those gates - and it DOES launch an agent, so it
# gets its own stub logs rather than weakening the assertions above.
#
# The agent stub records its whole argv and the system prompt it was handed,
# so these tests can assert what the agent was told without running one. No
# real agent, no tmux server, no Notion request.
echo ""
echo "the launcher: one agent, driven by a title"

export LAUNCH_AGENT_LOG="$ROOT/launch-agent.log"
export LAUNCH_PROMPT_OUT="$ROOT/launch-prompt.md"
: > "$LAUNCH_AGENT_LOG"
cat > "$ROOT/bin/stub-agent" <<'STUB'
#!/usr/bin/env bash
# Records the invocation and the prompt, then exits 0 without doing anything.
#
# ONE LINE PER LAUNCH in the log, because the system prompt is itself hundreds
# of lines and "$*" would make a single launch look like hundreds of them.
# The argv goes to its own file, with the prompt argument elided.
printf 'LAUNCH\n' >> "$LAUNCH_AGENT_LOG"
: > "$LAUNCH_PROMPT_OUT.argv"
for a in "$@"; do
  case "$a" in
    *"You produce the deck"*) printf '<system-prompt>\n' >> "$LAUNCH_PROMPT_OUT.argv" ;;
    *) printf '%s\n' "$a" >> "$LAUNCH_PROMPT_OUT.argv" ;;
  esac
done
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--append-system-prompt" ]]; then
    printf '%s' "$2" > "$LAUNCH_PROMPT_OUT"
  fi
  if [[ "$1" == "--session-id" ]]; then
    printf '%s' "$2" > "$LAUNCH_PROMPT_OUT.session"
  fi
  shift
done
exit 0
STUB
chmod +x "$ROOT/bin/stub-agent"

LAUNCH_ROOT="$ROOT/launch"
mkdir -p "$LAUNCH_ROOT"
# A deck root with a SPACE and JAPANESE characters, for the same reason the
# rest of this file uses them: the PO's own decks live under both.
DECKS_ROOT="$LAUNCH_ROOT/my decks/資料置き場"
LAUNCH_STATE="$LAUNCH_ROOT/状態 state"
mkdir -p "$DECKS_ROOT" "$LAUNCH_STATE"
TODAY="$(date '+%Y%m%d')"

# TMUX is deliberately unset for these: deck splits no panes, so it must work
# in a plain terminal, and a test that needed a tmux server would be testing
# the server. The tmux-dependent behaviour (the badge in the window name) is
# covered through the generated helper, which must degrade without it.
run_launch() {
  env -u TMUX \
    DECK_AGENT="$ROOT/bin/stub-agent" \
    DECK_DECKS_ROOT="$DECKS_ROOT" \
    DECK_STATE_ROOT="$LAUNCH_STATE" \
    LAUNCH_AGENT_LOG="$LAUNCH_AGENT_LOG" \
    LAUNCH_PROMPT_OUT="$LAUNCH_PROMPT_OUT" \
    "$DECK" "$@" 2>&1
}

TITLE="野沢温泉 次回MTG資料"
LAUNCH_OUT="$(run_launch "$TITLE" --purpose "次回の論点合わせ" --audience "経営会議" --when "来週火曜")"
check_eq "deck <title> exits 0" "0" "$?"
check_contains "it reports the deck title back" "$LAUNCH_OUT" "$TITLE"
check_contains "it says where the deck workspace is" "$LAUNCH_OUT" "Deck workspace:"
check_contains "it says where the run artifacts are" "$LAUNCH_OUT" "Run artifacts:"
check_contains "it says how to resume" "$LAUNCH_OUT" "deck resume"
check_contains "it echoes the purpose it was given" "$LAUNCH_OUT" "次回の論点合わせ"
check_contains "it echoes the audience it was given" "$LAUNCH_OUT" "経営会議"
check_contains "it says the agent will ask for what is missing" "$LAUNCH_OUT" "the agent will ask"

DECK_WS="$DECKS_ROOT/$TODAY-野沢温泉-次回MTG資料"
check_dir "the deck workspace is created, Japanese name intact" "$DECK_WS"
check_file "and it is a real deck" "$DECK_WS/deck.yaml"
check_file "with a storyboard the AGENT will rewrite" "$DECK_WS/storyboard.yaml"
check_dir "and an inbox for returned illustrations" "$DECK_WS/inbox"

# ONE AGENT. squad needs two review lenses because judging code is subjective;
# here the review is `deck lint`, which is deterministic and already runs. A
# second pane would spend tokens re-reading a fixed answer.
check_eq "exactly ONE agent was launched" "1" "$(wc -l < "$LAUNCH_AGENT_LOG" | tr -d ' ')"
AGENT_ARGV="$(cat "$LAUNCH_PROMPT_OUT.argv")"
check_contains "the agent is given the deck title as its task" "$AGENT_ARGV" "$TITLE"
check_contains "the agent gets a session id, so a resume continues it" "$AGENT_ARGV" "--session-id"
check_contains "the agent is allowed the notion-personal MCP tools" "$AGENT_ARGV" "mcp__notion-personal"
check_contains "the agent may write files, because it writes the storyboard" "$AGENT_ARGV" "Write"
check_absent "no second agent role appears in the invocation" "$AGENT_ARGV" "advisor"

# NOTHING REACHED NOTION OR THE NETWORK. The launcher hands the agent the MCP
# tool names; it never fetches anything itself.
check_eq "the launcher made no curl or wget call" "" "$(cat "$NET_STUB_LOG")"

echo ""
echo "the agent prompt (what the one agent is actually told)"

PROMPT="$(cat "$LAUNCH_PROMPT_OUT")"
check_contains "it tells the agent to speak Japanese to the PO" "$PROMPT" "JAPANESE"
check_contains "and to keep its own notes in English" "$PROMPT" "English"
check_contains "it names the deck workspace" "$PROMPT" "$DECK_WS"
check_contains "it passes the purpose through" "$PROMPT" "次回の論点合わせ"
check_contains "it passes the meeting timing through" "$PROMPT" "来週火曜"
# THE EIGHT STEPS, each named, so a missing one is visible.
check_contains "the prompt has the INTAKE step" "$PROMPT" "1. INTAKE"
check_contains "the prompt has the SOURCE step" "$PROMPT" "2. SOURCE"
check_contains "the prompt has the LEDGER step" "$PROMPT" "3. LEDGER"
check_contains "the prompt has the AGENDA gate" "$PROMPT" "4. AGENDA - FIRST APPROVAL GATE"
check_contains "the prompt has the STORYBOARD gate" "$PROMPT" "5. STORYBOARD - SECOND APPROVAL GATE"
check_contains "the prompt has the self-repair step" "$PROMPT" "6. BUILD AND SELF-REPAIR"
check_contains "the prompt has the illustration step" "$PROMPT" "7. ILLUSTRATIONS"
check_contains "the prompt has the delivery step" "$PROMPT" "8. DELIVER"
# The rules that keep the product honest.
check_contains "it forbids fabricating an approval" "$PROMPT" "NEVER fabricate an approval"
check_contains "it forbids recording an approval the PO did not give" "$PROMPT" "approval the PO did not actually give"
check_contains "it says the PO never opens storyboard.yaml" "$PROMPT" "never have to open storyboard.yaml"
check_contains "it says to use the notion MCP tools, not a shell command" "$PROMPT" "Do NOT invent a shell command for Notion"
check_contains "it requires every pagination cursor to be followed" "$PROMPT" "FOLLOW EVERY PAGINATION CURSOR"
check_contains "it says a partial fetch blocks and must not be worked around" "$PROMPT" "Do not work around the block"
check_contains "it forbids recording an action done because it sounds finished" "$PROMPT" "NEVER record an action as"
check_contains "it requires conflicting numbers to be kept as both" "$PROMPT" "conflicts_with"
check_contains "it explains the wording rule at gate 6" "$PROMPT" "THE WORDING RULE"
check_contains "and names the digest that enforces it" "$PROMPT" "content_digest_matches"
check_contains "it tells the agent where the PO drops images" "$PROMPT" "$DECK_WS/inbox"
check_contains "it explains the 1-vs-4 exit code difference" "$PROMPT" "NEVER report a 4 as if it were a verdict"
# The prohibitions.
check_contains "the prompt forbids tmux kill-server" "$PROMPT" "NEVER run tmux kill-server"
check_contains "the prompt forbids kill-session, -window and -pane" "$PROMPT" "kill-session, kill-window or kill-pane"
check_contains "the prompt says to leave a test tmux server running" "$PROMPT" "LEAVE IT RUNNING"
check_contains "the prompt forbids git commit and push" "$PROMPT" "NEVER commit, push"
check_contains "the prompt forbids creating a worktree" "$PROMPT" "NEVER create a git worktree"
check_contains "the prompt forbids copying confidential decks into a repo" "$PROMPT" "confidential source decks"
# AWAIT-PO: the only thing that tells a PO who is not watching that they are
# the blocker.
check_contains "the prompt requires await-po clear at the start of every turn" "$PROMPT" "VERY START of every turn"
check_contains "the prompt requires await-po mark BEFORE asking" "$PROMPT" "BEFORE you write the question"
check_absent "the prompt contains NO literal tmux pane id" "$PROMPT" "%0"

echo ""
echo "the generated helpers"

RUN_DIR="$(find "$LAUNCH_STATE/runs" -mindepth 2 -maxdepth 2 -type d | head -n 1)"
check_dir "the run directory exists" "$RUN_DIR"
for helper in await-po window-name update-title deck-gate build-cycle record-source; do
  check_file "the $helper helper was generated" "$RUN_DIR/$helper"
  if [[ -x "$RUN_DIR/$helper" ]]; then ok "and $helper is executable"; else no "and $helper is executable"; fi
  # EVERY GENERATED HELPER MUST PARSE. Two of them embed a node script inside
  # a single-quoted shell string, and one apostrophe in a COMMENT inside that
  # string closes the quote and feeds the rest of the file to bash. That
  # really happened, twice, during this build; `bash -n` is what catches it.
  if bash -n "$RUN_DIR/$helper" 2>/dev/null; then
    ok "and $helper parses as bash"
  else
    no "and $helper parses as bash" "$(bash -n "$RUN_DIR/$helper" 2>&1 | head -2)"
  fi
done
check_file "the run records its state" "$RUN_DIR/state.env"
check_file "the run records what it was told at launch" "$RUN_DIR/run-info.txt"
check_file "the agent prompt is on disk, not only in argv" "$RUN_DIR/agent-prompt.md"
check_file "and a separate resume prompt" "$RUN_DIR/agent-resume-prompt.md"
check_absent "no helper carries a literal tmux pane id" "$(cat "$RUN_DIR/await-po" "$RUN_DIR/deck-gate")" "%1"

# AWAIT-PO: the marker file is the durable truth, and it works with no tmux.
AWAIT_OUT="$(env -u TMUX "$RUN_DIR/await-po" status)"
check_contains "await-po starts clear" "$AWAIT_OUT" "awaiting-po: no"
MARK_OUT="$(env -u TMUX "$RUN_DIR/await-po" mark 'アジェンダの確認')"
check_eq "await-po mark succeeds without a tmux server" "0" "$?"
check_contains "and says what it is waiting for" "$MARK_OUT" "アジェンダの確認"
check_file "and leaves a marker file, which is the durable record" "$RUN_DIR/awaiting-po.env"
check_contains "the marker records a reason at all" "$(cat "$RUN_DIR/awaiting-po.env")" "AWAITING_PO_REASON="
REASON_READ="$(bash -c 'set -a; . "$1"; printf "%s" "$AWAITING_PO_REASON"' _ "$RUN_DIR/awaiting-po.env")"
check_eq "and the reason round-trips when the marker is sourced" "アジェンダの確認" "$REASON_READ"
# Under a non-UTF-8 locale too: `cut -c 1-120` counted BYTES and could split a
# Japanese reason mid-character, and %q then wrote the PO's own words as octal
# escapes in the one file that exists to tell them why deck is waiting.
env -u TMUX LC_ALL=C LANG=C "$RUN_DIR/await-po" mark 'アジェンダの確認' > /dev/null
REASON_C="$(bash -c 'set -a; . "$1"; printf "%s" "$AWAITING_PO_REASON"' _ "$RUN_DIR/awaiting-po.env")"
check_eq "the reason survives a C locale" "アジェンダの確認" "$REASON_C"
check_contains "the window name would carry the waiting badge" "$(env -u TMUX "$RUN_DIR/window-name" display)" "[?]"
env -u TMUX "$RUN_DIR/await-po" mark 'again' > /dev/null 2>&1
check_eq "await-po mark is idempotent" "0" "$?"
env -u TMUX "$RUN_DIR/await-po" clear
check_eq "await-po clear succeeds" "0" "$?"
check_no_file "and removes the marker" "$RUN_DIR/awaiting-po.env"
env -u TMUX "$RUN_DIR/await-po" clear
check_eq "await-po clear is idempotent, which is why the agent may run it blind" "0" "$?"
check_absent "and the badge is gone from the window name" "$(env -u TMUX "$RUN_DIR/window-name" display)" "[?]"
check_eq "no half-written temp marker is left behind" "" "$(ls "$RUN_DIR" | grep 'awaiting-po.env.tmp' || true)"

# THE WINDOW NAME BUDGET is in display COLUMNS, not characters: one Japanese
# character costs two, so ten of them fill a 20-column budget exactly.
check_eq "a Japanese string is measured in display columns" "20" "$(env -u TMUX "$RUN_DIR/window-name" width "野沢温泉次回資料十字")"
check_eq "an ASCII string is measured one column per character" "5" "$(env -u TMUX "$RUN_DIR/window-name" width "abcde")"
LONG_FIT="$(env -u TMUX "$RUN_DIR/window-name" fit "野沢温泉の次回ミーティング資料をつくる" 20)"
check_contains "an over-long name is truncated with an ellipsis" "$LONG_FIT" ".."
FIT_W="$(env -u TMUX "$RUN_DIR/window-name" width "$LONG_FIT")"
if [[ "$FIT_W" -le 20 ]]; then ok "and the truncated name fits the budget"; else no "and the truncated name fits the budget" "width $FIT_W"; fi

# UPDATE-TITLE keeps the long pane title and the short window name in step.
printf '野沢温泉 11月定例 次回MTG資料\n' > "$RUN_DIR/new-title.txt"
printf '野沢温泉MTG\n' > "$RUN_DIR/new-short-name.txt"
TITLE_OUT="$(env -u TMUX "$RUN_DIR/update-title" "$RUN_DIR/new-title.txt" "$RUN_DIR/new-short-name.txt")"
check_eq "update-title succeeds without tmux" "0" "$?"
check_contains "it reports the new title" "$TITLE_OUT" "野沢温泉 11月定例 次回MTG資料"
check_eq "and stores the short name for the window" "野沢温泉MTG" "$(cat "$RUN_DIR/short-name.txt")"
: > "$RUN_DIR/empty.txt"
env -u TMUX "$RUN_DIR/update-title" "$RUN_DIR/empty.txt" "$RUN_DIR/new-short-name.txt" > /dev/null 2>&1
check_eq "an empty title file is refused rather than blanking the window" "2" "$?"

echo ""
echo "the lifecycle (list, close, resume, rm)"

LIST_OUT="$(run_launch list)"
check_contains "deck list has a RUN ID column" "$LIST_OUT" "RUN ID"
check_contains "deck list has a PHASE column" "$LIST_OUT" "PHASE"
check_contains "deck list has a WAIT column, for a PO who is not watching" "$LIST_OUT" "WAIT"
check_contains "deck list shows the title update-title wrote" "$LIST_OUT" "野沢温泉 11月定例 次回MTG資料"
check_contains "deck list derives the phase from the deck on disk" "$LIST_OUT" "drafting"
RUN_ID="$(basename "$RUN_DIR")"
check_contains "deck list shows the run id" "$LIST_OUT" "$RUN_ID"

# The badge shows in `deck list` too, because that is where a PO looks when
# they have several decks going.
env -u TMUX "$RUN_DIR/await-po" mark 'copy approval' > /dev/null
check_contains "a waiting run is flagged in deck list" "$(run_launch list)" "[?]"
env -u TMUX "$RUN_DIR/await-po" clear

CLOSE_OUT="$(run_launch close "$RUN_ID")"
check_eq "deck close exits 0" "0" "$?"
check_contains "close says the deck itself is untouched" "$CLOSE_OUT" "untouched"
check_contains "close says how to resume" "$CLOSE_OUT" "deck resume $RUN_ID"
check_file "the deck survives a close" "$DECK_WS/deck.yaml"
check_contains "and the run is listed as closed" "$(run_launch list)" "closed"
# CLOSE IS NOT DESTRUCTIVE, and that is a deliberate difference from squad.
# squad's close kills the run's tmux window because squad created it and split
# three panes into it. deck creates no window: it runs one agent in the pane
# the PO was already standing in, so killing it would take a window deck was
# never given, with whatever else was in it.
check_absent "close killed no tmux window" "$(cat "$TMUX_STUB_LOG")" "kill-window"
check_absent "close killed no tmux session" "$(cat "$TMUX_STUB_LOG")" "kill-session"
check_absent "close killed no tmux pane" "$(cat "$TMUX_STUB_LOG")" "kill-pane"

: > "$LAUNCH_AGENT_LOG"
RESUME_OUT="$(run_launch resume "$RUN_ID")"
check_eq "deck resume exits 0" "0" "$?"
check_contains "resume names the deck" "$RESUME_OUT" "$DECK_WS"
check_contains "resume reports the phase it is picking up from" "$RESUME_OUT" "Phase:"
check_contains "resume reports how much of the repair cap is spent" "$RESUME_OUT" "Repair rounds used:"
check_eq "resume launches exactly one agent" "1" "$(wc -l < "$LAUNCH_AGENT_LOG" | tr -d ' ')"
check_contains "resume continues the SAME agent session" "$(cat "$LAUNCH_PROMPT_OUT.argv")" "$(cat "$LAUNCH_PROMPT_OUT.session")"
RESUME_PROMPT="$(cat "$LAUNCH_PROMPT_OUT")"
check_contains "the resumed agent is told it was resumed" "$RESUME_PROMPT" "RESUMED"
check_contains "and told to re-read the phase from disk, not from memory" "$RESUME_PROMPT" "The deck on disk is"
check_contains "and told the repair cap does not reset" "$RESUME_PROMPT" "does NOT reset it"
check_contains "and told the awaiting-PO marker survived" "$RESUME_PROMPT" "marker deliberately survived"
check_contains "and given the commands to orient itself" "$RESUME_PROMPT" "build-cycle' --status"

# RESUME AFTER AN INTERRUPTION AT EACH GATE. The phase is re-derived from what
# is on disk, so a run that died mid-flow resumes where the DECK is, not where
# the agent remembers being. This is the whole of "the PO will walk away".
resume_phase_at() {
  local label="$1" want="$2" out
  out="$(run_launch resume "$RUN_ID" 2>&1)"
  check_contains "resume after $label reports phase $want" "$out" "Phase: $want"
}
resume_phase_at "nothing approved" "drafting"
( cd "$DECK_WS" && run_launch gate approve agenda > /dev/null 2>&1 )
resume_phase_at "the agenda gate" "agenda-approved"
( cd "$DECK_WS" && run_launch gate approve content > /dev/null 2>&1 )
resume_phase_at "the content gate" "content-approved"

# APPROVAL INVALIDATION: changing the WORDS invalidates content approval and
# the phase falls back. This is what sends the agent back to gate 5 after a
# repair round that rewrote a title.
STORY_BEFORE="$(cat "$DECK_WS/storyboard.yaml")"
printf '%s\n' "${STORY_BEFORE//ここにタイトルを書く/まったく別のタイトル}" > "$DECK_WS/storyboard.yaml"
resume_phase_at "a WORDING change" "drafting"
printf '%s' "$STORY_BEFORE" > "$DECK_WS/storyboard.yaml"
resume_phase_at "putting the words back" "content-approved"

# ... and a change that is NOT content does not invalidate it. The digest is
# over a canonical projection of the words, so re-indenting or commenting the
# request file leaves an approval standing.
printf '\n# a comment is not a content change\n' >> "$DECK_WS/deck.yaml"
resume_phase_at "a deck.yaml comment" "content-approved"

RM_OUT="$(run_launch rm "$RUN_ID" 2>&1)"
check_eq "deck rm exits 0" "0" "$?"
check_contains "rm says the deck is untouched" "$RM_OUT" "untouched"
check_no_file "the run artifacts are gone" "$RUN_DIR/state.env"
check_file "THE DECK IS NEVER DELETED by rm - it is the PO's document" "$DECK_WS/deck.yaml"
check_absent "and the removed run is no longer listed" "$(run_launch list)" "$RUN_ID"

# A run whose deck has been moved away cannot be resumed, and says so instead
# of launching an agent into nothing.
run_launch "使い捨て資料" > /dev/null 2>&1
GONE_RUN="$(find "$LAUNCH_STATE/runs/$TODAY-使い捨て資料" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
GONE_DECK="$DECKS_ROOT/$TODAY-使い捨て資料"
check_dir "the throwaway deck exists first" "$GONE_DECK"
mv "$GONE_DECK" "$GONE_DECK-moved-away"
: > "$LAUNCH_AGENT_LOG"
NODECK_OUT="$(run_launch resume "$(basename "$GONE_RUN")" 2>&1)"
check_ne "resuming a run whose deck is gone fails" "0" "$?"
check_contains "and says the deck is gone" "$NODECK_OUT" "is gone"
check_eq "and launches no agent" "" "$(cat "$LAUNCH_AGENT_LOG")"

# DECK CLEAN asks first, and deletes run artifacts only. Driven with a piped
# answer, because the prompt is the point: `clean` is the one verb that touches
# several runs at once.
CLEAN_STATE="$LAUNCH_ROOT/clean state"
mkdir -p "$CLEAN_STATE"
clean_launch() {
  env -u TMUX DECK_AGENT="$ROOT/bin/stub-agent" DECK_DECKS_ROOT="$DECKS_ROOT" \
    DECK_STATE_ROOT="$CLEAN_STATE" LAUNCH_AGENT_LOG="$LAUNCH_AGENT_LOG" \
    LAUNCH_PROMPT_OUT="$LAUNCH_PROMPT_OUT" "$DECK" "$@" 2>&1
}
clean_launch "資料A" > /dev/null 2>&1
clean_launch "資料B" > /dev/null 2>&1
CLEAN_LIST="$(clean_launch list)"
check_contains "two runs are listed before cleaning" "$CLEAN_LIST" "資料A"
DECLINED="$(printf 'n\n' | clean_launch clean)"
check_contains "clean asks before deleting anything" "$DECLINED" "Continue?"
check_contains "and says the decks are NOT deleted" "$DECLINED" "decks themselves are NOT deleted"
check_contains "and a declined clean says so" "$DECLINED" "Cancelled"
check_contains "and the runs survive a declined clean" "$(clean_launch list)" "資料A"
ACCEPTED="$(printf 'y\n' | clean_launch clean)"
check_contains "an accepted clean removes the run artifacts" "$ACCEPTED" "Removed run artifacts"
check_absent "and the runs are gone" "$(clean_launch list)" "資料A"
check_file "but the DECK survives, because it is the PO's document" "$DECKS_ROOT/$TODAY-資料A/deck.yaml"
check_file "and so does the other one" "$DECKS_ROOT/$TODAY-資料B/deck.yaml"
NOTHING="$(printf 'y\n' | clean_launch clean)"
# "every retained run is still running" would be a small lie when there are no
# runs at all, and the PO would have to go and check it.
check_contains "cleaning with no runs says exactly that" "$NOTHING" "there are no retained runs"

echo ""
echo "the state root is honoured, and never the PO's real one"

check_dir "runs live under DECK_STATE_ROOT" "$LAUNCH_STATE/runs"
XDG_STATE="$ROOT/xdg state"
mkdir -p "$XDG_STATE"
XDG_OUT="$(env -u TMUX -u DECK_STATE_ROOT XDG_STATE_HOME="$XDG_STATE" \
  DECK_AGENT="$ROOT/bin/stub-agent" DECK_DECKS_ROOT="$DECKS_ROOT" \
  LAUNCH_AGENT_LOG="$LAUNCH_AGENT_LOG" LAUNCH_PROMPT_OUT="$LAUNCH_PROMPT_OUT" \
  "$DECK" "XDG のテスト" 2>&1)"
check_eq "a launch with no DECK_STATE_ROOT exits 0" "0" "$?"
check_dir "and XDG_STATE_HOME is used, as squad and vet do" "$XDG_STATE/deck/runs"

echo ""
echo "the repair cap is mechanical, not a promise"

CAP_WS="$DECKS_ROOT/cap test"
run_launch gate init "$CAP_WS" > /dev/null 2>&1
CAP_OUT="$(env -u TMUX DECK_AGENT="$ROOT/bin/stub-agent" DECK_DECKS_ROOT="$DECKS_ROOT" \
  DECK_STATE_ROOT="$LAUNCH_STATE" DECK_REPAIR_MAX_ROUNDS=2 \
  LAUNCH_AGENT_LOG="$LAUNCH_AGENT_LOG" LAUNCH_PROMPT_OUT="$LAUNCH_PROMPT_OUT" \
  "$DECK" "上限のテスト" --dir "$CAP_WS" 2>&1)"
check_contains "the cap is reported at launch" "$CAP_OUT" "Repair rounds:  2 maximum"
CAP_RUN="$(find "$LAUNCH_STATE/runs/cap test" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
check_contains "and the agent is told the cap" "$(cat "$CAP_RUN/agent-prompt.md")" "Repair cap:     2 round(s)"
CAP_STATUS="$("$CAP_RUN/build-cycle" --status)"
check_contains "build-cycle --status reports the round" "$CAP_STATUS" "round=0"
check_contains "build-cycle --status reports the cap" "$CAP_STATUS" "cap=2"
check_contains "and whether this is the final round" "$CAP_STATUS" "final_round=no"
# THE COUNT IS A FILE, not the agent's memory. A cap an agent polices by
# remembering how many times it has looped is a cap that a long transcript
# loses, and the failure mode is an unbounded token burn nobody is watching.
printf '2\n' > "$CAP_RUN/repair-round.txt"
CAP_REFUSE="$("$CAP_RUN/build-cycle" 2>&1)"
check_eq "a round past the cap is REFUSED with its own exit code" "3" "$?"
check_contains "and says the cap is spent" "$CAP_REFUSE" "cap of 2 round(s) is spent"
check_contains "and says not to loop again" "$CAP_REFUSE" "Do NOT run another round"
check_contains "and tells the agent to report to the PO" "$CAP_REFUSE" "awaiting the PO"
check_contains "the refusal is machine-readable too" "$CAP_REFUSE" "refused=yes"
check_no_file "and it rendered nothing, so the refusal cost nothing" "$CAP_WS/out/deck.pdf"
# A RESET IS BOUND TO A NEWLY APPROVED REVISION. Without that the cap is
# advisory: an agent out of rounds could reset and keep going, and nothing
# would record that it had.
RESET_REFUSED="$("$CAP_RUN/build-cycle" --reset 2>&1)"
check_ne "--reset is REFUSED with no current content approval" "0" "$?"
check_contains "and says a reset is earned by a new approval" "$RESET_REFUSED" "approving a new revision"
check_contains "and says so machine-readably too" "$RESET_REFUSED" "reset=refused"
check_eq "and the counter is untouched" "2" "$(cat "$CAP_RUN/repair-round.txt")"

# With a current content approval it is accepted, once.
( cd "$CAP_WS" && run_launch gate approve content > /dev/null 2>&1 )
RESET_OUT="$("$CAP_RUN/build-cycle" --reset 2>&1)"
check_contains "--reset is accepted once the wording is approved" "$RESET_OUT" "round=0"
check_eq "and the count file really is reset" "0" "$(cat "$CAP_RUN/repair-round.txt")"
check_file "and the revision it was reset for is recorded" "$CAP_RUN/repair-reset-digest.txt"
printf '2\n' > "$CAP_RUN/repair-round.txt"
AGAIN="$("$CAP_RUN/build-cycle" --reset 2>&1)"
check_ne "a SECOND reset for the same approved revision is refused" "0" "$?"
check_contains "and says why" "$AGAIN" "SAME approved revision"
check_eq "and the counter stays spent" "2" "$(cat "$CAP_RUN/repair-round.txt")"

echo ""
echo "gen-helpers: the whole generated surface, with nothing launched"

: > "$LAUNCH_AGENT_LOG"
GEN_DIR="$ROOT/gen helpers/生成"
GEN_OUT="$(env -u TMUX DECK_GEN_TASK="検査用" "$DECK" gen-helpers "$GEN_DIR" 2>&1)"
check_eq "gen-helpers exits 0" "0" "$?"
check_contains "and says where it wrote, spaces and Japanese intact" "$GEN_OUT" "gen helpers/生成"
check_eq "gen-helpers launches NO agent, which is the point of it" "" "$(cat "$LAUNCH_AGENT_LOG")"
for f in await-po window-name window-width.mjs update-title deck-gate build-cycle record-source agent-prompt.md agent-resume-prompt.md; do
  check_file "gen-helpers wrote $f" "$GEN_DIR/$f"
done
for helper in await-po window-name update-title deck-gate build-cycle record-source; do
  if bash -n "$GEN_DIR/$helper" 2>/dev/null; then
    ok "the generated $helper parses"
  else
    no "the generated $helper parses" "$(bash -n "$GEN_DIR/$helper" 2>&1 | head -2)"
  fi
done
check_contains "the generated prompt carries the task" "$(cat "$GEN_DIR/agent-prompt.md")" "検査用"
# A REUSED DIRECTORY IS REFUSED: gen-helpers writes fixed file names with plain
# redirection, and redirection follows a symlink already sitting at a target
# name. An empty directory cannot contain one.
env -u TMUX "$DECK" gen-helpers "$GEN_DIR" > /dev/null 2>&1
check_ne "gen-helpers refuses a non-empty directory" "0" "$?"
REUSE_OUT="$(env -u TMUX "$DECK" gen-helpers "$GEN_DIR" 2>&1)"
check_contains "and says why" "$REUSE_OUT" "is not empty"

echo ""
echo "launcher argument handling"

for flag in --source --purpose --audience --when --dir --theme; do
  FLAG_OUT="$(run_launch "タイトル" "$flag" 2>&1)"
  check_ne "$flag with no value is refused" "0" "$?"
  check_contains "and says which flag" "$FLAG_OUT" "$flag requires a value"
done
BAD_FLAG="$(run_launch "タイトル" --nonsense 2>&1)"
check_ne "an unknown option is refused" "0" "$?"
check_contains "and points at the help" "$BAD_FLAG" "deck --help"
NO_TITLE="$(run_launch --source https://example.invalid/page 2>&1)"
check_ne "a launch with no title is refused" "0" "$?"
check_contains "and shows an example" "$NO_TITLE" "野沢温泉"
run_launch rm > /dev/null 2>&1
check_ne "deck rm with no run id is refused" "0" "$?"

# --source is REPEATABLE: minutes in Notion plus a spreadsheet on disk is one
# deck, and the agent is told about both.
: > "$LAUNCH_AGENT_LOG"
run_launch "二つの資料" --source https://example.invalid/a --source ./notes.md > /dev/null 2>&1
TWO_RUN="$(find "$LAUNCH_STATE/runs/$TODAY-二つの資料" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
TWO_PROMPT="$(cat "$TWO_RUN/agent-prompt.md")"
check_contains "the first --source reaches the agent" "$TWO_PROMPT" "https://example.invalid/a"
check_contains "the second --source reaches the agent too" "$TWO_PROMPT" "./notes.md"

# --dir puts the deck exactly where asked, including on a spaced path, and
# including when the PARENT does not exist yet - which is the ordinary case.
#
# The parent is deliberately NOT created here. The obvious way to resolve a
# path that does not exist yet,
#   $(cd "$(dirname "$x")" && pwd)/$(basename "$x")
# collapses to "/<basename>" when the cd fails, and the surrounding || does not
# fire because the ASSIGNMENT succeeded - so deck tried to create the deck at
# the FILESYSTEM ROOT. These tests are what found that.
EXPLICIT="$LAUNCH_ROOT/explicit dir/明示"
check_no_file "the parent of --dir does not exist yet" "$LAUNCH_ROOT/explicit dir"
run_launch "明示指定" --dir "$EXPLICIT" > /dev/null 2>&1
check_file "--dir creates the deck exactly there, parent and all" "$EXPLICIT/deck.yaml"
check_no_file "and NOT at the filesystem root" "/明示"
check_no_file "nor did gen-helpers write there" "/生成"

# Standing INSIDE a deck means working on THAT deck: the PO cd'd there on
# purpose, so scaffolding a second workspace would be the wrong answer.
INSIDE_OUT="$(cd "$EXPLICIT" && run_launch "同じ資料の続き" 2>&1)"
check_contains "a launch inside a deck uses THAT deck" "$INSIDE_OUT" "Using the deck you are standing in"
check_contains "and names it, spaces and Japanese intact" "$INSIDE_OUT" "explicit dir/明示"

echo ""
echo "the deck-gate helper records every gate it runs"

GATE_RUN="$TWO_RUN"
GATE_DECK="$DECKS_ROOT/$TODAY-二つの資料"
VALIDATE_OUT="$("$GATE_RUN/deck-gate" validate 2>&1)"
check_eq "deck-gate validate exits 0 on a scaffolded deck" "0" "$?"
check_contains "and the output says which gate ran" "$VALIDATE_OUT" "=== deck gate validate ==="
check_file "a result file is recorded for the run" "$GATE_RUN/gate-validate-result.txt"
check_eq "and a status file holding the PROCESS status" "0" "$(cat "$GATE_RUN/gate-validate-status.txt")"
# THE EXIT CODE IS PASSED THROUGH, because 1 and 4 are different events: a
# gate that completed and refused is not a gate that died.
printf 'schema: deck.storyboard/1\ntitle: ""\nslides: []\n' > "$GATE_DECK/storyboard.yaml"
"$GATE_RUN/deck-gate" validate > /dev/null 2>&1
check_eq "a FAILING verdict comes back as 1, not 0" "1" "$?"
check_eq "and the status file records it" "1" "$(cat "$GATE_RUN/gate-validate-status.txt")"
"$GATE_RUN/deck-gate" nonsense-gate > /dev/null 2>&1
check_eq "an unknown gate is a usage error" "2" "$?"
"$GATE_RUN/deck-gate" ../../etc/passwd > /dev/null 2>&1
check_eq "a gate name that is a path is refused" "2" "$?"

echo ""
echo "record-source: sources are immutable once written"

SRC_DECK="$EXPLICIT"
SRC_RUN="$(find "$LAUNCH_STATE/runs/明示" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
mkdir -p "$SRC_DECK/sources"
printf '決定: 価格は 18,000円 とする。\n' > "$SRC_DECK/sources/mtg.txt"
# A REAL RESPONSE SHAPE. The source gate derives the block count and the
# pagination record from these bytes rather than believing the manifest, so a
# placeholder {"object":"page"} is no longer evidence of anything.
printf '[{"object":"list","results":[{"object":"block","id":"m1","type":"paragraph","has_children":false,"paragraph":{"rich_text":[{"plain_text":"決定: 価格は 18,000円 とする。"}]}}],"has_more":false,"next_cursor":null}]\n' > "$SRC_DECK/sources/mtg.json"
REC_OUT="$("$SRC_RUN/record-source" mtg notion 'https://example.invalid/p' sources/mtg.txt yes sources/mtg.json 2>&1)"
check_contains "record-source records the source" "$REC_OUT" 'recorded source "mtg"'
check_file "and writes the manifest" "$SRC_DECK/sources/manifest.json"
check_contains "the recorded path is workspace-relative" "$(cat "$SRC_DECK/sources/manifest.json")" '"text_file": "sources/mtg.txt"'
# A relative path is resolved against the DECK, not the cwd. Resolving it
# against the cwd produced ../../../../private/tmp/... on a deck under a
# symlinked parent, which then failed its own containment check.
check_absent "and did not escape through a symlinked parent" "$(cat "$SRC_DECK/sources/manifest.json")" "../"
REC_AGAIN="$("$SRC_RUN/record-source" mtg notion 'https://example.invalid/p' sources/mtg.txt yes 2>&1)"
check_ne "re-recording the same source id is refused" "0" "$?"
check_contains "because a ledger quote was verified against those bytes" "$REC_AGAIN" "immutable"
REC_OUTSIDE="$("$SRC_RUN/record-source" esc notion 'x' /etc/passwd yes 2>&1)"
check_ne "a source outside the deck is refused" "0" "$?"
check_contains "and says sources must travel with the deck" "$REC_OUTSIDE" "outside the deck workspace"
REC_MISSING="$("$SRC_RUN/record-source" nope notion 'x' sources/absent.txt yes 2>&1)"
check_ne "a source naming a file that does not exist is refused" "0" "$?"

# A PARTIAL FETCH BLOCKS, through the helper the agent actually uses.
printf '途中までの議事録\n' > "$SRC_DECK/sources/partial.txt"
printf '[{"object":"list","results":[{"object":"block","id":"p1","type":"paragraph","paragraph":{"rich_text":[{"plain_text":"途中までの議事録"}]}}],"has_more":false,"next_cursor":null}]\n' > "$SRC_DECK/sources/partial.json"
"$SRC_RUN/record-source" partial notion 'https://example.invalid/q' sources/partial.txt no sources/partial.json > /dev/null 2>&1
PARTIAL_OUT="$("$SRC_RUN/deck-gate" source 2>&1)"
check_ne "deck gate source fails on a partial fetch" "0" "$?"
check_contains "and names the incomplete source" "$PARTIAL_OUT" "partial"
check_contains "and says a partial fetch blocks approval" "$PARTIAL_OUT" "blocks agenda approval"

echo ""
echo "launcher BEHAVIOUR, not prompt strings"
#
# Everything above asserts what the agent is TOLD. These assert what the
# launcher DOES, because a prompt-string assertion cannot catch any of them:
# a resume that starts a fresh conversation, a source path resolved against
# the wrong directory, a close that loses track of a live process, or a cap
# that silently reverts to the default. Each of these shipped.

# A stub that records the CONTRACT - which session flag, which cwd, which
# arguments - with the system prompt elided so one launch is one line.
cat > "$ROOT/bin/contract-agent" <<'STUB'
#!/usr/bin/env bash
printf 'LAUNCH cwd=%s\n' "$PWD" >> "$CONTRACT_LOG"
# What the world looks like AT THE MOMENT THE AGENT STARTS. The launcher
# clears the awaiting-PO marker once the agent exits, which is correct - there
# is no agent turn left to clear it - so "the marker survived into the resumed
# session" can only be observed from inside the session.
if [[ -n "${MARKER_PROBE:-}" ]]; then
  if [[ -e "$MARKER_PROBE" ]]; then
    printf 'MARKER_AT_LAUNCH=present\n' >> "$CONTRACT_LOG"
  else
    printf 'MARKER_AT_LAUNCH=absent\n' >> "$CONTRACT_LOG"
  fi
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume)     printf 'SESSION_MODE=resume id=%s\n' "$2" >> "$CONTRACT_LOG"; shift 2 ;;
    --session-id) printf 'SESSION_MODE=new id=%s\n' "$2" >> "$CONTRACT_LOG"; shift 2 ;;
    --append-system-prompt)
      # The prompt itself is recorded by LENGTH only: these tests are about
      # behaviour, and a substring match on prose is what hid these defects.
      printf 'PROMPT_CHARS=%s\n' "${#2}" >> "$CONTRACT_LOG"; shift 2 ;;
    *) printf 'ARG=%s\n' "$1" >> "$CONTRACT_LOG"; shift ;;
  esac
done
exit 0
STUB
chmod +x "$ROOT/bin/contract-agent"

export CONTRACT_LOG="$ROOT/contract.log"
BEH_ROOT="$ROOT/behaviour"
BEH_DECKS="$BEH_ROOT/my decks"
BEH_STATE="$BEH_ROOT/状態"
mkdir -p "$BEH_DECKS" "$BEH_STATE" "$BEH_ROOT/invoked from here"

beh() {
  env -u TMUX \
    DECK_AGENT="$ROOT/bin/contract-agent" \
    DECK_DECKS_ROOT="$BEH_DECKS" \
    DECK_STATE_ROOT="$BEH_STATE" \
    CONTRACT_LOG="$CONTRACT_LOG" \
    "$DECK" "$@" 2>&1
}

# ---------------------------------------------------------------- RESUME
#
# --session-id NAMES a new session; it does not ask for an existing
# conversation back, and on a session that already exists it can fail
# outright. A resume that silently started fresh lost the whole interview -
# the purpose, the audience, the agenda discussion, every answer the PO had
# given. The prompt was identical either way, so no prompt assertion saw it.
: > "$CONTRACT_LOG"
beh "再開の契約テスト" > /dev/null 2>&1
BEH_RUN="$(find "$BEH_STATE/runs" -mindepth 2 -maxdepth 2 -type d | head -n 1)"
BEH_ID="$(basename "$BEH_RUN")"
check_contains "a first launch NAMES a new session" "$(cat "$CONTRACT_LOG")" "SESSION_MODE=new"
FIRST_ID="$(grep -o 'id=[0-9a-f-]*' "$CONTRACT_LOG" | head -n 1 | cut -d= -f2)"
check_ne "and the session id is not empty" "" "$FIRST_ID"

: > "$CONTRACT_LOG"
beh resume "$BEH_ID" > /dev/null 2>&1
check_contains "a RESUME asks for the existing conversation back" "$(cat "$CONTRACT_LOG")" "SESSION_MODE=resume"
check_absent "and does NOT name a new session" "$(cat "$CONTRACT_LOG")" "SESSION_MODE=new"
RESUMED_ID="$(grep -o 'id=[0-9a-f-]*' "$CONTRACT_LOG" | head -n 1 | cut -d= -f2)"
check_eq "and it is the SAME session, so the interview survives" "$FIRST_ID" "$RESUMED_ID"

# ---------------------------------------------- A CALLER-RELATIVE --source
#
# The launcher cds into the deck workspace before starting the agent, so a
# relative path stored verbatim pointed at a file that was never there - and
# the directory the PO typed it in was recorded nowhere, so it could not even
# be reconstructed afterwards.
printf 'ここに議事録のテキスト\n' > "$BEH_ROOT/invoked from here/notes.md"
: > "$CONTRACT_LOG"
( cd "$BEH_ROOT/invoked from here" && beh "相対パスの契約テスト" --source ./notes.md > /dev/null 2>&1 )
# SELECTED BY ITS TITLE, not by grepping the prompt for notes.md: the prompt
# TEMPLATE uses ./notes.md as its worked example of a relative path, so every
# run ever generated matches that search and `find` returns them in
# filesystem order. This test passed or failed depending on which run the
# directory happened to list first.
REL_RUN="$(find "$BEH_STATE/runs" -mindepth 2 -maxdepth 2 -type d -path '*相対パスの契約テスト*' | sort | tail -n 1)"
check_dir "the relative-source run exists" "$REL_RUN"
REL_SRC="$(grep '^- Source:' "$REL_RUN/agent-prompt.md" | head -n 1 | sed 's/^- Source: *//')"
# Compared against the path the SHELL resolves, because deck resolves it the
# same way (cd + pwd): TMPDIR here carries a trailing slash, and on macOS
# /tmp is a symlink, so the literal string differs while the file is the same.
REL_WANT="$(cd "$BEH_ROOT/invoked from here" && pwd)/notes.md"
check_eq "--source ./notes.md resolves to the file the PO meant" "$REL_WANT" "$REL_SRC"
if [[ -f "$REL_SRC" ]]; then ok "and that path really exists"; else no "and that path really exists" "$REL_SRC"; fi
# The agent's cwd is the DECK, which is exactly why the path had to be
# resolved before the launch rather than passed through.
check_contains "the agent runs in the deck workspace" "$(cat "$CONTRACT_LOG")" "LAUNCH cwd="
check_absent "so a bare ./notes.md would have been wrong" "$REL_SRC" "./notes.md"
check_contains "and the invocation directory is recorded" "$(cat "$REL_RUN/state.env")" "INVOKED_FROM"

# A URL is NOT a path and must pass through untouched.
: > "$CONTRACT_LOG"
beh "URLの契約テスト" --source https://www.notion.so/a-page-id > /dev/null 2>&1
URL_RUN="$(find "$BEH_STATE/runs" -mindepth 2 -maxdepth 2 -type d | while IFS= read -r d; do
  [[ -f "$d/agent-prompt.md" ]] && grep -q 'a-page-id' "$d/agent-prompt.md" && printf '%s\n' "$d"
done | head -n 1)"
check_contains "a Notion URL reaches the agent unchanged" \
  "$(grep '^- Source:' "$URL_RUN/agent-prompt.md")" "https://www.notion.so/a-page-id"

# A path that does not exist warns and still launches: the PO may be about to
# save the file, and refusing the whole launch over it would be worse.
MISSING_OUT="$(cd "$BEH_ROOT/invoked from here" && beh "存在しないソース" --source ./not-saved-yet.md 2>&1)"
check_contains "a missing --source warns" "$MISSING_OUT" "does not exist yet"
check_contains "and says where it looked" "$MISSING_OUT" "invoked from here/not-saved-yet.md"
check_contains "and the launch still happens" "$MISSING_OUT" "Run artifacts:"

# ------------------------------------------- CLOSE WHILE THE AGENT IS LIVE
#
# close deliberately leaves the agent running - deck did not create the pane
# and will not kill it. But it used to clear the recorded pid at the same
# time, so the next resume saw a dead run and started a SECOND agent against
# the same run directory, and rm/clean would delete helpers the live agent was
# still executing.
cat > "$ROOT/bin/lingering-agent" <<'STUB'
#!/usr/bin/env bash
printf 'started\n' >> "$CONTRACT_LOG"
# Long enough for the assertions below, short enough to be gone by the end of
# the suite. Nothing kills it: the point is that deck copes with it running.
sleep 45
STUB
chmod +x "$ROOT/bin/lingering-agent"

: > "$CONTRACT_LOG"
( env -u TMUX DECK_AGENT="$ROOT/bin/lingering-agent" DECK_DECKS_ROOT="$BEH_DECKS" \
    DECK_STATE_ROOT="$BEH_STATE" CONTRACT_LOG="$CONTRACT_LOG" \
    "$DECK" "生存中の契約テスト" > "$ROOT/live.log" 2>&1 & )
# Wait for the agent to actually start rather than guessing at a sleep.
LIVE_WAIT=0
while [[ ! -s "$CONTRACT_LOG" && "$LIVE_WAIT" -lt 100 ]]; do
  sleep 0.1
  LIVE_WAIT=$((LIVE_WAIT + 1))
done
LIVE_RUN="$(find "$BEH_STATE/runs" -mindepth 2 -maxdepth 2 -type d | while IFS= read -r d; do
  grep -q '生存中' "$d/title.txt" 2>/dev/null && printf '%s\n' "$d"
done | head -n 1)"
LIVE_ID="$(basename "$LIVE_RUN")"
check_dir "the live run exists" "$LIVE_RUN"
check_contains "deck list reports it as running" "$(beh list)" "running"

LIVE_CLOSE="$(beh close "$LIVE_ID")"
check_contains "close says the agent is still running" "$LIVE_CLOSE" "STILL RUNNING"
check_contains "and that resume and rm are refused until it exits" "$LIVE_CLOSE" "resume and rm are refused"
check_contains "THE PID SURVIVES THE CLOSE" "$(cat "$LIVE_RUN/state.env")" "LAUNCHER_PID="
LIVE_PID="$(grep '^LAUNCHER_PID=' "$LIVE_RUN/state.env" | cut -d= -f2 | tr -d "'")"
check_ne "and it is not empty" "" "$LIVE_PID"

RESUME_LIVE="$(beh resume "$LIVE_ID" 2>&1)"
check_ne "resuming a live run is REFUSED" "0" "$?"
check_contains "and names the pid still holding it" "$RESUME_LIVE" "still running (pid"
RM_LIVE="$(beh rm "$LIVE_ID" 2>&1)"
check_ne "removing a live run is REFUSED" "0" "$?"
check_contains "so no helper is deleted under a running agent" "$RM_LIVE" "still running"
# Exactly one agent was started for that run: the refused resume launched none.
check_eq "and no second agent was started on the same run" "1" \
  "$(grep -c '^started$' "$CONTRACT_LOG")"

# ------------------------------------------------- A PERSISTED CUSTOM CAP
#
# resolve_repair_max_rounds took the environment or the default
# unconditionally, and resume called it AFTER loading the run - so a run
# launched with DECK_REPAIR_MAX_ROUNDS=7 came back with a cap of 3 and the
# agent was told a limit the PO had never set.
: > "$CONTRACT_LOG"
env -u TMUX DECK_REPAIR_MAX_ROUNDS=7 DECK_AGENT="$ROOT/bin/contract-agent" \
  DECK_DECKS_ROOT="$BEH_DECKS" DECK_STATE_ROOT="$BEH_STATE" CONTRACT_LOG="$CONTRACT_LOG" \
  "$DECK" "上限7の契約テスト" > /dev/null 2>&1
CAP7_RUN="$(find "$BEH_STATE/runs" -mindepth 2 -maxdepth 2 -type d | while IFS= read -r d; do
  grep -q '上限7' "$d/title.txt" 2>/dev/null && printf '%s\n' "$d"
done | head -n 1)"
check_contains "the custom cap is recorded in the run state" "$(cat "$CAP7_RUN/state.env")" "REPAIR_MAX_ROUNDS=7"
check_contains "and baked into the build-cycle helper" "$(cat "$CAP7_RUN/build-cycle")" "CAP=7"
# The resume runs WITHOUT the environment variable, which is the real case: the
# PO set it once, in the shell they launched from, hours ago.
RESUME_CAP="$(beh resume "$(basename "$CAP7_RUN")" 2>&1)"
check_contains "A RESUME PRESERVES THE RECORDED CAP" "$RESUME_CAP" "of 7"
check_contains "the regenerated helper still carries it" "$(cat "$CAP7_RUN/build-cycle")" "CAP=7"
check_contains "and the agent is still told 7" "$(cat "$CAP7_RUN/agent-prompt.md")" "Repair cap:     7 round(s)"
# An explicitly set variable still wins, and says so rather than changing it
# silently.
OVERRIDE="$(env -u TMUX DECK_REPAIR_MAX_ROUNDS=2 DECK_AGENT="$ROOT/bin/contract-agent" \
  DECK_DECKS_ROOT="$BEH_DECKS" DECK_STATE_ROOT="$BEH_STATE" CONTRACT_LOG="$CONTRACT_LOG" \
  "$DECK" resume "$(basename "$CAP7_RUN")" 2>&1)"
check_contains "an explicit override is honoured" "$OVERRIDE" "of 2"
check_contains "and reported rather than applied silently" "$OVERRIDE" "recorded a repair cap of 7"

# ------------------------------------------------ AN UNKNOWN RUN ID
#
# An explicit id that does not exist used to fall through to "latest", so a
# mistyped id silently resumed, closed or REMOVED a different deck's run.
UNKNOWN="$(beh resume definitely-not-a-run-id 2>&1)"
check_ne "an unknown explicit run id is refused" "0" "$?"
check_contains "and says so by name" "$UNKNOWN" "no deck run with id"
check_contains "and says it will not substitute another" "$UNKNOWN" "will not fall back"
UNKNOWN_RM="$(beh rm definitely-not-a-run-id 2>&1)"
check_contains "rm refuses an unknown id too" "$UNKNOWN_RM" "no deck run with id"

# "Latest" is by RECORDED START TIME, not by path. The path begins with the
# deck directory name, so sorting it made a week-old "zebra" run outrank a
# minute-old "ab" run.
mkdir -p "$BEH_STATE/runs/zzz-deck/old-run" "$BEH_STATE/runs/aaa-deck/new-run"
cat > "$BEH_STATE/runs/zzz-deck/old-run/state.env" <<EOF
RUN_ID=old-run
STARTED_AT='2020-01-01 00:00:00'
TASK=古い
DECK_DIR=$BEH_DECKS/nonexistent-old
RUN_DIR=$BEH_STATE/runs/zzz-deck/old-run
RUN_STATUS=closed
EOF
cat > "$BEH_STATE/runs/aaa-deck/new-run/state.env" <<EOF
RUN_ID=new-run
STARTED_AT='2099-01-01 00:00:00'
TASK=新しい
DECK_DIR=$BEH_DECKS/nonexistent-new
RUN_DIR=$BEH_STATE/runs/aaa-deck/new-run
RUN_STATUS=closed
EOF
LATEST="$(beh resume 2>&1)"
check_contains "latest is the newest by recorded START TIME, not by path" "$LATEST" "nonexistent-new"
check_absent "so an alphabetically later deck does not win" "$LATEST" "nonexistent-old"
rm -rf "$BEH_STATE/runs/zzz-deck" "$BEH_STATE/runs/aaa-deck"

echo ""
echo "THE REAL WORKFLOW: agenda approved BEFORE the storyboard exists"
#
# This is the order every normal run takes, and nothing tested it. The agenda
# gate runs at step 4; the agent writes storyboard.yaml at step 5. The agenda
# approval used to be recorded against the storyboard's SPINE - slide ids,
# order, page types, titles - so at step 4 it hashed the SCAFFOLD that
# `deck init` produced, and the first real title the agent wrote invalidated
# the approval the PO had just given. On every single deck.
#
# The existing approval tests all approved a storyboard that was already
# written, which is the one order in which the defect does not appear.

WF_ROOT="$ROOT/workflow"
WF_DECKS="$WF_ROOT/決裁フロー"
WF_STATE="$WF_ROOT/state"
mkdir -p "$WF_DECKS" "$WF_STATE"

wf() {
  env -u TMUX \
    DECK_AGENT="$ROOT/bin/contract-agent" \
    DECK_DECKS_ROOT="$WF_DECKS" \
    DECK_STATE_ROOT="$WF_STATE" \
    CONTRACT_LOG="$CONTRACT_LOG" \
    MARKER_PROBE="${MARKER_PROBE:-}" \
    "$DECK" "$@" 2>&1
}

: > "$CONTRACT_LOG"
wf "承認フローのテスト" > /dev/null 2>&1
WF_RUN="$(find "$WF_STATE/runs" -mindepth 2 -maxdepth 2 -type d | head -n 1)"
WF_ID="$(basename "$WF_RUN")"
WF_DECK="$(grep '^Deck workspace:' "$WF_RUN/run-info.txt" | sed 's/^Deck workspace: *//')"
check_dir "the deck was scaffolded" "$WF_DECK"

phase_of() {
  ( cd "$WF_DECK" && env -u TMUX DECK_STATE_ROOT="$WF_STATE" "$DECK" gate status --json 2>/dev/null ) |
    "${DECK_NODE:-node}" -e '
let s = ""; process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s.slice(s.indexOf("{")));
    const a = j.approvals.agenda;
    process.stdout.write(`${j.phase} subject=${a.subject} approved=${a.approved} matches=${a.matches}`);
  } catch (e) { process.stdout.write(`unreadable ${e.message}`); }
});'
}

# ---- STEP 2 and 3: the source and the ledger, as the agent writes them.
mkdir -p "$WF_DECK/sources"
cat > "$WF_DECK/sources/mtg.txt" <<'SRC'
# 第3回定例
日時: 2026年10月7日
決定: 宿泊パッケージの価格は 18,000円 で確定とする。
未決: 送客チャネルをOTA中心にするか自社サイト中心にするかは次回までに決める。
数値: 9月の予約件数は 412件 だった。
SRC
# A real block-children response chain, because the source gate derives the
# block count and the pagination record from these bytes.
cat > "$WF_DECK/sources/mtg.json" <<'RAW'
[{"object":"list","has_more":false,"next_cursor":null,"results":[
 {"object":"block","id":"b1","type":"heading_1","has_children":false,
  "heading_1":{"rich_text":[{"plain_text":"第3回定例"}]}},
 {"object":"block","id":"b2","type":"paragraph","has_children":false,
  "paragraph":{"rich_text":[{"plain_text":"決定: 宿泊パッケージの価格は 18,000円 で確定とする。"}]}},
 {"object":"block","id":"b3","type":"paragraph","has_children":false,
  "paragraph":{"rich_text":[{"plain_text":"未決: 送客チャネルをOTA中心にするか自社サイト中心にするかは次回までに決める。"}]}},
 {"object":"block","id":"b4","type":"paragraph","has_children":false,
  "paragraph":{"rich_text":[{"plain_text":"数値: 9月の予約件数は 412件 だった。"}]}}
]}]
RAW
"$WF_RUN/record-source" mtg notion 'https://www.notion.so/mtg' sources/mtg.txt yes sources/mtg.json > /dev/null 2>&1
check_eq "the source gate passes on real retrieval evidence" "0" \
  "$("$WF_RUN/deck-gate" source > /dev/null 2>&1; echo $?)"

cat > "$WF_DECK/ledger.json" <<'LEDGER'
{
  "schema": "deck.ledger/1",
  "entries": [
    { "id": "d-01", "kind": "decision", "source_id": "mtg", "status": "resolved",
      "quote": "決定: 宿泊パッケージの価格は 18,000円 で確定とする。" },
    { "id": "d-02", "kind": "decision", "source_id": "mtg", "status": "unresolved",
      "quote": "未決: 送客チャネルをOTA中心にするか自社サイト中心にするかは次回までに決める。" },
    { "id": "n-01", "kind": "number", "source_id": "mtg",
      "quote": "数値: 9月の予約件数は 412件 だった。",
      "value": "412", "unit": "件", "period": "2026年9月" }
  ]
}
LEDGER
check_eq "the ledger gate passes" "0" "$("$WF_RUN/deck-gate" ledger > /dev/null 2>&1; echo $?)"

# ---- STEP 4: the agenda, and the approval. THE STORYBOARD IS STILL THE
# SCAFFOLD at this point - that is the whole point of this test.
cat > "$WF_DECK/agenda.json" <<'AGENDA'
{
  "schema": "deck.agenda/1",
  "meeting": { "name": "第4回定例", "when": "来週火曜",
               "purpose": "送客チャネルの方針を決める", "audience": "経営会議" },
  "items": [
    { "id": "i-01", "heading": "送客チャネルの方針", "wants": "decision",
      "why": "前回からの持ち越しで、ここが決まらないと見積もりも動かせない",
      "ledger_refs": ["d-02"] }
  ],
  "excluded": [
    { "ledger_refs": ["n-01"], "reason": "9月実績は確定済みなので報告のみで足りる" }
  ]
}
AGENDA
check_eq "the agenda gate passes" "0" "$("$WF_RUN/deck-gate" agenda > /dev/null 2>&1; echo $?)"
SCAFFOLD_TITLE="$(grep -c 'ここにタイトルを書く' "$WF_DECK/storyboard.yaml")"
check_ne "the storyboard is still the untouched scaffold" "0" "$SCAFFOLD_TITLE"

APPROVE_OUT="$("$WF_RUN/deck-gate" approve agenda 2>&1)"
check_eq "approving the agenda before the storyboard exists SUCCEEDS" "0" "$?"
check_contains "and records the AGENDA ARTIFACT, not the storyboard spine" "$APPROVE_OUT" "subject:     agenda-artifact"
check_contains "and counts the exclusions the PO agreed to" "$APPROVE_OUT" "excluded:    1"
check_contains "and reports the prerequisite gates it checked" "$APPROVE_OUT" "gate ok "
check_contains "the phase is agenda-approved" "$(phase_of)" "agenda-approved"

# ---- STEP 5: the agent writes the real storyboard. THIS IS THE REGRESSION.
cat > "$WF_DECK/storyboard.yaml" <<'SB'
schema: deck.storyboard/1
title: "送客チャネルの方針を決める"
slides:
  - id: cover
    page_type: cover
    purpose: "この資料が何を決める場のためのものかを示す"
    section_label: "次回定例"
    title: "送客チャネルの方針を決める"
    subtitle: null
    speaker_notes: null
    source_refs: []
  - id: ask
    page_type: statement
    purpose: "今日決めてほしいことを一文で置く"
    section_label: "お願い"
    title: "本日決めたいこと"
    subtitle: null
    body:
      - kind: statement
        text: "未決: 送客チャネルをOTA中心にするか自社サイト中心にするかは次回までに決める。"
    speaker_notes: null
    source_refs: []
SB
check_contains "WRITING THE STORYBOARD DOES NOT INVALIDATE THE AGENDA APPROVAL" "$(phase_of)" "matches=true"
check_contains "and the phase is still agenda-approved" "$(phase_of)" "agenda-approved"
check_eq "validate passes on the written storyboard" "0" "$("$WF_RUN/deck-gate" validate > /dev/null 2>&1; echo $?)"
check_eq "and so does fidelity" "0" "$("$WF_RUN/deck-gate" fidelity > /dev/null 2>&1; echo $?)"

# EDITING THE AGENDA, by contrast, must invalidate it: the PO agreed to those
# items, those reasons and those omissions.
cp "$WF_DECK/agenda.json" "$ROOT/agenda-approved.json"
"${DECK_NODE:-node}" -e '
const fs = require("node:fs");
const f = process.argv[1];
const a = JSON.parse(fs.readFileSync(f, "utf8"));
a.excluded = [];
fs.writeFileSync(f, JSON.stringify(a, null, 2));' "$WF_DECK/agenda.json"
check_contains "DROPPING AN EXCLUSION invalidates the approval" "$(phase_of)" "matches=false"
cp "$ROOT/agenda-approved.json" "$WF_DECK/agenda.json"
check_contains "and restoring it makes the approval current again" "$(phase_of)" "matches=true"

# ---- RESUME DURING COPY REVIEW. The PO walks away while reading the copy
# sheet; the agent is waiting on them. Everything has to come back.
"$WF_RUN/deck-gate" copy > /dev/null 2>&1
check_file "the copy sheet exists for the PO to read" "$WF_DECK/out/copy-sheet.md"
env -u TMUX "$WF_RUN/await-po" mark '原稿の確認' > /dev/null
check_file "and the run is marked as waiting on them" "$WF_RUN/awaiting-po.env"

: > "$CONTRACT_LOG"
MARKER_PROBE="$WF_RUN/awaiting-po.env"
RESUME_WF="$(wf resume "$WF_ID" 2>&1)"
check_eq "the run resumes" "0" "$?"
MARKER_PROBE=""
check_contains "it resumes at the phase the DECK is in" "$RESUME_WF" "Phase: agenda-approved"
check_contains "and continues the same conversation" "$(cat "$CONTRACT_LOG")" "SESSION_MODE=resume"
# THE MARKER SURVIVED INTO THE RESUMED SESSION. A resume does not answer the
# question the PO was asked, so the badge has to still be up when the agent
# starts - its first action is `await-po clear`, and only then does it look at
# whether they actually replied. (The launcher clears it after the agent
# EXITS, which is why this is observed from inside the session.)
check_contains "THE AWAITING-PO MARKER SURVIVED into the resumed session" \
  "$(cat "$CONTRACT_LOG")" "MARKER_AT_LAUNCH=present"
check_contains "the agenda approval survived the resume" "$(phase_of)" "matches=true"
check_file "and so did the copy sheet" "$WF_DECK/out/copy-sheet.md"

# ---- STEP 5 continued: content approval, and its prerequisites.
CONTENT_OUT="$("$WF_RUN/deck-gate" approve content 2>&1)"
check_eq "approving content succeeds once the words are written" "0" "$?"
check_contains "and it is recorded against the storyboard content" "$CONTENT_OUT" "subject:     storyboard-content"
check_contains "with fidelity among the gates it checked" "$CONTENT_OUT" "fidelity"
check_contains "the phase is content-approved" "$(phase_of)" "content-approved"

# A FAILING GATE BLOCKS AN APPROVAL. An approval recorded over a failing gate
# is one the PO believes means the checks passed.
cp "$WF_DECK/ledger.json" "$ROOT/ledger-good.json"
"${DECK_NODE:-node}" -e '
const fs = require("node:fs");
const f = process.argv[1];
const l = JSON.parse(fs.readFileSync(f, "utf8"));
l.entries[0].quote = "でっちあげた決定事項";
fs.writeFileSync(f, JSON.stringify(l, null, 2));' "$WF_DECK/ledger.json"
BLOCKED="$("$WF_RUN/deck-gate" approve agenda 2>&1)"
check_ne "an approval over a FAILING ledger gate is refused" "0" "$?"
check_contains "and it names the gate" "$BLOCKED" "ledger"
check_contains "and quotes the finding" "$BLOCKED" "appears in NO source text"
check_contains "and explains why that matters" "$BLOCKED" "believes means the checks passed"
FORCED="$("$WF_RUN/deck-gate" approve agenda --force 2>&1)"
check_eq "--force records it for a PO who accepts it knowingly" "0" "$?"
check_contains "and says plainly that it was forced" "$FORCED" "FAILING gate"
check_file "and the approval history keeps every one of them" "$WF_DECK/.deck/approvals/history.jsonl"
HISTORY_LINES="$(wc -l < "$WF_DECK/.deck/approvals/history.jsonl" | tr -d ' ')"
if [[ "$HISTORY_LINES" -ge 3 ]]; then
  ok "the history has every approval, not just the current one ($HISTORY_LINES)"
else
  no "the history has every approval, not just the current one" "only $HISTORY_LINES"
fi
cp "$ROOT/ledger-good.json" "$WF_DECK/ledger.json"

echo ""
echo "no agent, no network, no Notion request from any of it"

check_eq "the launcher section made no curl or wget call" "" "$(cat "$NET_STUB_LOG")"
check_absent "nothing in the launcher section killed a tmux window" "$(cat "$TMUX_STUB_LOG")" "kill-window"
check_absent "nothing in the launcher section killed a tmux session" "$(cat "$TMUX_STUB_LOG")" "kill-session"
check_absent "nothing in the launcher section killed a tmux pane" "$(cat "$TMUX_STUB_LOG")" "kill-pane"
check_absent "nothing in the launcher section killed a tmux server" "$(cat "$TMUX_STUB_LOG")" "kill-server"
# The claude and codex stubs from the top of this file: the launcher only ever
# ran the agent through DECK_AGENT, so these stayed untouched.
check_eq "the real agent binaries were never invoked" "" "$(cat "$AGENT_STUB_LOG")"

# The pinned font is a LOCAL file. A theme that referenced a remote font would
# make every render depend on a CDN, so the stylesheet is checked directly.
THEME_DIR="$(dirname "$DECK")/_deck/themes/watercolor"
check_file "the theme pins its font as a local file" "$THEME_DIR/fonts/NotoSansJP-Variable.ttf"
check_file "the font's licence is bundled with it" "$THEME_DIR/fonts/OFL.txt"
check_absent "the theme's CSS fetches nothing over http" "$(cat "$THEME_DIR/deck.css")" "http"
check_contains "theme.yaml records the font's sha256" "$(cat "$THEME_DIR/theme.yaml")" "sha256:"
check_contains "theme.yaml records the font's licence" "$(cat "$THEME_DIR/theme.yaml")" "SIL Open Font License"

# ---------------------------------------------------------------------------
# THE FIELD REPORT'S CHANGES, as the agent and the PO actually meet them.
#
# A real deck shipped with fourteen of fifteen illustration slots empty, lint
# passing, and `render --release` producing a finished PDF with no pictures in
# it. Everything below is about that being impossible now, and about the agent
# being TOLD so in the terms it works in.
# ---------------------------------------------------------------------------
echo ""
echo "--- the field report: slots, the draft render and the schema printer ---"

# RE-DERIVED, not inherited. RUN_DIR is reassigned twice further up - once to
# a path that is then deleted - so reusing it here made every check below
# vanish into a skipped `if` and the suite still reported a clean pass. A
# guard that silently drops its own checks is the failure this whole round of
# work is about, so this one resolves the run again and FAILS when it cannot.
FR_RUN="$(find "$LAUNCH_STATE/runs" -mindepth 2 -maxdepth 2 -type d | head -n 1)"
check_dir "the generated run used for the field-report checks exists" "$FR_RUN"
check_file "and it holds a generated build-cycle" "$FR_RUN/build-cycle"
if [[ -f "$FR_RUN/build-cycle" ]]; then
  FR_CYCLE="$(cat "$FR_RUN/build-cycle")"
  check_contains "build-cycle reports how many slots are empty" "$FR_CYCLE" "slots_empty="
  check_contains "and how many there are in total" "$FR_CYCLE" "slots_total="
  check_contains "and which are the PO's own to supply" "$FR_CYCLE" "slots_awaiting_your_own="
  check_contains "it separates repairable findings from missing pictures" "$FR_CYCLE" "blocking_layout="
  check_contains "naming the slot findings as their own count" "$FR_CYCLE" "blocking_slots"
  check_contains "the count is read from status, not recounted" "$FR_CYCLE" "j.slot_fill"
  check_contains "and an empty-slot-only round does not loop again" "$FR_CYCLE" "The LAYOUT is clean"

  FR_PROMPT="$(cat "$FR_RUN/agent-prompt.md")"
  check_contains "the agent is told to render a draft BEFORE asking for approval" \
    "$FR_PROMPT" "RENDER A DRAFT BEFORE YOU ASK FOR APPROVAL"
  check_contains "and to show the PNGs alongside the copy sheet" "$FR_PROMPT" "out/png/"
  check_contains "with the PO's own words about why" "$FR_PROMPT" "中身見れないほどに見た目がくそすぎて判断できない"
  check_contains "the five errors no rule caught are named in the prompt" "$FR_PROMPT" "説得し"
  check_contains "and the agent is told to walk the deck page by page" "$FR_PROMPT" "ページごとに"
  check_contains "slots_empty is documented in the build-cycle output" "$FR_PROMPT" "slots_empty="
  check_contains "with the warning not to work around it" "$FR_PROMPT" "not a warning you work around"
  check_contains "blocking_layout is documented too" "$FR_PROMPT" "blocking_layout="
  check_contains "the agent is told it can ASK for a file's shape" "$FR_PROMPT" "schema ledger --example"
  # THE DESIGN REVIEW: the agent must declare the illustration slots, because
  # deck generates nothing and an undeclared slot never reaches the brief.
  check_contains "the agent is told to declare the illustration slots" "$FR_PROMPT" "DECLARE THE ILLUSTRATION SLOTS"
  # SLOT IDENTITY: an id names a POSITION, so it repeats on every slide of that
  # page type. A deck used to be capped at one standard-3col slide with art.
  check_contains "the agent is told slot ids repeat across slides" "$FR_PROMPT" "THE SAME IDS REPEAT ON EVERY SLIDE"
  check_contains "and warned off inventing per-slide ids" "$FR_PROMPT" "decided-col-1-art"
  check_contains "it is shown the qualified import command" "$FR_PROMPT" "assets import decided:col-1-art"
  check_contains "and the slide-qualified brief filename" "$FR_PROMPT" "04-decided-col-1-art.png"
  # CAPACITY: the measured limits reach the author before they write, not only
  # when validate refuses them.
  check_contains "the agent is told how much one page holds" "$FR_PROMPT" "HOW MUCH ONE PAGE HOLDS"
  check_contains "with the measured agenda limit" "$FR_PROMPT" "agenda      7 items"
  check_contains "and that a footer banner costs a row" "$FR_PROMPT" "6 with a footer banner"
  check_contains "and the design kit's order for what to try" "$FR_PROMPT" "split across two slides"
  check_contains "and the four things it may never do" "$FR_PROMPT" "読めない大きさへの縮小"
  check_contains "it is told length is NOT capped, and why" "$FR_PROMPT" "LENGTH IS NOT CAPPED"
  check_contains "and that lint names the characters that did not fit" "$FR_PROMPT" "names the characters that did"
  check_contains "with the band slots for the diagram page types" "$FR_PROMPT" "process-art"
  check_contains "and that a hub page does not take one" "$FR_PROMPT" "LAYERS form only"
  check_contains "and that a statement page is not filled with pictures" "$FR_PROMPT" "不要なイラストで埋めない"
  check_contains "and to write a real brief in each" "$FR_PROMPT" "文字は一切入れない"
  # The garbled transcription that reached a real page.
  check_contains "the prompt names the garbled transcription that shipped" "$FR_PROMPT" "やらばグダメ"
  check_contains "and tells the agent to read the copy sheet as a reader" "$FR_PROMPT" "READ IT YOURSELF FIRST"
  check_contains "rather than guessing at key names" "$FR_PROMPT" "additionalProperties: false"
fi

# `deck gate schema` - the thing the PO binary-searched ten candidate keys for.
SCHEMA_LIST="$("$DECK" gate schema 2>&1)"
check_contains "deck gate schema lists the documents" "$SCHEMA_LIST" "ledger.json"
check_contains "and the storyboard" "$SCHEMA_LIST" "storyboard.yaml"
check_contains "and the source manifest" "$SCHEMA_LIST" "sources/manifest.json"

SCHEMA_LEDGER="$("$DECK" gate schema ledger --example 2>&1)"
check_contains "a worked ledger example names source_id" "$SCHEMA_LEDGER" "source_id"
check_contains "and note, the two keys the PO had to search for" "$SCHEMA_LEDGER" "note"
check_absent "and does not print the whole schema when asked for the example" "$SCHEMA_LEDGER" "additionalProperties"

SCHEMA_AGENDA="$("$DECK" gate schema agenda --example 2>&1)"
check_contains "a worked agenda example names heading" "$SCHEMA_AGENDA" "heading"
check_contains "and why" "$SCHEMA_AGENDA" "why"
check_contains "and reason, which excluded uses instead of why" "$SCHEMA_AGENDA" "reason"

"$DECK" gate schema nonsense >/dev/null 2>&1
check_eq "an unknown document name is a USAGE error" "2" "$?"

"$DECK" gate schema >/dev/null 2>&1
check_eq "and listing them is not an error" "0" "$?"

# The synthetic fixture: present, complete, and documented.
FIXTURE_DIR="$(dirname "$DECK")/_deck/test/fixtures/full-deck"
check_file "the fixture deck has a storyboard" "$FIXTURE_DIR/storyboard.yaml"
check_file "and a request file" "$FIXTURE_DIR/deck.yaml"
check_file "and a build script that fills every slot" "$FIXTURE_DIR/build.mjs"
check_file "and a README explaining what it is for" "$(dirname "$FIXTURE_DIR")/README.md"
FIXTURE_SB="$(cat "$FIXTURE_DIR/storyboard.yaml")"
for slot in cover-art agenda-art divider-art col-1-art col-2-art col-3-art; do
  check_contains "the fixture fills the $slot slot" "$FIXTURE_SB" "id: $slot"
done
for pt in cover agenda section-divider standard-3col table statement comparison process ecosystem timeline; do
  check_contains "the fixture covers the $pt page type" "$FIXTURE_SB" "page_type: $pt"
done
check_absent "and the fixture contains no real client name" "$FIXTURE_SB" "野沢"

# The theme no longer ships coordinates that are guaranteed to collide.
FR_THEME="$(cat "$(dirname "$DECK")/_deck/themes/watercolor/theme.yaml")"
# The DECLARATION, not the prose: the comment above those slots quotes the old
# coordinate to explain what went wrong, so a plain text search finds it.
FR_SLOTS="$(grep -E '^      col-[0-9]-art:' "$(dirname "$DECK")/_deck/themes/watercolor/theme.yaml")"
check_absent "the column art slots no longer carry the colliding top: 277" "$FR_SLOTS" "top:"
check_absent "nor any other absolute coordinate" "$FR_SLOTS" "left:"
check_contains "they declare that the card lays them out instead" "$FR_SLOTS" "flow: card-art"
check_contains "the theme declares measured occupancy thresholds" "$FR_THEME" "occupancy:"
check_contains "and which page types are exempt from them" "$FR_THEME" "exempt: [statement, cover, section-divider]"

echo ""
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
