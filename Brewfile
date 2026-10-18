# Brewfile - the tools this repository's configuration expects.
#
#   brew bundle
#
# Every block in _zshrc sits behind a `(( $+commands[...] ))` guard, so a
# missing tool is skipped in silence rather than breaking the shell. That is the
# right behaviour and it is also why a fresh machine is confusing: `prefix w`
# does nothing at all instead of saying what it wants. This file is the list
# that makes the silence unnecessary.
#
# NOT here, because brew is the wrong installer for them:
#   claude  - the Claude Code CLI; squad, vet and deck all drive it
#   codex   - squad's Advisor pane and vet's Reviewer B
#   gcalcli - whatdid reads the calendar through it (pipx install gcalcli)

# --- tmux, and what _tmux.conf itself calls -----------------------------------
brew "tmux"
brew "reattach-to-user-namespace"   # _tmux.conf's default-command

# --- what the squad / vet / deck launchers shell out to -----------------------
brew "gh"                           # vet collects PR context through it
brew "jq"
brew "terminal-notifier"            # squad's awaiting-PO desktop notification
brew "poppler"                      # deck rasterizes with pdftoppm / pdfinfo
brew "shellcheck"                   # the four wiring harnesses

# deck's renderer needs node >= 20.11. Skip this line if you manage node with
# nvm or mise - both are already in this setup and either is fine.
brew "node"

# --- navigation: prefix w, prefix f, t ----------------------------------------
brew "fzf"
brew "sesh"
brew "zoxide"

# --- files, history, diffs ----------------------------------------------------
brew "yazi"                         # y / dpng - inline image previews in iTerm2
brew "fd"                           # also what fzf's ctrl-t searches with
brew "bat"
brew "eza"
brew "git-delta"
brew "lazygit"

# deck renders through the INSTALLED Chrome rather than a bundled headless
# build, so that what the geometry linter measures is what a human would see.
cask "google-chrome"
