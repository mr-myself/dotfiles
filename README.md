## About 'vimrc'
If you update your vimrc, you need to execute the following command ":NeoBundleInstall"

## Symlink Commands

tmux
- ln -s ~/dotfiles/_tmux.conf ~/.tmux.conf

vim
- ln -s ~/dotfiles/_vimrc ~/.vimrc
- ln -s ~/dotfiles/_vim ~/.vim
- ln -s ~/dotfiles/_vimrc ~/.xvimrc
- ln -s ~/dotfiles/_vimrc ~/.ideavimrc

zsh
- ln -s ~/dotfiles/_zshrc ~/.zshrc

local bin
- mkdir -p ~/.local/bin

takt (global)
- ln -s ~/mr-myself/setup/dotfiles/_takt ~/.takt

takt (per-project)
- ln -s ~/mr-myself/setup/dotfiles/_takt/projects/track-manager ~/mr-myself/organization/xmile/track-manager/.takt

vet (review checklist)
- ln -s ~/mr-myself/setup/dotfiles/_vet ~/.vet

squad
- ln -s ~/mr-myself/setup/dotfiles/squad ~/.local/bin/squad
- ln -s ~/mr-myself/setup/dotfiles/squad-herdr ~/.local/bin/squad-herdr   # FROZEN, see below

vet
- ln -s ~/mr-myself/setup/dotfiles/vet ~/.local/bin/vet

whatdid
- ln -s ~/mr-myself/setup/dotfiles/whatdid ~/.local/bin/whatdid

deck
- ln -s ~/mr-myself/setup/dotfiles/deck ~/.local/bin/deck
- npm install --prefix ~/mr-myself/setup/dotfiles/_deck
- then: deck "資料のタイトル"   (the agent asks you for the rest)

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

## And more
I recommend you to use 'oh-my-zsh'!
https://github.com/robbyrussell/oh-my-zsh
