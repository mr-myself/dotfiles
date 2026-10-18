#!/usr/bin/env bash
set -uo pipefail

# ==============================================================================
# install.sh - link this repository into $HOME
# ==============================================================================
#
#   ./install.sh              link everything
#   ./install.sh --dry-run    print what would happen and change nothing
#
# The symlinks used to live in README as a list to paste by hand, which is fine
# until the list grows a sixth entry and a new machine quietly gets five of
# them. `squad` resolves _vet and _deck relative to its OWN real path, so a
# missing link does not fail loudly - it falls through to a different checklist
# or reports a missing dependency several steps later.
#
# NOTHING here overwrites a real file. A path that already exists and is not a
# symlink into this repository is reported and skipped, so running this on a
# machine with a hand-written ~/.zshrc cannot lose it.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=false
case "${1:-}" in
  --dry-run) DRY_RUN=true ;;
  "") ;;
  *)
    printf 'Usage: %s [--dry-run]\n' "${0##*/}" >&2
    exit 2
    ;;
esac

LINKED=0
KEPT=0
SKIPPED=0

say() { printf '%s\n' "$*"; }

# link <target-in-repo> <link-in-home>
#
# Idempotent: a link already pointing at the right target is left alone and
# counted as "kept", so the common case prints nothing alarming.
link() {
  local target="$REPO/$1" link="$HOME/$2"

  if [[ ! -e "$target" ]]; then
    say "  skip   $2  (nothing at $1 in this repo)"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi

  if [[ -L "$link" ]]; then
    local current
    current="$(readlink "$link")"
    if [[ "$current" == "$target" ]]; then
      KEPT=$((KEPT + 1))
      return 0
    fi
    # A symlink pointing somewhere else is ours to repoint: the thing at risk is
    # a FILE, and this is not one.
    if [[ "$DRY_RUN" == true ]]; then
      say "  repoint $2  ($current -> $target)"
    else
      ln -sfn "$target" "$link" && say "  repoint $2  (was $current)"
    fi
    LINKED=$((LINKED + 1))
    return 0
  fi

  if [[ -e "$link" ]]; then
    say "  KEEP   $2  is a real file, not a link - left untouched"
    say "         move it aside and re-run if you want this repo's version"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi

  if [[ "$DRY_RUN" == true ]]; then
    say "  link   $2 -> $1"
  else
    mkdir -p "$(dirname "$link")"
    ln -sfn "$target" "$link" && say "  link   $2 -> $1"
  fi
  LINKED=$((LINKED + 1))
}

if [[ "$DRY_RUN" == true ]]; then
  say "DRY RUN - nothing will be changed."
  say ""
fi

say "shell and editor"
link _zshrc    .zshrc
link _tmux.conf .tmux.conf
link _vimrc    .vimrc
link _vim      .vim
link _vimrc    .xvimrc
link _vimrc    .ideavimrc

say ""
say "tool configuration"
# squad and vet resolve these relative to the real script path, so a run started
# through ~/.local/bin finds them here and nowhere else.
link _vet   .vet
link _takt  .takt

say ""
say "commands (~/.local/bin)"
link squad              .local/bin/squad
link squad-herdr        .local/bin/squad-herdr
link vet                .local/bin/vet
link deck               .local/bin/deck
link whatdid            .local/bin/whatdid
link tmux-pick-window   .local/bin/tmux-pick-window
link tmux-pick-session  .local/bin/tmux-pick-session
link tmux-main-window   .local/bin/tmux-main-window

say ""
say "linked/repointed: $LINKED   already correct: $KEPT   skipped: $SKIPPED"

if [[ "$DRY_RUN" == true ]]; then
  exit 0
fi

# --- what links cannot do -----------------------------------------------------
#
# Reported rather than performed. Each one either costs real time, needs the
# network, or is a decision about $HOME that this script should not make
# silently.

say ""
say "still to do by hand:"

if ! command -v brew >/dev/null 2>&1; then
  say "  - install Homebrew, then: brew bundle"
elif ! command -v fzf >/dev/null 2>&1 || ! command -v sesh >/dev/null 2>&1; then
  say "  - brew bundle            (prefix w / prefix f / t need fzf and sesh)"
fi

if [[ ! -d "$REPO/_deck/node_modules" ]]; then
  say "  - npm install --prefix '$REPO/_deck'     (deck's renderer)"
fi

if ! command -v claude >/dev/null 2>&1; then
  say "  - install the Claude Code CLI            (squad, vet and deck drive it)"
fi
if ! command -v codex >/dev/null 2>&1; then
  say "  - install codex                          (squad's Advisor, vet's Reviewer B)"
fi

if ! git config --global --get-all include.path 2>/dev/null | grep -qF '_gitconfig.delta'; then
  say "  - delta as git's pager, by adding this to ~/.gitconfig:"
  say "        [include]"
  say "            path = $REPO/_gitconfig.delta"
fi

say ""
say "then: exec zsh, and tmux source-file ~/.tmux.conf in any running tmux."
