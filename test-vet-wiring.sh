#!/usr/bin/env bash
# Tests for the wiring vet generates for a run: the reviewer task files, the
# per-launch tmux wait events in run-step, and the base-branch movement check.
#
#   ./test-vet-wiring.sh
#
# Everything runs against a TEMP git repository, a TEMP VET_STATE_ROOT and a
# STUBBED tmux placed first on PATH, driven by `--dry-run` with a fixture
# pr.json. No agent is ever launched and no pane is ever split -- two of the
# assertions below exist precisely to prove that.
#
# This is separate from test-vet-autoclose.sh on purpose: that suite is about
# the auto-close lifecycle and the RUN_STATUS precedence vet-cockpit depends on,
# while this one is about the artifacts a launch generates.
#
# The base-movement cases are function-level. They cannot come from --dry-run:
# vet exits before the Manager launch, and the check runs after the Manager
# EXITS. So they source the real base_ref_oid / report_base_movement bodies out
# of ./vet at run time (see extract_fn) and drive them against a real local
# remote, which keeps them honest without a live GitHub PR.

set -uo pipefail

VET="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vet"
[[ -f "$VET" ]] || { echo "cannot find vet next to this script" >&2; exit 1; }

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

# Pull one top-level function body verbatim out of the real vet script.
extract_fn() {
  awk -v fn="$1" '
    $0 ~ "^"fn"\\(\\) \\{" { inside = 1 }
    inside { print }
    inside && $0 == "}" { exit }
  ' "$VET"
}

# This script runs without `set -e`, so mktemp is checked explicitly. An empty
# ROOT would turn every "$ROOT/bin" below into an absolute /bin, and the EXIT
# trap into an `rm -rf` of something that is not ours.
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vet-wiring-test.XXXXXX")" || exit 1
[[ -n "$ROOT" && -d "$ROOT" ]] || {
  echo "cannot create a temporary directory; refusing to run" >&2
  exit 1
}
trap 'rm -rf "${ROOT:?}"' EXIT

mkdir -p "$ROOT/bin"

# ---------------------------------------------------------------- tmux stub
#
# Logs every invocation and answers nothing. A dry run must not call tmux at
# all; run-step calls only send-keys, which needs no reply.
cat > "$ROOT/bin/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_STUB_LOG"
exit 0
STUB
chmod +x "$ROOT/bin/tmux"

# ------------------------------------------------------- agent binary stubs
#
# If vet ever launches a reviewer or the Manager during a dry run, these record
# it and the assertion below fails. They deliberately do NOT behave like the
# real CLIs: nothing in a dry run should reach them.
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
export VET_STATE_ROOT="$ROOT/state"
export VET_WORKTREE_ROOT="$ROOT/worktrees"

# --no-verify / hooksPath: the PO's global hooks must not run in a test repo.
git_quiet() {
  git -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"
}

echo "vet wiring tests"
echo ""

# ============================================================ dry-run launch
echo "dry-run launch (task files, state.env, nothing launched)"

REPO="$ROOT/repo"
mkdir -p "$REPO"
git_quiet -C "$REPO" init -q .
git_quiet -C "$REPO" config user.email vet-test@example.com
git_quiet -C "$REPO" config user.name "vet test"
printf 'hello\n' > "$REPO/a.txt"
git_quiet -C "$REPO" add a.txt
git_quiet -C "$REPO" commit -q -m "first commit"
HEAD_OID="$(git_quiet -C "$REPO" rev-parse HEAD)"

FIXTURES="$ROOT/fixtures"
mkdir -p "$FIXTURES"
cat > "$FIXTURES/pr.json" <<JSON
{"number":42,"title":"a fixture PR","body":"fixture body",
 "author":{"login":"someone"},"state":"OPEN","isDraft":false,
 "url":"https://github.com/local/fixture/pull/42",
 "baseRefName":"master","headRefName":"feat/x","headRefOid":"$HEAD_OID",
 "isCrossRepository":false,"changedFiles":1,"additions":1,"deletions":0,
 "files":[{"path":"a.txt","additions":1,"deletions":0}],
 "labels":[],"commits":[]}
JSON
export VET_FIXTURE_DIR="$FIXTURES"

DRY_OUT="$ROOT/dry-run.out"
(cd "$REPO" && VET_DRY_RUN=1 "$VET" --dry-run 42) > "$DRY_OUT" 2>&1
DRY_RC=$?
check_eq "the dry run succeeds" "0" "$DRY_RC"

RUN_DIR="$(find "$VET_STATE_ROOT/runs" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[[ -n "$RUN_DIR" ]] || { echo "no run directory was created; see $DRY_OUT" >&2; cat "$DRY_OUT" >&2; exit 1; }

# -- nothing was launched ---------------------------------------------------
check_eq "no agent binary is invoked by a dry run" "" "$(cat "$AGENT_STUB_LOG")"
check_eq "tmux is never called by a dry run" "" "$(cat "$TMUX_STUB_LOG")"
check_absent "no pane is split" "$(cat "$TMUX_STUB_LOG")" "split-window"
check_absent "no window is created" "$(cat "$TMUX_STUB_LOG")" "new-window"

# -- the output contract comes FIRST ----------------------------------------
#
# The whole point of the change: a reviewer that finds nothing must still answer
# with the schema object, and stating that AFTER the task text did not work.
CONTRACT_HEADING="## Output contract - read this before anything else"
for reviewer in a b; do
  TASK_FILE="$RUN_DIR/reviewer-$reviewer-task.md"
  check_file "reviewer $reviewer task file is generated" "$TASK_FILE"
  check_eq "reviewer $reviewer task BEGINS with the output contract" \
    "$CONTRACT_HEADING" "$(head -n 1 "$TASK_FILE")"

  TASK_BODY="$(cat "$TASK_FILE")"
  check_contains "reviewer $reviewer contract demands JSON only" \
    "$TASK_BODY" "Return ONLY the JSON object required by your output schema"
  check_contains "reviewer $reviewer contract rules out prose and fences" \
    "$TASK_BODY" "No prose, no"
  check_contains "reviewer $reviewer contract spells out the zero-findings case" \
    "$TASK_BODY" '"findings": []'
  check_contains "reviewer $reviewer contract says a clean PR is not a sentence" \
    "$TASK_BODY" "A clean PR is NOT a sentence"
  check_contains "reviewer $reviewer contract forbids null collections" \
    "$TASK_BODY" "Empty collections are [], never null"
  check_contains "reviewer $reviewer contract defers to the schema file" \
    "$TASK_BODY" "authoritative"

  # The contract must precede the reviewer identity, not merely be present.
  CONTRACT_LINE="$(grep -n -F -m1 "$CONTRACT_HEADING" "$TASK_FILE" | cut -d: -f1)"
  IDENTITY_LINE="$(grep -n -m1 '^You are Reviewer' "$TASK_FILE" | cut -d: -f1)"
  if [[ -n "$CONTRACT_LINE" && -n "$IDENTITY_LINE" && "$CONTRACT_LINE" -lt "$IDENTITY_LINE" ]]; then
    ok "reviewer $reviewer contract precedes the reviewer identity"
  else
    no "reviewer $reviewer contract precedes the reviewer identity" \
      "contract at [$CONTRACT_LINE], identity at [$IDENTITY_LINE]"
  fi

  # The task is passed through argv, so it must stay well inside macOS ARG_MAX.
  TASK_BYTES="$(wc -c < "$TASK_FILE" | tr -d ' ')"
  if [[ "$TASK_BYTES" -lt 262144 ]]; then
    ok "reviewer $reviewer task stays well under ARG_MAX ($TASK_BYTES bytes)"
  else
    no "reviewer $reviewer task stays well under ARG_MAX" "$TASK_BYTES bytes"
  fi
done

# The schema information must not have been lost from the tail of the task.
check_contains "the ## Output section still points at the schema" \
  "$(cat "$RUN_DIR/reviewer-a-task.md")" "required by your output schema"

# -- state.env is still the same contract -----------------------------------
check_file "state.env is written" "$RUN_DIR/state.env"
# Parse it the way vet-cockpit does: %q-quoted, one KEY=value per line.
check_eq "state.env is still %q-decodable" "0" \
  "$(bash -n "$RUN_DIR/state.env" >/dev/null 2>&1; echo $?)"
STATE_BODY="$(cat "$RUN_DIR/state.env")"
check_contains "RUN_STATUS is dry-run" "$STATE_BODY" "RUN_STATUS=dry-run"
check_contains "BASE_START_OID is present as a new field" "$STATE_BODY" "BASE_START_OID="
check_contains "BASE_END_OID is present as a new field" "$STATE_BODY" "BASE_END_OID="

# Every field vet-cockpit reads must survive. This list is the contract.
for key in RUN_STATUS WINDOW_ID PR_NUMBER PR_URL PR_STATE PR_TITLE REPO_SPEC \
           REPO_ROOT STARTED_AT CONTEXT_TRUNCATED CHECKLIST_COUNT; do
  check_contains "cockpit field $key is still written" "$STATE_BODY" "$key="
done

# The other files the cockpit looks for.
check_file "title.txt is still written" "$RUN_DIR/title.txt"
check_file "run-info.txt is still written" "$RUN_DIR/run-info.txt"

echo ""

# ============================================================ run-step events
echo "run-step (one launch, one wait channel)"

RUN_STEP="$RUN_DIR/run-step"
check_file "run-step is generated" "$RUN_STEP"
check_eq "the generated run-step is valid bash" "0" \
  "$(bash -n "$RUN_STEP" >/dev/null 2>&1; echo $?)"

RUN_STEP_BODY="$(cat "$RUN_STEP")"
check_contains "run-step mints a per-launch event" "$RUN_STEP_BODY" "mint_event"
check_contains "run-step resolves the event for a wait" "$RUN_STEP_BODY" "event_for"
check_contains "run-step records A's event in a file" "$RUN_STEP_BODY" "reviewer-a-event.txt"
check_contains "run-step records B's event in a file" "$RUN_STEP_BODY" "reviewer-b-event.txt"
check_contains "the old static name survives as the fallback" \
  "$RUN_STEP_BODY" "EVENT_A=vet-"

: > "$TMUX_STUB_LOG"

# Two launches of the SAME step must not share a wait channel. That reuse is
# what produced the stale latch the wait loop has to defend against.
printf 'stale\n' > "$RUN_DIR/reviewer-a-status.txt"
"$RUN_STEP" reviewer-a > /dev/null 2>&1
EVENT_A1="$(cat "$RUN_DIR/reviewer-a-event.txt" 2>/dev/null)"
STATUS_AFTER_LAUNCH="$(cat "$RUN_DIR/reviewer-a-status.txt" 2>/dev/null || printf 'ABSENT')"

"$RUN_STEP" reviewer-a > /dev/null 2>&1
EVENT_A2="$(cat "$RUN_DIR/reviewer-a-event.txt" 2>/dev/null)"

check_file "a launch writes reviewer-a-event.txt" "$RUN_DIR/reviewer-a-event.txt"
check_ne "two launches of reviewer-a mint DIFFERENT events" "$EVENT_A1" "$EVENT_A2"
check_contains "the minted event extends the static base" \
  "$EVENT_A1" "-reviewer-a-"
check_eq "the launcher clears the reviewer status file" "ABSENT" "$STATUS_AFTER_LAUNCH"

# The event actually handed to the reviewer is the fresh one, not the base.
SENT="$(grep -F 'run-reviewer-a' "$TMUX_STUB_LOG" | tail -n 1)"
check_contains "the fresh event is what run-reviewer-a is given" "$SENT" "$EVENT_A2"

# reviewer-a-resume is a launch too, so it re-arms as well.
"$RUN_STEP" reviewer-a-resume > /dev/null 2>&1
EVENT_A3="$(cat "$RUN_DIR/reviewer-a-event.txt" 2>/dev/null)"
check_ne "reviewer-a-resume mints its own event too" "$EVENT_A2" "$EVENT_A3"

# Reviewer B behaves the same way.
"$RUN_STEP" reviewer-b > /dev/null 2>&1
EVENT_B1="$(cat "$RUN_DIR/reviewer-b-event.txt" 2>/dev/null)"
"$RUN_STEP" reviewer-b > /dev/null 2>&1
EVENT_B2="$(cat "$RUN_DIR/reviewer-b-event.txt" 2>/dev/null)"
check_ne "two launches of reviewer-b mint DIFFERENT events" "$EVENT_B1" "$EVENT_B2"

# -- the wait side reads that file ------------------------------------------
#
# run-wait would block, so it is replaced by a stub that reports its argv. The
# real one is restored afterwards.
cp "$RUN_DIR/run-wait" "$ROOT/run-wait.real"
# The $1 belongs to the generated stub, not to this script.
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nprintf "EVENT=%%s\\n" "$1"\n' > "$RUN_DIR/run-wait"
chmod +x "$RUN_DIR/run-wait"

check_eq "wait-a waits on the event the last launch recorded" \
  "EVENT=$EVENT_A3" "$("$RUN_STEP" wait-a 2>&1)"
check_eq "wait-b waits on the event the last launch recorded" \
  "EVENT=$EVENT_B2" "$("$RUN_STEP" wait-b 2>&1)"

# FALLBACK: an old retained run has no event file at all, and must behave
# exactly as it did before this change.
RUN_ID="$(basename "$RUN_DIR")"
rm -f "$RUN_DIR/reviewer-a-event.txt" "$RUN_DIR/reviewer-b-event.txt"
check_eq "wait-a falls back to the static name when the file is absent" \
  "EVENT=vet-$RUN_ID-reviewer-a" "$("$RUN_STEP" wait-a 2>&1)"
check_eq "wait-b falls back to the static name when the file is absent" \
  "EVENT=vet-$RUN_ID-reviewer-b" "$("$RUN_STEP" wait-b 2>&1)"

# A truncated or empty event file is the same case as an absent one.
: > "$RUN_DIR/reviewer-a-event.txt"
check_eq "an empty event file also falls back" \
  "EVENT=vet-$RUN_ID-reviewer-a" "$("$RUN_STEP" wait-a 2>&1)"

cp "$ROOT/run-wait.real" "$RUN_DIR/run-wait"

echo ""

# ============================================================ base movement
echo "base movement (function level)"

# vet exits a dry run before the Manager launch, and the base check runs after
# the Manager EXITS, so this drives the real functions directly against a real
# local remote instead.
eval "$(extract_fn base_tracking_ref)"
eval "$(extract_fn base_ref_oid)"
eval "$(extract_fn clear_base_tracking_refs)"
eval "$(extract_fn report_base_movement)"

REMOTE="$ROOT/remote.git"
git_quiet init -q --bare "$REMOTE"

CLONE="$ROOT/clone"
git_quiet clone -q "$REMOTE" "$CLONE" 2>/dev/null
git_quiet -C "$CLONE" config user.email vet-test@example.com
git_quiet -C "$CLONE" config user.name "vet test"
printf 'base\n' > "$CLONE/base.txt"
git_quiet -C "$CLONE" add base.txt
git_quiet -C "$CLONE" commit -q -m "base commit"
BASE_BRANCH="$(git_quiet -C "$CLONE" rev-parse --abbrev-ref HEAD)"
git_quiet -C "$CLONE" push -q origin "$BASE_BRANCH"

FAKE_RUN_ID="20260101-000000-1"
START_REF="$(base_tracking_ref "$FAKE_RUN_ID" base-start)"
END_REF="$(base_tracking_ref "$FAKE_RUN_ID" base-end)"
check_eq "the tracking ref is private to the run" \
  "refs/vet/$FAKE_RUN_ID/base-start" "$START_REF"

# A snapshot of the PO's persistent refs, to prove vet does not move them.
# refs/tags is included because a plain `git fetch` also writes tags that point
# into the fetched history, which is another way into the PO's ref store.
refs_snapshot() {
  git_quiet -C "$1" for-each-ref --format='%(refname) %(objectname)' \
    refs/heads refs/remotes refs/tags 2>/dev/null | sort
}
REFS_BEFORE="$(refs_snapshot "$CLONE")"

START_OID="$(base_ref_oid "$CLONE" origin "$BASE_BRANCH" "$START_REF")"
if [[ -n "$START_OID" ]]; then
  ok "base_ref_oid resolves the base branch through the remote"
else
  no "base_ref_oid resolves the base branch through the remote" "got an empty OID"
fi

# THE SECURITY POINT: a read-only review must not advance the PO's own refs.
# (The clone already has its own refs/remotes/origin/<base>; the property under
# test is that vet does not TOUCH it, not that it is absent.)
check_eq "the PO's refs/heads and refs/remotes are untouched" \
  "$REFS_BEFORE" "$(refs_snapshot "$CLONE")"
# ... and the value really did land in vet's own namespace instead.
check_eq "the base OID lives in vet's private namespace" "$START_OID" \
  "$(git_quiet -C "$CLONE" rev-parse --verify --quiet "$START_REF" 2>/dev/null)"

# -- an unchanged base says nothing -----------------------------------------
MOVE_FILE="$ROOT/base-movement.txt"
END_OID="$(base_ref_oid "$CLONE" origin "$BASE_BRANCH" "$END_REF")"
check_eq "an untouched base reads back identical" "$START_OID" "$END_OID"
OUT="$(report_base_movement "$CLONE" origin "$BASE_BRANCH" "$START_OID" "$END_OID" "$MOVE_FILE" 2>&1)"
check_eq "an unchanged base warns about nothing" "" "$OUT"
check_no_file "an unchanged base writes no base-movement.txt" "$MOVE_FILE"

# -- a base that moved is reported ------------------------------------------
OTHER="$ROOT/other"
git_quiet clone -q "$REMOTE" "$OTHER" 2>/dev/null
git_quiet -C "$OTHER" config user.email someone@example.com
git_quiet -C "$OTHER" config user.name "someone else"
printf 'landed while we were reviewing\n' > "$OTHER/landed.txt"
git_quiet -C "$OTHER" add landed.txt
git_quiet -C "$OTHER" commit -q -m "another PR solving the same issue"
git_quiet -C "$OTHER" push -q origin "$BASE_BRANCH"
# A tag on the base history, so the fetch below has one to drag in if it can.
git_quiet -C "$OTHER" tag v-landed
git_quiet -C "$OTHER" push -q origin v-landed

MOVED_OID="$(base_ref_oid "$CLONE" origin "$BASE_BRANCH" "$END_REF")"
check_ne "the base OID changes once someone else pushes" "$START_OID" "$MOVED_OID"
# The sharpest form of the security property: vet has just fetched a NEWER base
# commit, and the PO's own origin/<base> must STILL point where it did.
check_eq "fetching a moved base does not advance the PO's origin ref" \
  "$REFS_BEFORE" "$(refs_snapshot "$CLONE")"
check_absent "fetching the base drags in no tags" \
  "$(refs_snapshot "$CLONE")" "refs/tags/v-landed"

OUT="$(report_base_movement "$CLONE" origin "$BASE_BRANCH" "$START_OID" "$MOVED_OID" "$MOVE_FILE" 2>&1)"
check_file "a moved base writes base-movement.txt" "$MOVE_FILE"
check_contains "the warning names the file" "$OUT" "$MOVE_FILE"
check_contains "the warning says the base moved" "$OUT" "moved during this review"

MOVE_BODY="$(cat "$MOVE_FILE" 2>/dev/null)"
check_contains "the file records the OID reviewed against" "$MOVE_BODY" "$START_OID"
check_contains "the file records the OID it moved to" "$MOVE_BODY" "$MOVED_OID"
check_contains "the file lists what landed on the base" \
  "$MOVE_BODY" "another PR solving the same issue"

# A moved base is a WARNING. It must not touch the run's recorded status --
# vet-cockpit reads RUN_STATUS as a lifecycle value and has no state for this.
check_absent "base movement never writes a RUN_STATUS" "$MOVE_BODY" "RUN_STATUS"
check_no_file "base movement writes no state.env of its own" "$ROOT/state.env"

# -- THE REPORTED GAP: a failed fetch must not inherit a stale ref -----------
#
# The original version fetched into refs/remotes/origin/<base> and read it back.
# Offline, the fetch failed but that ref STILL RESOLVED -- to whenever it was
# last updated -- so the run recorded a stale OID as if it were current, and a
# later successful reading reported a move that had happened BEFORE the review.
# Set that trap deliberately: a stale refs/remotes ref, and an unreachable
# remote, at the same time.
git_quiet -C "$CLONE" update-ref "refs/remotes/origin/$BASE_BRANCH" "$START_OID"
STALE_PRESENT="$(git_quiet -C "$CLONE" rev-parse --verify --quiet \
  "refs/remotes/origin/$BASE_BRANCH" 2>/dev/null)"
check_eq "a stale remote-tracking ref really is resolvable" "$START_OID" "$STALE_PRESENT"

git_quiet -C "$CLONE" remote set-url origin "$ROOT/does-not-exist.git"
OFFLINE_REF="$(base_tracking_ref "$FAKE_RUN_ID" base-offline)"
OFFLINE_OID="$(base_ref_oid "$CLONE" origin "$BASE_BRANCH" "$OFFLINE_REF" 2>/dev/null)"
RC=$?
check_eq "a failed fetch is not an error" "0" "$RC"
check_eq "a failed fetch yields an EMPTY OID, not the stale one" "" "$OFFLINE_OID"
check_ne "the stale OID was available but was NOT used" "$OFFLINE_OID" "$START_OID"

# And an empty reading must produce no movement warning at all.
rm -f "$MOVE_FILE"
OUT="$(report_base_movement "$CLONE" origin "$BASE_BRANCH" "$START_OID" "$OFFLINE_OID" "$MOVE_FILE" 2>&1)"
check_no_file "an unreadable base raises no false movement alarm" "$MOVE_FILE"
# The needle is the WARNING banner, not the phrase "moved during this review" --
# the explanatory note legitimately contains that phrase in a negated sentence.
check_absent "an unreadable base is never called a move" "$OUT" "WARNING:"
# ... but the PO is told WHY, rather than it being silently swallowed.
check_contains "the PO is told the base could not be compared" \
  "$OUT" "could not compare the base branch"
check_contains "the PO is told what that means" \
  "$OUT" "would NOT have been noticed"

# A second reading through the SAME slot must also not resurrect the first one.
SECOND="$(base_ref_oid "$CLONE" origin "$BASE_BRANCH" "$START_REF" 2>/dev/null)"
check_eq "a failed re-read clears its own slot instead of reusing it" "" "$SECOND"

git_quiet -C "$CLONE" remote set-url origin "$REMOTE"
git_quiet -C "$CLONE" update-ref -d "refs/remotes/origin/$BASE_BRANCH" 2>/dev/null || true

# -- the offline / old-run cases never fail ---------------------------------
rm -f "$MOVE_FILE"
report_base_movement "$CLONE" origin "$BASE_BRANCH" "" "$MOVED_OID" "$MOVE_FILE" >/dev/null 2>&1
check_eq "an unknown start OID is not an error" "0" "$?"
check_no_file "an unknown start OID reports nothing" "$MOVE_FILE"

report_base_movement "$CLONE" origin "$BASE_BRANCH" "$START_OID" "" "$MOVE_FILE" >/dev/null 2>&1
check_eq "an unknown end OID is not an error" "0" "$?"
check_no_file "an unknown end OID reports nothing" "$MOVE_FILE"

# A repository with no such remote: best effort means empty, never a failure.
UNREACHABLE="$(base_ref_oid "$CLONE" no-such-remote "$BASE_BRANCH" "$END_REF" 2>/dev/null)"
RC=$?
check_eq "an unresolvable base is not an error" "0" "$RC"
check_eq "an unresolvable base yields an empty OID" "" "$UNREACHABLE"

MISSING_ARGS="$(base_ref_oid "$CLONE" "" "" "$END_REF" 2>/dev/null)"
RC=$?
check_eq "base_ref_oid with no remote is not an error" "0" "$RC"
check_eq "base_ref_oid with no remote yields nothing" "" "$MISSING_ARGS"

NO_REF="$(base_ref_oid "$CLONE" origin "$BASE_BRANCH" "" 2>/dev/null)"
check_eq "base_ref_oid with no tracking ref yields nothing" "" "$NO_REF"

# -- an attacker-chosen base ref must not escape the refspec -----------------
#
# $BASE_REF comes from `gh pr view`, i.e. from whoever opened the PR. None of
# these may reach git as an option, an extra refspec component, or a glob.
for evil in '-x' '--upload-pack=touch /tmp/vet-pwned' 'a:b' 'a*b' 'a b' 'a..b' \
            'a^b' 'a~b' 'a?b' 'HEAD:refs/heads/hijacked'; do
  EVIL_REF="$(base_tracking_ref "$FAKE_RUN_ID" evil)"
  EVIL_OUT="$(base_ref_oid "$CLONE" origin "$evil" "$EVIL_REF" 2>/dev/null)"
  check_eq "a hostile base ref [$evil] is refused" "" "$EVIL_OUT"
done
check_no_file "no hostile base ref ran a command" "/tmp/vet-pwned"
check_eq "no hostile base ref created a branch" "" \
  "$(git_quiet -C "$CLONE" rev-parse --verify --quiet refs/heads/hijacked 2>/dev/null)"

# -- the private refs are cleaned up -----------------------------------------
#
# Take a fresh reading first: the offline and hostile-ref cases above each
# delete their own slot, so by this point there is deliberately nothing left.
base_ref_oid "$CLONE" origin "$BASE_BRANCH" "$START_REF" >/dev/null 2>&1
base_ref_oid "$CLONE" origin "$BASE_BRANCH" "$END_REF" >/dev/null 2>&1
# The PO's refs as they stand now -- this test removed the stale
# refs/remotes/origin/<base> it planted, so the original baseline no longer
# applies and comparing against it would flag the test's own surgery as vet's.
REFS_BEFORE_CLEAN="$(refs_snapshot "$CLONE")"

BEFORE_CLEAN="$(git_quiet -C "$CLONE" for-each-ref --format='%(refname)' \
  "refs/vet/$FAKE_RUN_ID" 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$BEFORE_CLEAN" -gt 0 ]]; then
  ok "the run left private refs behind to clean ($BEFORE_CLEAN)"
else
  no "the run left private refs behind to clean" "found none to begin with"
fi
clear_base_tracking_refs "$CLONE" "$FAKE_RUN_ID"
check_eq "clear_base_tracking_refs removes the start slot" "" \
  "$(git_quiet -C "$CLONE" rev-parse --verify --quiet "$START_REF" 2>/dev/null)"
check_eq "clear_base_tracking_refs removes the end slot" "" \
  "$(git_quiet -C "$CLONE" rev-parse --verify --quiet "$END_REF" 2>/dev/null)"
clear_base_tracking_refs "$CLONE" "$FAKE_RUN_ID"
check_eq "clearing twice is not an error" "0" "$?"
clear_base_tracking_refs "" ""
check_eq "clearing with no repo is not an error" "0" "$?"
# Cleanup must never touch the PO's own refs.
check_eq "cleanup leaves the PO's refs alone" \
  "$REFS_BEFORE_CLEAN" "$(refs_snapshot "$CLONE")"
check_eq "no vet ref survives the cleanup" "" \
  "$(git_quiet -C "$CLONE" for-each-ref --format='%(refname)' refs/vet 2>/dev/null)"

echo ""

# ====================================== the resumed Manager re-checks too
echo "vet check-base (the resume path's post-Manager re-check)"

# resume hands the pane to run-manager-resume and returns immediately, so the
# launch path's in-process check can never fire for a resumed review. The helper
# calls back into vet instead; this drives that entry point directly.
RESUME_HELPER="$(cat "$RUN_DIR/run-manager-resume")"
check_eq "the generated resume helper is valid bash" "0" \
  "$(bash -n "$RUN_DIR/run-manager-resume" >/dev/null 2>&1; echo $?)"
check_contains "the resume helper re-checks the base after the Manager exits" \
  "$RESUME_HELPER" "check-base"
# The helper runs under `set -e`; the re-check is best effort and must never
# take a resume down with it. The run id is a baked variable, not inlined, so
# that a path or id needing quoting cannot split into extra words.
# shellcheck disable=SC2016
check_contains "the resume helper cannot be taken down by that check" \
  "$RESUME_HELPER" 'check-base "$VET_RUN_ID" || true'
check_contains "the resume helper bakes the run id through %q" \
  "$RESUME_HELPER" "VET_RUN_ID=$(basename "$RUN_DIR")"

CB_ID="20260202-120000-7"
CB_DIR="$VET_STATE_ROOT/runs/$CB_ID"
CB_WORKDIR="$ROOT/worktrees/$CB_ID"
mkdir -p "$CB_DIR" "$CB_WORKDIR"
printf 'a title\n' > "$CB_DIR/title.txt"
# run-info.txt in the launch format, so the append can be checked for damage.
printf 'vet run:           %s\nReviewed head OID: %s\n' "$CB_ID" "$START_OID" \
  > "$CB_DIR/run-info.txt"
RUN_INFO_BEFORE="$(cat "$CB_DIR/run-info.txt")"
{
  printf 'RUN_ID=%q\n' "$CB_ID"
  printf 'STARTED_AT=%q\n' "2026-02-02 12:00:00"
  printf 'RUN_STATUS=%q\n' "running"
  printf 'VET_DIR=%q\n' "$CB_DIR"
  printf 'WINDOW_ID=%q\n' "@99"
  printf 'PR_NUMBER=%q\n' "11"
  printf 'PR_TITLE=%q\n' "a title"
  printf 'WORKDIR=%q\n' "$CB_WORKDIR"
  printf 'REPO_ROOT=%q\n' "$CLONE"
  printf 'GIT_REMOTE=%q\n' "origin"
  printf 'BASE_REF=%q\n' "$BASE_BRANCH"
  printf 'BASE_START_OID=%q\n' "$START_OID"
} > "$CB_DIR/state.env"

CB_OUT="$("$VET" check-base "$CB_ID" 2>&1)"
CB_RC=$?
check_eq "vet check-base succeeds" "0" "$CB_RC"
check_file "a resumed run reports the moved base too" "$CB_DIR/base-movement.txt"
check_contains "the resumed run warns the PO" "$CB_OUT" "moved during this review"
CB_STATE="$(cat "$CB_DIR/state.env")"
check_contains "check-base records BASE_END_OID" "$CB_STATE" "BASE_END_OID=$MOVED_OID"
# A moved base is a warning, not a lifecycle state -- vet-cockpit has no such
# RUN_STATUS and must not be shown one.
check_contains "check-base leaves RUN_STATUS alone" "$CB_STATE" "RUN_STATUS=running"

# run-info.txt is what vet-cockpit renders verbatim: the launch format must
# survive intact, with exactly one line added.
CB_INFO="$(cat "$CB_DIR/run-info.txt")"
check_contains "run-info.txt keeps its original content" "$CB_INFO" "$RUN_INFO_BEFORE"
check_contains "run-info.txt gains the base-moved line" "$CB_INFO" "Base moved:"
check_eq "run-info.txt gained exactly one line" \
  "$(( $(printf '%s\n' "$RUN_INFO_BEFORE" | wc -l) + 1 ))" \
  "$(wc -l < "$CB_DIR/run-info.txt" | tr -d ' ')"

# Re-checking (resume twice) must not append a second, competing line.
"$VET" check-base "$CB_ID" > /dev/null 2>&1
check_eq "a second re-check does not duplicate the line" "1" \
  "$(grep -c '^Base moved:' "$CB_DIR/run-info.txt" | tr -d ' ')"

# -- the base moves AGAIN during a resumed run ------------------------------
#
# The line must be UPDATED, not left as it was. Re-running check-base without
# moving the base (above) cannot catch a stale summary, because the OIDs are
# unchanged either way. vet-cockpit renders run-info.txt verbatim beside
# base-movement.txt, so the two must not disagree.
CB_LINE_BEFORE="$(grep '^Base moved:' "$CB_DIR/run-info.txt")"
# Everything that is NOT the Base moved: line, to prove only that line changes.
CB_REST_BEFORE="$(grep -v '^Base moved:' "$CB_DIR/run-info.txt")"

printf 'a third change\n' > "$OTHER/third.txt"
git_quiet -C "$OTHER" add third.txt
git_quiet -C "$OTHER" commit -q -m "a later commit on the base"
git_quiet -C "$OTHER" push -q origin "$BASE_BRANCH"
MOVED_OID_2="$(git_quiet -C "$OTHER" rev-parse HEAD)"
check_ne "the base really moved a second time" "$MOVED_OID" "$MOVED_OID_2"

"$VET" check-base "$CB_ID" > /dev/null 2>&1

check_eq "still exactly one Base moved: line after a second move" "1" \
  "$(grep -c '^Base moved:' "$CB_DIR/run-info.txt" | tr -d ' ')"
CB_LINE_AFTER="$(grep '^Base moved:' "$CB_DIR/run-info.txt")"
check_ne "the Base moved: line was actually updated" "$CB_LINE_BEFORE" "$CB_LINE_AFTER"
check_contains "run-info.txt carries the LATEST end OID" "$CB_LINE_AFTER" "$MOVED_OID_2"
check_absent "run-info.txt no longer shows the superseded end OID" \
  "$CB_LINE_AFTER" "$MOVED_OID"
check_contains "the updated line keeps the launch format" \
  "$CB_LINE_AFTER" "Base moved:        $START_OID -> $MOVED_OID_2 (see base-movement.txt)"

# base-movement.txt and run-info.txt must tell the PO the same story.
CB_MOVE_BODY="$(cat "$CB_DIR/base-movement.txt")"
check_contains "base-movement.txt agrees on the latest end OID" \
  "$CB_MOVE_BODY" "$MOVED_OID_2"
check_contains "base-movement.txt lists the later commit" \
  "$CB_MOVE_BODY" "a later commit on the base"

# The rewrite must touch nothing else: same lines, same order.
check_eq "every other line of run-info.txt survived unchanged" \
  "$CB_REST_BEFORE" "$(grep -v '^Base moved:' "$CB_DIR/run-info.txt")"
check_eq "run-info.txt did not grow" \
  "$(( $(printf '%s\n' "$RUN_INFO_BEFORE" | wc -l) + 1 ))" \
  "$(wc -l < "$CB_DIR/run-info.txt" | tr -d ' ')"
check_no_file "the rewrite leaves no temp file behind" "$CB_DIR/run-info.tmp"

# -- a later check that is INCONCLUSIVE or shows NO movement -----------------
#
# base-movement.txt outlives the check that wrote it. Deciding what to put in
# run-info.txt from that file's mere EXISTENCE meant a later check that could not
# read the base, or that found it back where it started, still wrote a line -
# `<start> -> ` with an empty end, or `<start> -> <start>`. Both contradict what
# vet actually concluded, and cockpit renders this file verbatim.

# A line must never be malformed, whatever path produced it.
#
# The shape is asserted STRICTLY, with a regex, rather than by looking for known
# bad substrings. An empty end OID renders as "-> " immediately followed by
# " (see", i.e. two spaces, so a `-> (see` needle silently misses it and the
# malformed line sails through -- which is exactly what happened the first time
# this was written.
assert_moved_line_wellformed() {
  local label="$1" file="$2" line a b
  local re='^Base moved:[[:space:]]+([0-9a-f]{7,40}) -> ([0-9a-f]{7,40}) \(see base-movement\.txt'
  line="$(grep '^Base moved:' "$file" 2>/dev/null || true)"
  if [[ -z "$line" ]]; then
    ok "$label (no line at all, which is well-formed)"
    return
  fi
  if [[ ! "$line" =~ $re ]]; then
    no "$label" "malformed: [$line]"
    return
  fi
  a="${BASH_REMATCH[1]}"
  b="${BASH_REMATCH[2]}"
  if [[ "$a" == "$b" ]]; then
    no "$label" "claims movement from an OID to itself: [$line]"
  else
    ok "$label"
  fi
}

# Whitespace-collapsed, so an EMPTY field between "->" and "(see" is visible as
# the adjacency it really is.
squeezed() { printf '%s' "$1" | tr -s ' '; }

CB_REST_STABLE="$(grep -v '^Base moved:' "$CB_DIR/run-info.txt")"

# (1) the remote has become unreadable since the movement was recorded
git_quiet -C "$CLONE" remote set-url origin "$ROOT/gone-away.git"
"$VET" check-base "$CB_ID" > /dev/null 2>&1
check_eq "an inconclusive re-check is not an error" "0" "$?"
check_eq "an inconclusive re-check leaves exactly one Base moved: line" "1" \
  "$(grep -c '^Base moved:' "$CB_DIR/run-info.txt" | tr -d ' ')"
assert_moved_line_wellformed "an inconclusive re-check writes no malformed line" \
  "$CB_DIR/run-info.txt"
CB_LINE_INCONCL="$(grep '^Base moved:' "$CB_DIR/run-info.txt")"
check_absent "an inconclusive re-check leaves no empty end OID" \
  "$(squeezed "$CB_LINE_INCONCL")" "-> (see"
# The movement really happened, so it is kept -- but marked, not passed off as
# the current state.
check_contains "the earlier real movement is kept" "$CB_LINE_INCONCL" "$MOVED_OID_2"
check_contains "the earlier movement is marked superseded" \
  "$CB_LINE_INCONCL" "superseded by a later check"
check_file "base-movement.txt is kept as the record it points at" \
  "$CB_DIR/base-movement.txt"
check_eq "an inconclusive re-check preserves every other line" \
  "$CB_REST_STABLE" "$(grep -v '^Base moved:' "$CB_DIR/run-info.txt")"

# (2) inconclusive AGAIN: the history must not decay away on the second pass.
# BASE_END_OID in state.env is empty by now, so the line can only survive if it
# is reconstructed from base-movement.txt rather than from state.env.
"$VET" check-base "$CB_ID" > /dev/null 2>&1
check_eq "a repeated inconclusive re-check still leaves exactly one line" "1" \
  "$(grep -c '^Base moved:' "$CB_DIR/run-info.txt" | tr -d ' ')"
check_eq "the superseded line survives a second inconclusive check" \
  "$CB_LINE_INCONCL" "$(grep '^Base moved:' "$CB_DIR/run-info.txt")"
assert_moved_line_wellformed "a repeated inconclusive re-check stays well-formed" \
  "$CB_DIR/run-info.txt"

# (3) the base is reset back to where the review started: readable, NOT moved
git_quiet -C "$CLONE" remote set-url origin "$REMOTE"
git_quiet -C "$OTHER" push -q --force origin "$START_OID:$BASE_BRANCH"
"$VET" check-base "$CB_ID" > /dev/null 2>&1
check_eq "a reset base re-check is not an error" "0" "$?"
check_eq "a reset base leaves exactly one Base moved: line" "1" \
  "$(grep -c '^Base moved:' "$CB_DIR/run-info.txt" | tr -d ' ')"
assert_moved_line_wellformed "a reset base writes no malformed line" \
  "$CB_DIR/run-info.txt"
CB_LINE_RESET="$(grep '^Base moved:' "$CB_DIR/run-info.txt")"
check_absent "a reset base never claims movement to itself" \
  "$CB_LINE_RESET" "$START_OID -> $START_OID"
check_contains "a reset base still marks the old movement superseded" \
  "$CB_LINE_RESET" "superseded by a later check"
check_eq "a reset base preserves every other line" \
  "$CB_REST_STABLE" "$(grep -v '^Base moved:' "$CB_DIR/run-info.txt")"
# Put the base back where the rest of the suite expects it.
git_quiet -C "$OTHER" push -q --force origin "$MOVED_OID_2:$BASE_BRANCH"

# (4) a run that NEVER saw movement must never gain a line at all
NM_ID="20260202-120000-9"
NM_DIR="$VET_STATE_ROOT/runs/$NM_ID"
mkdir -p "$NM_DIR" "$ROOT/worktrees/$NM_ID"
printf 'vet run:           %s\nStarted at:        x\n' "$NM_ID" > "$NM_DIR/run-info.txt"
NM_INFO_BEFORE="$(cat "$NM_DIR/run-info.txt")"
{
  printf 'RUN_ID=%q\n' "$NM_ID"
  printf 'STARTED_AT=%q\n' "2026-02-02 12:00:00"
  printf 'RUN_STATUS=%q\n' "running"
  printf 'VET_DIR=%q\n' "$NM_DIR"
  printf 'PR_NUMBER=%q\n' "13"
  printf 'WORKDIR=%q\n' "$ROOT/worktrees/$NM_ID"
  printf 'REPO_ROOT=%q\n' "$CLONE"
  printf 'GIT_REMOTE=%q\n' "origin"
  printf 'BASE_REF=%q\n' "$BASE_BRANCH"
  printf 'BASE_START_OID=%q\n' "$MOVED_OID_2"
} > "$NM_DIR/state.env"
"$VET" check-base "$NM_ID" > /dev/null 2>&1
check_eq "an unmoved base writes NO Base moved: line" "0" \
  "$(grep -c '^Base moved:' "$NM_DIR/run-info.txt" | tr -d ' ')"
check_no_file "an unmoved base writes no base-movement.txt" "$NM_DIR/base-movement.txt"
check_eq "an unmoved base leaves run-info.txt byte-identical" \
  "$NM_INFO_BEFORE" "$(cat "$NM_DIR/run-info.txt")"

echo ""

# ============================ run-info.txt rewrite: temp files and races
echo "set_run_info_moved_line (temp files, cleanup, concurrency)"

eval "$(extract_fn set_run_info_moved_line)"

mkdir -p "$ROOT/tmpbin"
RI="$ROOT/run-info-rewrite.txt"
write_ri_fixture() {
  printf 'vet run:           x\nBase moved:        aaa -> bbb (see base-movement.txt)\nStarted at:        y\n' > "$RI"
}

# -- a unique temp path per invocation --------------------------------------
#
# A fixed name was shared by every concurrent writer of one run, so two
# overlapping rewrites could interleave and the newer line could be lost. The
# mktemp stub records each path actually used.
cat > "$ROOT/tmpbin/mktemp" <<'STUB'
#!/usr/bin/env bash
out="$(/usr/bin/mktemp "$@")" || exit 1
printf '%s\n' "$out" >> "$MKTEMP_LOG"
printf '%s\n' "$out"
STUB
chmod +x "$ROOT/tmpbin/mktemp"
export MKTEMP_LOG="$ROOT/mktemp.log"
: > "$MKTEMP_LOG"

SAVED_PATH="$PATH"
PATH="$ROOT/tmpbin:$PATH"
write_ri_fixture
set_run_info_moved_line "$RI" "Base moved:        aaa -> ccc (see base-movement.txt)"
set_run_info_moved_line "$RI" "Base moved:        aaa -> ddd (see base-movement.txt)"
PATH="$SAVED_PATH"

MKTEMP_USED="$(wc -l < "$MKTEMP_LOG" | tr -d ' ')"
MKTEMP_UNIQUE="$(sort -u "$MKTEMP_LOG" | wc -l | tr -d ' ')"
check_eq "each rewrite allocates its own temp file" "2" "$MKTEMP_USED"
check_eq "the two temp paths are DISTINCT" "2" "$MKTEMP_UNIQUE"
check_absent "the temp path is not the old fixed run-info.tmp" \
  "$(cat "$MKTEMP_LOG")" "run-info.tmp"
check_contains "the temp file sits beside the file it replaces" \
  "$(head -n 1 "$MKTEMP_LOG")" "$ROOT/"
check_eq "the last write wins and the file is intact" \
  "Base moved:        aaa -> ddd (see base-movement.txt)" \
  "$(grep '^Base moved:' "$RI")"

# -- cleanup on failure ------------------------------------------------------
cat > "$ROOT/tmpbin/awk" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$ROOT/tmpbin/awk"
write_ri_fixture
RI_BEFORE="$(cat "$RI")"
: > "$MKTEMP_LOG"
PATH="$ROOT/tmpbin:$PATH"
set_run_info_moved_line "$RI" "Base moved:        aaa -> eee (see base-movement.txt)"
RI_RC=$?
PATH="$SAVED_PATH"
check_eq "a failed rewrite is not an error" "0" "$RI_RC"
check_eq "a failed rewrite leaves the original untouched" "$RI_BEFORE" "$(cat "$RI")"
FAILED_TMP="$(head -n 1 "$MKTEMP_LOG")"
if [[ -n "$FAILED_TMP" ]]; then
  check_no_file "a failed rewrite removes its temp file" "$FAILED_TMP"
else
  no "a failed rewrite removes its temp file" "no temp path was recorded"
fi
check_eq "a failed rewrite leaves no stray temp beside the file" "0" \
  "$(find "$(dirname "$RI")" -maxdepth 1 -name "$(basename "$RI").*" | wc -l | tr -d ' ')"
rm -f "$ROOT/tmpbin/awk"

# -- overlapping rewrites ----------------------------------------------------
#
# HONEST LIMIT: this does not prove the race is gone -- interleaving is not
# controllable from a shell test. It asserts the INVARIANT that must survive any
# interleaving: the file always ends up well-formed, with exactly one line and no
# debris. The property that actually prevents the reported bug is the distinct
# temp paths asserted above.
write_ri_fixture
for i in 1 2 3 4 5 6; do
  set_run_info_moved_line "$RI" "Base moved:        aaa -> c$i (see base-movement.txt)" &
done
wait
check_eq "overlapping rewrites still leave exactly one line" "1" \
  "$(grep -c '^Base moved:' "$RI" | tr -d ' ')"
check_eq "overlapping rewrites preserve every other line" \
  "vet run:           x
Started at:        y" "$(grep -v '^Base moved:' "$RI")"
check_eq "overlapping rewrites leave no debris" "0" \
  "$(find "$(dirname "$RI")" -maxdepth 1 -name "$(basename "$RI").*" | wc -l | tr -d ' ')"

# -- the empty line means "remove it entirely" -------------------------------
write_ri_fixture
set_run_info_moved_line "$RI" ""
check_eq "an empty line removes the Base moved: line" "0" \
  "$(grep -c '^Base moved:' "$RI" | tr -d ' ')"
check_eq "removing it preserves every other line" \
  "vet run:           x
Started at:        y" "$(cat "$RI")"

# -- a file that somehow already holds two lines collapses to one ------------
printf 'a\nBase moved:        aaa -> bbb (x)\nb\nBase moved:        aaa -> zzz (y)\nc\n' > "$RI"
set_run_info_moved_line "$RI" "Base moved:        aaa -> fff (see base-movement.txt)"
check_eq "duplicates collapse to exactly one line" "1" \
  "$(grep -c '^Base moved:' "$RI" | tr -d ' ')"
check_eq "the surviving line is the one the caller asked for" \
  "Base moved:        aaa -> fff (see base-movement.txt)" "$(grep '^Base moved:' "$RI")"
check_eq "collapsing duplicates preserves every other line" \
  "a
b
c" "$(grep -v '^Base moved:' "$RI")"

# An old run with no BASE_START_OID must not crash, must not warn, and must say
# why it cannot tell.
OLD_CB_ID="20260202-120000-8"
OLD_CB_DIR="$VET_STATE_ROOT/runs/$OLD_CB_ID"
mkdir -p "$OLD_CB_DIR" "$ROOT/worktrees/$OLD_CB_ID"
{
  printf 'RUN_ID=%q\n' "$OLD_CB_ID"
  printf 'STARTED_AT=%q\n' "2026-02-02 12:00:00"
  printf 'RUN_STATUS=%q\n' "running"
  printf 'VET_DIR=%q\n' "$OLD_CB_DIR"
  printf 'PR_NUMBER=%q\n' "12"
  printf 'WORKDIR=%q\n' "$ROOT/worktrees/$OLD_CB_ID"
  printf 'REPO_ROOT=%q\n' "$CLONE"
} > "$OLD_CB_DIR/state.env"
OLD_CB_OUT="$("$VET" check-base "$OLD_CB_ID" 2>&1)"
check_eq "check-base on a pre-change run is not an error" "0" "$?"
check_no_file "a pre-change run raises no false alarm" "$OLD_CB_DIR/base-movement.txt"
check_contains "a pre-change run explains why it cannot tell" \
  "$OLD_CB_OUT" "could not compare the base branch"
check_absent "check-base on a pre-change run does not crash" \
  "$OLD_CB_OUT" "unbound variable"

echo ""

# ================ a corrupted base-movement.txt must not reach the PO
echo "malformed base-movement.txt (parsed text is validated, not trusted)"

eval "$(extract_fn is_oid)"

check_eq "a 40-hex SHA-1 is an OID" "0" \
  "$(is_oid 0123456789abcdef0123456789abcdef01234567; echo $?)"
check_eq "a 64-hex SHA-256 is an OID" "0" \
  "$(is_oid 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; echo $?)"
# The single quotes are the point: these are literal strings, not expansions.
# shellcheck disable=SC2016
for notoid in "" "garbage" "0123456" "0123456789abcdef0123456789abcdef0123456" \
              "0123456789ABCDEF0123456789abcdef01234567" "0123456789abcdef0123456789abcdef012345678" \
              "0123456789abcdef0123456789abcdef0123456g" '$(touch /tmp/vet-pwned)' "HEAD" "refs/heads/main"; do
  check_eq "[$notoid] is rejected as an OID" "1" "$(is_oid "$notoid"; echo $?)"
done

# A run whose base cannot be read now, so the superseded path is the one taken,
# and whose base-movement.txt has been damaged.
MB_ID="20260202-120000-10"
MB_DIR="$VET_STATE_ROOT/runs/$MB_ID"
mkdir -p "$MB_DIR" "$ROOT/worktrees/$MB_ID"
{
  printf 'RUN_ID=%q\n' "$MB_ID"
  printf 'STARTED_AT=%q\n' "2026-02-02 12:00:00"
  printf 'RUN_STATUS=%q\n' "running"
  printf 'VET_DIR=%q\n' "$MB_DIR"
  printf 'PR_NUMBER=%q\n' "14"
  printf 'WORKDIR=%q\n' "$ROOT/worktrees/$MB_ID"
  printf 'REPO_ROOT=%q\n' "$CLONE"
  printf 'GIT_REMOTE=%q\n' "origin"
  printf 'BASE_REF=%q\n' "$BASE_BRANCH"
  printf 'BASE_START_OID=%q\n' "$START_OID"
} > "$MB_DIR/state.env"

# Each case starts from a run-info.txt that ALREADY carries a valid line, so the
# assertions prove the damaged artifact cannot leave it standing either.
reset_mb() {
  printf 'vet run:           %s\nBase moved:        %s -> %s (see base-movement.txt)\nStarted at:        z\n' \
    "$MB_ID" "$START_OID" "$MOVED_OID_2" > "$MB_DIR/run-info.txt"
}
MB_REST='vet run:           '"$MB_ID"'
Started at:        z'

# The remote is unreachable for all of these, so every check is inconclusive.
git_quiet -C "$CLONE" remote set-url origin "$ROOT/gone-away.git"

mb_case() {
  local label="$1" out
  reset_mb
  out="$("$VET" check-base "$MB_ID" 2>&1)"
  check_eq "$label: not an error" "0" "$?"
  check_eq "$label: no Base moved: line is written" "0" \
    "$(grep -c '^Base moved:' "$MB_DIR/run-info.txt" | tr -d ' ')"
  check_eq "$label: every other line is preserved" \
    "$MB_REST" "$(cat "$MB_DIR/run-info.txt")"
  check_contains "$label: the PO is told the record did not parse" \
    "$out" "does not parse as a movement record"
}

# (1) truncated: the header lines never got written
printf 'The base branch moved while this review was running.\n' > "$MB_DIR/base-movement.txt"
mb_case "a truncated artifact"

# (2) values that are not OIDs at all
printf 'At launch: garbage\nAt finish: other\n' > "$MB_DIR/base-movement.txt"
mb_case "a hand-edited artifact"
check_absent "non-OID text never reaches run-info.txt" \
  "$(cat "$MB_DIR/run-info.txt")" "garbage"
check_absent "non-OID text never reaches run-info.txt (second value)" \
  "$(cat "$MB_DIR/run-info.txt")" "other"

# (3) abbreviated OIDs are not full OIDs
printf 'At launch: 0123456\nAt finish: 89abcde\n' > "$MB_DIR/base-movement.txt"
mb_case "an abbreviated artifact"

# (4) shell-flavoured text must be inert: it is data, never evaluated
# Literal shell syntax written INTO the artifact; it must stay inert.
# shellcheck disable=SC2016
printf 'At launch: $(touch /tmp/vet-pwned-mb)\nAt finish: `touch /tmp/vet-pwned-mb2`\n' \
  > "$MB_DIR/base-movement.txt"
mb_case "a shell-injection artifact"
check_no_file "artifact text is never executed" "/tmp/vet-pwned-mb"
check_no_file "artifact text is never executed (backticks)" "/tmp/vet-pwned-mb2"
check_absent "artifact text never reaches run-info.txt" \
  "$(cat "$MB_DIR/run-info.txt")" "touch"

# (5) a commit SUBJECT in the log section must not be mistaken for a header.
# The real header comes first, so the first match wins and the line is valid.
{
  printf 'The base branch moved while this review was running.\n\n'
  printf 'Base ref:  origin/%s\n' "$BASE_BRANCH"
  printf 'At launch: %s\n' "$START_OID"
  printf 'At finish: %s\n' "$MOVED_OID_2"
  printf '\nCommits added to the base since this review started:\n'
  printf 'deadbee At launch: 1111111111111111111111111111111111111111\n'
  printf 'cafef00 At finish: 2222222222222222222222222222222222222222\n'
} > "$MB_DIR/base-movement.txt"
reset_mb
"$VET" check-base "$MB_ID" > /dev/null 2>&1
check_eq "a decoy commit subject does not displace the real header" "1" \
  "$(grep -c '^Base moved:' "$MB_DIR/run-info.txt" | tr -d ' ')"
assert_moved_line_wellformed "a decoy commit subject leaves a well-formed line" \
  "$MB_DIR/run-info.txt"
MB_LINE="$(grep '^Base moved:' "$MB_DIR/run-info.txt")"
check_contains "the real launch OID is used" "$MB_LINE" "$START_OID"
check_contains "the real finish OID is used" "$MB_LINE" "$MOVED_OID_2"
check_absent "the decoy OID is not used" "$MB_LINE" "1111111111111111111111111111111111111111"

git_quiet -C "$CLONE" remote set-url origin "$REMOTE"

echo ""

# ============ generated helpers survive an install path with a space
echo "generated helpers under a path containing a space"

# vet is copied to a directory whose name contains a space and run from there, so
# VET_SCRIPT_PATH and VET_DIR both carry one. Every baked value must come back
# through printf %q and every use must be quoted.
SPACE_HOME="$ROOT/space dir"
mkdir -p "$SPACE_HOME/bin dir"
cp "$VET" "$SPACE_HOME/bin dir/vet"
chmod +x "$SPACE_HOME/bin dir/vet"

SPACE_OUT="$ROOT/space-run.out"
(
  cd "$REPO" &&
  VET_STATE_ROOT="$SPACE_HOME/state root" \
  VET_WORKTREE_ROOT="$SPACE_HOME/wt root" \
  VET_FIXTURE_DIR="$FIXTURES" \
  VET_DRY_RUN=1 "$SPACE_HOME/bin dir/vet" --dry-run 42
) > "$SPACE_OUT" 2>&1
check_eq "a dry run succeeds from a path with a space" "0" "$?"

SPACE_RUN_DIR="$(find "$SPACE_HOME/state root/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)"
if [[ -n "$SPACE_RUN_DIR" ]]; then
  ok "a run directory is created under a spaced path"
else
  no "a run directory is created under a spaced path" "see $SPACE_OUT"
fi

if [[ -n "$SPACE_RUN_DIR" ]]; then
  # EVERY generated helper, not just the resume one.
  for helper in run-step run-manager-resume run-wait run-reviewer-a run-reviewer-b \
                validate-json update-title; do
    check_eq "generated $helper is valid bash under a spaced path" "0" \
      "$(bash -n "$SPACE_RUN_DIR/$helper" >/dev/null 2>&1; echo $?)"
  done

  RESUME_SPACED="$(cat "$SPACE_RUN_DIR/run-manager-resume")"
  # The space must be escaped at bake time, not left bare.
  check_absent "the baked vet path is not left unescaped" \
    "$(grep '^VET_BIN=' "$SPACE_RUN_DIR/run-manager-resume")" "bin dir"
  check_contains "the baked vet path is %q-escaped" \
    "$(grep '^VET_BIN=' "$SPACE_RUN_DIR/run-manager-resume")" 'bin\ dir'
  # ... and every use of it is quoted.
  # Literal text expected in the GENERATED script, not an expansion here.
  # shellcheck disable=SC2016
  check_contains "check-base is invoked through the quoted variable" \
    "$RESUME_SPACED" '"$VET_BIN" check-base'
  # shellcheck disable=SC2016
  check_contains "render is invoked through the quoted variable" \
    "$RESUME_SPACED" '"$VET_BIN" render --if-stale'
  check_absent "the raw path is never a bare command word" \
    "$RESUME_SPACED" "$SPACE_HOME/bin dir/vet check-base"

  # It must resolve to the real executable, not merely parse.
  # Evaluate the baked assignment exactly as the helper would, so the assertion
  # tests the %q round-trip rather than the test's own idea of unescaping.
  SPACED_TARGET="$(
    eval "$(grep -E '^VET_BIN=' "$SPACE_RUN_DIR/run-manager-resume")"
    printf '%s' "${VET_BIN:-}"
  )"
  # vet records its own physical path, and on macOS /var is a symlink to
  # /private/var, so both sides are normalised before comparing. The property
  # under test is the %q round-trip, not the symlink.
  SPACE_BIN_PHYS="$(cd "$SPACE_HOME/bin dir" && pwd -P)/vet"
  check_eq "the baked path resolves to the copied vet" \
    "$SPACE_BIN_PHYS" "$SPACED_TARGET"
  if [[ -x "$SPACED_TARGET" ]]; then
    ok "the baked path is executable"
  else
    no "the baked path is executable" "not executable: $SPACED_TARGET"
  fi

  # run-step bakes the same way; confirm its spaced values survive too.
  check_eq "generated run-step still dispatches under a spaced path" "2" \
    "$("$SPACE_RUN_DIR/run-step" >/dev/null 2>&1; echo $?)"
fi

echo ""

# ============ the send-keys payload survives the destination shell
echo "run-step send-keys payload (re-parsed by the reviewer pane's shell)"

# send-keys does not carry an argv: it types ONE STRING that the destination
# pane's shell re-parses. So the payload is captured here and then parsed the way
# that shell would parse it, and the resulting argv is what gets asserted.
SK_STUB="$ROOT/skbin"
mkdir -p "$SK_STUB"
cat > "$SK_STUB/tmux" <<'STUB'
#!/usr/bin/env bash
# tmux send-keys -t <pane> <payload> Enter
if [[ "${1:-}" == "send-keys" ]]; then
  printf '%s' "${4:-}" > "$SK_PAYLOAD"
fi
exit 0
STUB
chmod +x "$SK_STUB/tmux"
export SK_PAYLOAD="$ROOT/sk-payload.txt"

sk_send() {
  : > "$SK_PAYLOAD"
  ( PATH="$SK_STUB:$PATH"; "$1/run-step" "$2" ) > /dev/null 2>&1
}
# Parse the captured payload exactly as the pane's shell would. The eval runs in
# a subshell so a payload that DID inject cannot reach the rest of the suite.
sk_argc() {
  local payload="$1"
  # shellcheck disable=SC2294
  ( eval "set -- $(cat "$payload")"; printf '%s' "$#" )
}
sk_arg() {
  local n="$1"
  # shellcheck disable=SC2294
  ( eval "set -- $(cat "$SK_PAYLOAD")"; eval "printf '%s' \"\${$n}\"" )
}

# -- the ordinary case is byte-for-byte what it always was -------------------
# shellcheck disable=SC1003  # a single literal backslash, not an escape
BACKSLASH='\'
sk_send "$RUN_DIR" reviewer-a
check_absent "an ordinary path needs no escaping at all" "$(cat "$SK_PAYLOAD")" "$BACKSLASH"
check_eq "reviewer A still receives 9 arguments" "9" "$(sk_argc "$SK_PAYLOAD")"
check_eq "argument 1 is the reviewer A helper" \
  "$RUN_DIR/run-reviewer-a" "$(sk_arg 1)"
check_eq "argument 9 is the run directory" "$RUN_DIR" "$(sk_arg 9)"

sk_send "$RUN_DIR" reviewer-b
check_eq "reviewer B still receives 8 arguments" "8" "$(sk_argc "$SK_PAYLOAD")"
check_eq "argument 1 is the reviewer B helper" \
  "$RUN_DIR/run-reviewer-b" "$(sk_arg 1)"

# -- a path containing a space -----------------------------------------------
if [[ -n "$SPACE_RUN_DIR" ]]; then
  sk_send "$SPACE_RUN_DIR" reviewer-a
  check_eq "a spaced path still yields 9 arguments" "9" "$(sk_argc "$SK_PAYLOAD")"
  check_eq "the spaced helper path survives as ONE argument" \
    "$SPACE_RUN_DIR/run-reviewer-a" "$(sk_arg 1)"
  check_eq "the spaced task file survives as ONE argument" \
    "$SPACE_RUN_DIR/reviewer-a-task.md" "$(sk_arg 2)"
  check_eq "the spaced result file survives as ONE argument" \
    "$SPACE_RUN_DIR/reviewer-a-result.json" "$(sk_arg 3)"
  check_eq "the spaced status file survives as ONE argument" \
    "$SPACE_RUN_DIR/reviewer-a-status.txt" "$(sk_arg 4)"
  check_eq "the runtime-computed event survives" \
    "$(cat "$SPACE_RUN_DIR/reviewer-a-event.txt")" "$(sk_arg 5)"
  check_eq "the spaced schema file survives as ONE argument" \
    "$SPACE_RUN_DIR/reviewer-schema.json" "$(sk_arg 7)"
  check_eq "the runtime-computed mode survives" "initial" "$(sk_arg 8)"
  check_eq "the spaced run directory survives as ONE argument" \
    "$SPACE_RUN_DIR" "$(sk_arg 9)"

  sk_send "$SPACE_RUN_DIR" reviewer-a-resume
  check_eq "the resume mode survives too" "resume" "$(sk_arg 8)"

  sk_send "$SPACE_RUN_DIR" reviewer-b
  check_eq "a spaced path still yields 8 arguments for reviewer B" "8" "$(sk_argc "$SK_PAYLOAD")"
  check_eq "the spaced reviewer B helper survives as ONE argument" \
    "$SPACE_RUN_DIR/run-reviewer-b" "$(sk_arg 1)"
  # Evaluate the baked assignment rather than trying to un-escape it by hand.
  SPACE_WORKDIR="$(
    eval "$(grep '^WORKDIR=' "$SPACE_RUN_DIR/run-step")"
    printf '%s' "${WORKDIR:-}"
  )"
  check_eq "the spaced worktree path survives as ONE argument" \
    "$SPACE_WORKDIR" "$(sk_arg 7)"
fi

# -- a path containing $( ), i.e. the injection case --------------------------
#
# The marker must never be created: the destination shell has to treat these
# characters as part of a filename, not as a command to run.
SK_MARKER="$ROOT/sk-injected"
INJ_HOME="$ROOT/inj \$(touch $SK_MARKER) dir"
mkdir -p "$INJ_HOME"
INJ_OUT="$ROOT/inj-run.out"
(
  cd "$REPO" &&
  VET_STATE_ROOT="$INJ_HOME/state" \
  VET_WORKTREE_ROOT="$ROOT/inj-wt" \
  VET_FIXTURE_DIR="$FIXTURES" \
  VET_DRY_RUN=1 "$VET" --dry-run 42
) > "$INJ_OUT" 2>&1
INJ_RUN_DIR="$(find "$INJ_HOME/state/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)"

if [[ -n "$INJ_RUN_DIR" ]]; then
  ok "a run directory is created under a path containing \$( )"
  sk_send "$INJ_RUN_DIR" reviewer-a
  check_eq "an injecting path still yields 9 arguments" "9" "$(sk_argc "$SK_PAYLOAD")"
  check_eq "the \$( ) path survives as ONE literal argument" \
    "$INJ_RUN_DIR/run-reviewer-a" "$(sk_arg 1)"
  check_eq "the \$( ) run directory survives as ONE literal argument" \
    "$INJ_RUN_DIR" "$(sk_arg 9)"
  # shellcheck disable=SC2016
  check_contains "the argument still contains the literal \$( ) text" \
    "$(sk_arg 9)" '$(touch'
  check_no_file "no command substitution is performed by the pane shell" "$SK_MARKER"

  sk_send "$INJ_RUN_DIR" reviewer-b
  check_eq "an injecting path still yields 8 arguments for reviewer B" "8" "$(sk_argc "$SK_PAYLOAD")"
  check_eq "the \$( ) reviewer B helper survives as ONE literal argument" \
    "$INJ_RUN_DIR/run-reviewer-b" "$(sk_arg 1)"
  check_no_file "reviewer B's payload injects nothing either" "$SK_MARKER"
else
  no "a run directory is created under a path containing \$( )" "see $INJ_OUT"
fi

echo ""

# ================================================= old runs keep working
echo "old retained runs (none of the new files or fields)"

# A run directory written by the PREVIOUS version of vet: no event files, no
# BASE_START_OID / BASE_END_OID. Every read path must still work.
OLD_ID="20260101-090000-1"
OLD_DIR="$VET_STATE_ROOT/runs/$OLD_ID"
OLD_WORKDIR="$ROOT/worktrees/$OLD_ID"
mkdir -p "$OLD_DIR" "$OLD_WORKDIR"
{
  printf 'RUN_ID=%q\n' "$OLD_ID"
  printf 'STARTED_AT=%q\n' "2026-01-01 09:00:00"
  printf 'RUN_STATUS=%q\n' "running"
  printf 'VET_DIR=%q\n' "$OLD_DIR"
  printf 'WINDOW_ID=%q\n' "@99"
  printf 'PR_NUMBER=%q\n' "7"
  printf 'PR_TITLE=%q\n' "an old run"
  printf 'WORKDIR=%q\n' "$OLD_WORKDIR"
  printf 'REPO_ROOT=%q\n' "$REPO"
} > "$OLD_DIR/state.env"

: > "$TMUX_STUB_LOG"
LIST_OUT="$("$VET" list 2>&1)"
LIST_RC=$?
check_eq "vet list survives a run with none of the new fields" "0" "$LIST_RC"
check_contains "the old run is listed" "$LIST_OUT" "$OLD_ID"
# Its window is gone, so the stored `running` must still display as closed --
# this is the precedence vet-cockpit mirrors.
check_contains "RUN_STATUS precedence is unchanged for old runs" \
  "$(echo "$LIST_OUT" | grep "$OLD_ID")" "closed"

CLOSE_OUT="$("$VET" close "$OLD_ID" 2>&1)"
CLOSE_RC=$?
check_eq "vet close survives a run with none of the new fields" "0" "$CLOSE_RC"
check_contains "closing the old run is reported" "$CLOSE_OUT" "vet run closed: $OLD_ID"
# Rewriting its state must ADD the new fields, not lose the old ones.
OLD_STATE="$(cat "$OLD_DIR/state.env")"
check_contains "the rewritten old state records closed" "$OLD_STATE" "RUN_STATUS=closed"
check_contains "the rewritten old state keeps PR_NUMBER" "$OLD_STATE" "PR_NUMBER=7"
check_contains "the rewritten old state gains BASE_START_OID" "$OLD_STATE" "BASE_START_OID="

# vet render on a run with no consolidated.json must fail cleanly, not crash on
# an unbound new variable.
RENDER_OUT="$("$VET" render "$OLD_ID" 2>&1)"
check_absent "vet render does not trip over a missing new field" \
  "$RENDER_OUT" "unbound variable"

RESUME_OUT="$("$VET" resume --session work "$OLD_ID" 2>&1)"
check_absent "vet resume does not trip over a missing new field" \
  "$RESUME_OUT" "unbound variable"

check_absent "nothing in this suite ever killed a window" "$(cat "$TMUX_STUB_LOG")" "kill-window"
check_absent "nothing in this suite ever killed a session" "$(cat "$TMUX_STUB_LOG")" "kill-session"

echo ""
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
