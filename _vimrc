set nocompatible
filetype off
filetype plugin indent off

if has('vim_starting')
  set runtimepath+=~/.vim/bundle/neobundle.vim/
  call neobundle#rc(expand('~/.vim/bundle/'))
endif
" let NeoBundle manage NeoBundle
" required!
NeoBundle 'Shougo/neobundle.vim'
"NeoBundle 'Shougo/neocomplcache' "補完機能
NeoBundle 'thinca/vim-visualstar'
NeoBundle 'Shougo/vimproc' "非同期実行
NeoBundle 'Shougo/vimshell'
NeoBundle 'Shougo/unite.vim'
NeoBundle 'git://github.com/thinca/vim-quickrun.git' "\rで実行
NeoBundle 'Lokaltog/vim-easymotion'
NeoBundle 'tomtom/tcomment_vim'
NeoBundle 'molokai' "カラースキーマ名

filetype plugin on

syntax on
"colorscheme desert
"colorscheme autumn
set title
set encoding=utf-8
set fileencodings=utf-8,sjis,iso-2022-jp,euc-jp
set fileformats=unix,dos,mac
set wrapscan
set ruler
set tabstop=4
"set textwidth=0
set autoindent
set showmode
set number
set expandtab
set runtimepath+=/home/homepage/.vim/plugin/
set backspace=2
"set formatoptions=q
highlight Comment ctermfg=DarkCyan
"setlocal formatoptions-=r " 挿入モードで改行した時に # を自動挿入しない
"setlocal formatoptions-=o " 挿入モードで改行した時に # を自動挿入しない

"neocomplecacheを有効化
let g:neocomplcache_enable_at_startup = 1

"RSense
let g:rsenseHome = "/home/homepage/rsense-0.3"
let g:rsenseUseOmniFunc = 1

noremap ; :
noremap : ;

" 保存時に行末の空白を除去する
autocmd BufWritePre * :%s/\s\+$//ge
" 保存時にtabをスペースに変換する
"autocmd BufWritePre * :%s/\t/    /ge

inoremap <C-j> <Down>
inoremap <C-k> <Up>
inoremap <C-h> <Left>
inoremap <C-l> <Right>

" OS依存
" OSのクリップボードを使用する
set clipboard+=unnamed
" ターミナルでマウスを使用できるようにする
set mouse=a
set guioptions+=a
set ttymouse=xterm2

" ヤンクした文字は、システムのクリップボードに入れる
set clipboard=unnamed

" rubyファイル設定
autocmd BufNewFile *.rb 0r $HOME/.vim/template/ruby-script.txt

" perl用の設定
augroup filetypedetect
autocmd! BufNewFile,BufRead *.t setf perl
autocmd! BufNewFile,BufRead *.psgi setf perl
autocmd! BufNewFile,BufRead *.tt setf tt2html
augroup END

autocmd BufNewFile *.pl 0r $HOME/.vim/template/perl-script.txt
autocmd BufNewFile *.t  0r $HOME/.vim/template/perl-test.txt

function! s:get_package_name()
    let mx = '^\s*package\s\+\([^ ;]\+\)'
    for line in getline(1, 5)
        if line =~ mx
        return substitute(matchstr(line, mx), mx, '\1', '')
        endif
    endfor
    return ""
endfunction

" パッケージ名の自動チェック(perl用)
function! s:check_package_name()
    let path = substitute(expand('%:p'), '\\', '/', 'g')
    let name = substitute(s:get_package_name(), '::', '/', 'g') . '.pm'
    if path[-len(name):] != name
        echohl WarningMsg
        echomsg "ぱっけーじめいと、ほぞんされているぱすが、ちがうきがします！"
        echomsg "ちゃんとなおしてください＞＜"
        echohl None
    endif
endfunction

au! BufWritePost *.pm call s:check_package_name()
