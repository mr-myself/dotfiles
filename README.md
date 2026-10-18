## Setting up a machine

```sh
git clone git@github.com:mr-myself/dotfiles.git ~/mr-myself/setup/dotfiles
cd ~/mr-myself/setup/dotfiles

brew bundle                  # the tools the configuration expects
./install.sh                 # link this repo into $HOME
npm install --prefix _deck   # deck's renderer
```

`./install.sh --dry-run` prints what it would do and changes nothing. It never
overwrites a real file: a path that already exists and is not a link into this
repo is reported and skipped, so a hand-written `~/.zshrc` is safe.

Then `exec zsh`, and in any tmux that is already running,
`tmux source-file ~/.tmux.conf`.

### What install.sh cannot do for you

It reports these at the end rather than doing them, because each one needs the
network or is a decision about `$HOME`:

- **The Claude Code CLI and `codex`.** squad, vet and deck all drive `claude`;
  squad's Advisor pane and vet's Reviewer B are `codex`. Neither installs
  through brew.
- **`gcalcli`** for `whatdid`'s calendar source: `pipx install gcalcli`.
- **delta as git's pager.** `_gitconfig.delta` holds the settings; add it to
  `~/.gitconfig` yourself:

  ```ini
  [include]
      path = /Users/<you>/mr-myself/setup/dotfiles/_gitconfig.delta
  ```

  The whole `.gitconfig` is deliberately NOT in this repo: it carries an email
  address and the paths of private repositories in its `safe.directory`
  entries, and this repo is public.

Nothing in `_zshrc` fails when a tool is missing - every block is behind a
`(( $+commands[...] ))` guard. That is why a half-installed machine is quiet
rather than broken, and also why `brew bundle` matters: without fzf and sesh,
`prefix w` and `t` simply do nothing instead of saying what they want.

### vimrc

If you update `_vimrc`, run `:NeoBundleInstall` in vim.

### Per-project takt

`install.sh` links the global `~/.takt`. A project that needs its own:

```sh
ln -s ~/mr-myself/setup/dotfiles/_takt/projects/track-manager \
      ~/mr-myself/organization/xmile/track-manager/.takt
```

## The commands

| command | what it does |
| --- | --- |
| `squad <task>` | A git worktree plus three AI agents in tmux panes: Manager and Coder (Claude Code), Advisor (Codex). Gated on RuboCop and Brakeman. |
| `vet <pr>` | Reviews a GitHub PR with two independent read-only reviewers and writes one `report.html`. Never edits code, never posts. |
| `deck <title>` | One agent interviews you in Japanese, writes the storyboard itself, and gates the result on measured geometry. |
| `whatdid [date]` | Collects what you did from git, squad, Claude logs, reviews and the calendar. |
| `t` | Pick a tmux session by name (running sessions, sesh projects, zoxide history). Outside tmux. |
| `prefix w` | Pick any window in any session. squad and deck name their windows after the run, so this is the index of work in flight. |
| `prefix C` | A new window in the MAIN repository rather than the squad worktree the pane is in. |
| `main` | The same jump, in the current shell. |
| `ctrl-g` | Jump to any project directory by name. `proj-dirs` is the candidate list - fzf's own default walks $HOME and never finishes here. |
| `deck check` | Open a rendered deck's PDF. |

Run any of them with `--help`.

## Tests

Four wiring harnesses assert the surface that squad, vet and deck *generate* -
Manager prompts, per-lens checklists, gates, helper scripts - and they are what
stands between a one-character edit to a 4,800-line generator and a squad that
silently reviews the wrong diff.

```sh
./test-squad-wiring.sh
./test-vet-wiring.sh
./test-vet-autoclose.sh
./test-deck-wiring.sh
npm test --prefix _deck     # the geometry fixtures, against real Chrome
```

`.github/workflows/harness.yml` runs all of it on every push, on macOS runners
because these are macOS tools.

## squad-herdr is FROZEN

`squad` on tmux is the one that is used. `squad-herdr` was the same pipeline
ported onto Herdr agents; Herdr lost to iTerm in practice and the port is no
longer run.

**It is kept, not maintained.** The two scripts share no code, so every change
to squad's pipeline used to have to be made twice, and that second edit is what
the freeze removes:

- A change to `squad` is NOT ported to `squad-herdr`. Let them diverge.
- The parity assertions in `test-squad-wiring.sh` (the "squad and squad-herdr
  generate an identical ..." block) are the only thing that still ties them
  together. When one of them fails because squad moved on, DELETE that
  assertion - do not change squad to keep the port happy.
- Nothing new is built on it. If Herdr ever comes back, start from today's
  `squad` rather than from this file.
