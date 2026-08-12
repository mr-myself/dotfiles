#!/usr/bin/env bash
# Tests for vet's auto-close-on-completion behaviour.
#
#   ./test-vet-autoclose.sh
#
# Everything runs against a TEMP VET_STATE_ROOT and a STUBBED tmux placed first
# on PATH. The real tmux is never invoked and ~/.local/state/vet is never
# touched. The stub records every call, so the tests can assert on what vet did
# and -- more importantly -- on what it did NOT do: `kill-window` must never be
# invoked, because on the normal path WINDOW_ID is the PO's own working window.
#
# Function-level cases source the real function bodies out of ./vet at run time
# (see extract_fn), so they cannot drift from the shipped implementation.

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

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then ok "$label"; else no "$label" "missing [$needle] in: $haystack"; fi
}

check_absent() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then ok "$label"; else no "$label" "unexpected [$needle] in: $haystack"; fi
}

# Pull one top-level function body verbatim out of the real vet script.
extract_fn() {
  awk -v fn="$1" '
    $0 ~ "^"fn"\\(\\) \\{" { inside = 1 }
    inside { print }
    inside && $0 == "}" { exit }
  ' "$VET"
}

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vet-autoclose-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/bin"

# ---------------------------------------------------------------- tmux stub
#
# Logs every invocation, and answers only the queries vet actually makes.
# Live windows/panes and each pane's foreground command are driven by files, so
# a test can describe any tmux state it likes.
cat > "$ROOT/bin/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_STUB_LOG"
case "$1 $2" in
  "list-windows -a") cat "$TMUX_STUB_DIR/live-windows" 2>/dev/null; exit 0 ;;
  "list-panes -a")   cat "$TMUX_STUB_DIR/live-panes"   2>/dev/null; exit 0 ;;
esac
if [[ "$1" == "display-message" ]]; then
  # vet asks: display-message -p -t <pane> '#{pane_current_command}'
  pane=""
  for ((i = 1; i <= $#; i++)); do
    if [[ "${!i}" == "-t" ]]; then j=$((i + 1)); pane="${!j}"; fi
  done
  cat "$TMUX_STUB_DIR/cmd${pane//%/pct}" 2>/dev/null || echo bash
  exit 0
fi
exit 0
STUB
chmod +x "$ROOT/bin/tmux"

export TMUX_STUB_DIR="$ROOT/stub"
export TMUX_STUB_LOG="$ROOT/tmux.log"
mkdir -p "$TMUX_STUB_DIR"
export PATH="$ROOT/bin:$PATH"

# Hermetic roots: never the PO's real state or worktrees.
export VET_STATE_ROOT="$ROOT/state"
export VET_WORKTREE_ROOT="$ROOT/worktrees"

reset_stub() {
  : > "$TMUX_STUB_LOG"
  : > "$TMUX_STUB_DIR/live-windows"
  : > "$TMUX_STUB_DIR/live-panes"
  rm -f "$TMUX_STUB_DIR"/cmd* 2>/dev/null || true
}

# ------------------------------------------------------- finish_run harness
#
# Builds a run directory, sources the real helpers, and calls the real
# finish_run with `set -e` on, exactly as the completion block does.
run_finish_run() {
  local dir="$1"
  (
    set -euo pipefail
    eval "$(extract_fn window_exists)"
    eval "$(extract_fn pane_exists)"
    eval "$(extract_fn pane_is_idle)"
    eval "$(extract_fn report_is_current)"
    eval "$(extract_fn write_state)"
    eval "$(extract_fn finish_run)"

    # These are the variables the completion block has in scope when it calls
    # finish_run. shellcheck cannot see through the evals above, so it reads
    # them as unused.
    # shellcheck disable=SC2034
    RUN_ID="$(basename "$dir")"
    # shellcheck disable=SC2034
    STARTED_AT="2026-08-12 10:00:00"
    # shellcheck disable=SC2034
    PR_NUMBER=9181
    # shellcheck disable=SC2034
    REPO_ROOT="$ROOT/repo"
    # shellcheck disable=SC2034
    WORKDIR="$ROOT/wt"
    # shellcheck disable=SC2034
    VET_DIR="$dir"
    # shellcheck disable=SC2034
    REPORT_PATH="$dir/report.html"
    # shellcheck disable=SC2034
    CONSOLIDATED_PATH="$dir/consolidated.json"
    # shellcheck disable=SC2034
    WINDOW_ID="@25"
    # shellcheck disable=SC2034
    MANAGER_PANE="%68"
    # shellcheck disable=SC2034
    REVIEWER_A_PANE="%69"
    # shellcheck disable=SC2034
    REVIEWER_B_PANE="%70"
    # shellcheck disable=SC2034
    RUN_STATUS="running"

    finish_run
  )
}

make_run_dir() {
  local dir="$VET_STATE_ROOT/runs/$1"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

status_of() {
  # Read RUN_STATUS back out of a %q-quoted state.env without sourcing it.
  sed -n 's/^RUN_STATUS=//p' "$1/state.env" 2>/dev/null | tr -d "'"
}

echo "vet auto-close tests"
echo ""

# ============================================================ finish_run
echo "finish_run (completion path)"

reset_stub
printf '@25\n' > "$TMUX_STUB_DIR/live-windows"
printf '%%68\n%%69\n%%70\n' > "$TMUX_STUB_DIR/live-panes"
DIR="$(make_run_dir 20260812-100000-1)"
printf '{}' > "$DIR/consolidated.json"
sleep 1
printf '<html></html>' > "$DIR/report.html"
run_finish_run "$DIR" > "$ROOT/out.txt" 2>&1
LOG="$(cat "$TMUX_STUB_LOG")"

check_eq "a completed run is recorded as closed" "closed" "$(status_of "$DIR")"
check_contains "reviewer A's pane is killed" "$LOG" "kill-pane -t %69"
check_contains "reviewer B's pane is killed" "$LOG" "kill-pane -t %70"
check_absent "the Manager pane is NEVER killed" "$LOG" "kill-pane -t %68"
check_absent "kill-window is NEVER invoked" "$LOG" "kill-window"
check_absent "kill-session is NEVER invoked" "$LOG" "kill-session"
check_contains "the PO is told how to resume" "$(cat "$ROOT/out.txt")" "vet resume 20260812-100000-1"

# A stale report (consolidated JSON newer) is not a completed run.
reset_stub
printf '@25\n' > "$TMUX_STUB_DIR/live-windows"
printf '%%68\n%%69\n%%70\n' > "$TMUX_STUB_DIR/live-panes"
DIR="$(make_run_dir 20260812-100000-2)"
printf '<html></html>' > "$DIR/report.html"
sleep 1
printf '{}' > "$DIR/consolidated.json"
run_finish_run "$DIR" >/dev/null 2>&1
check_eq "a stale report does not close the run" "" "$(status_of "$DIR")"
check_absent "no panes are killed for a stale report" "$(cat "$TMUX_STUB_LOG")" "kill-pane"

# No report at all: the run must stay resumable.
reset_stub
printf '@25\n' > "$TMUX_STUB_DIR/live-windows"
printf '%%68\n%%69\n%%70\n' > "$TMUX_STUB_DIR/live-panes"
DIR="$(make_run_dir 20260812-100000-3)"
printf '{}' > "$DIR/consolidated.json"
run_finish_run "$DIR" >/dev/null 2>&1
check_eq "a run with no report is not closed" "" "$(status_of "$DIR")"
check_absent "no panes are killed when there is no report" "$(cat "$TMUX_STUB_LOG")" "kill-pane"

# A reviewer still working keeps its pane.
reset_stub
printf '@25\n' > "$TMUX_STUB_DIR/live-windows"
printf '%%68\n%%69\n%%70\n' > "$TMUX_STUB_DIR/live-panes"
printf 'claude\n' > "$TMUX_STUB_DIR/cmdpct69"
DIR="$(make_run_dir 20260812-100000-4)"
printf '{}' > "$DIR/consolidated.json"
sleep 1
printf '<html></html>' > "$DIR/report.html"
run_finish_run "$DIR" >/dev/null 2>&1
LOG="$(cat "$TMUX_STUB_LOG")"
check_absent "a busy reviewer pane is left alone" "$LOG" "kill-pane -t %69"
check_contains "an idle reviewer pane is still cleaned up" "$LOG" "kill-pane -t %70"

# A pane tmux no longer knows about is skipped.
reset_stub
printf '@25\n' > "$TMUX_STUB_DIR/live-windows"
printf '%%68\n%%70\n' > "$TMUX_STUB_DIR/live-panes"
DIR="$(make_run_dir 20260812-100000-5)"
printf '{}' > "$DIR/consolidated.json"
sleep 1
printf '<html></html>' > "$DIR/report.html"
run_finish_run "$DIR" >/dev/null 2>&1
check_absent "an already-gone pane is not killed" "$(cat "$TMUX_STUB_LOG")" "kill-pane -t %69"

echo ""

# ============================================================ vet list
echo "vet list (status precedence)"

write_state_env() {
  local id="$1" status="$2" window="$3"
  local dir="$VET_STATE_ROOT/runs/$id"
  # resume_run checks the PR worktree exists BEFORE its liveness guard, so the
  # fixture needs a real directory to reach the guard under test.
  local workdir="$ROOT/worktrees/$id"
  mkdir -p "$dir" "$workdir"
  {
    printf 'RUN_ID=%q\n' "$id"
    printf 'RUN_STATUS=%q\n' "$status"
    printf 'VET_DIR=%q\n' "$dir"
    printf 'WINDOW_ID=%q\n' "$window"
    printf 'PR_NUMBER=%q\n' "9181"
    printf 'PR_TITLE=%q\n' "a title"
    printf 'WORKDIR=%q\n' "$workdir"
    printf 'REPO_ROOT=%q\n' ""
  } > "$dir/state.env"
}

rm -rf "${VET_STATE_ROOT:?}/runs"
reset_stub
printf '@25\n' > "$TMUX_STUB_DIR/live-windows"

write_state_env 20260812-110000-1 closed  "@25"   # auto-closed, PO's window alive
write_state_env 20260812-110000-2 running "@25"   # genuinely running
write_state_env 20260812-110000-3 running "@99"   # crashed: window gone
write_state_env 20260812-110000-4 dry-run ""      # dry run

LIST="$("$VET" list 2>&1)"
check_contains "stored closed + live window shows closed" \
  "$(echo "$LIST" | grep 20260812-110000-1)" "closed"
check_contains "stored running + live window shows running" \
  "$(echo "$LIST" | grep 20260812-110000-2)" "running"
check_contains "stored running + dead window still infers closed" \
  "$(echo "$LIST" | grep 20260812-110000-3)" "closed"
check_contains "dry-run passes through" \
  "$(echo "$LIST" | grep 20260812-110000-4)" "dry-run"
check_absent "vet list never kills anything" "$(cat "$TMUX_STUB_LOG")" "kill-"

echo ""

# ============================================================ rm / resume
echo "rm and resume guards"

reset_stub
printf '@25\n' > "$TMUX_STUB_DIR/live-windows"

# An auto-closed run whose recorded window is the PO's still-open one must be
# removable -- window_exists alone would refuse it forever.
RM_OUT="$("$VET" rm 20260812-110000-1 2>&1)"; RM_RC=$?
check_eq "an auto-closed run is removable despite a live window" "0" "$RM_RC"
check_contains "removal is reported" "$RM_OUT" "vet run removed: 20260812-110000-1"

# A genuinely running run is still protected.
RM_OUT2="$("$VET" rm 20260812-110000-2 2>&1)"; RM_RC2=$?
check_eq "a running run is still refused" "1" "$RM_RC2"
check_contains "refusal explains itself" "$RM_OUT2" "still running"

# resume's guard uses the same rule.
RESUME_OUT="$("$VET" resume --session work 20260812-110000-2 2>&1)"; RESUME_RC=$?
check_eq "resume refuses a genuinely running run" "1" "$RESUME_RC"
check_contains "resume says why" "$RESUME_OUT" "already running"

# The point of run_is_live: an auto-closed run must get PAST that guard even
# though its recorded window is the PO's, still-open one. (It then fails later
# on this fixture's absent prompt files, which is fine -- the guard is what is
# under test.)
write_state_env 20260812-110000-5 closed "@25"
RESUME_OUT2="$("$VET" resume --session work 20260812-110000-5 2>&1)"
check_absent "an auto-closed run is NOT mistaken for a running one" \
  "$RESUME_OUT2" "already running"

check_absent "no kill-window anywhere in the whole suite" "$(cat "$TMUX_STUB_LOG")" "kill-window"

echo ""
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
