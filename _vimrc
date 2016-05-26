filetype off
filetype plugin indent off

set nocompatible
if has('vim_starting')
  set runtimepath+=~/.vim/bundle/neobundle.vim/
endif


" let NeoBundle manage NeoBundle
" required!
call neobundle#begin(expand('~/.vim/bundle/'))

NeoBundle 'Shougo/neobundle.vim'
NeoBundle 'thinca/vim-visualstar'
NeoBundle 'thinca/vim-quickrun.git' "\rで実行
NeoBundle 'Lokaltog/vim-easymotion'
NeoBundle 'tomtom/tcomment_vim'
NeoBundle 'othree/eregex.vim'
NeoBundle 'yanktmp.vim'
NeoBundle 'bling/vim-airline'
NeoBundle 'alpaca-tc/vim-rails'
NeoBundle 'slim-template/vim-slim'
NeoBundle 'digitaltoad/vim-jade'
NeoBundle 'kakkyz81/evervim'
NeoBundle 'thinca/vim-qfreplace.git'
NeoBundle 'thinca/vim-ref' " APIのドキュメントを参照する Shift+K
NeoBundle 'othree/eregex.vim'
NeoBundle "tmhedberg/matchit.git"
NeoBundle "smartchr"
NeoBundle 'repeat.vim'
NeoBundle 'sjl/gundo.vim.git'
NeoBundle 'Lokaltog/vim-powerline.git' " tmuxやscreenでもヤンクをクリップボードへコピー
NeoBundle 'kana/vim-fakeclip.git'
NeoBundle 'rhysd/clever-f.vim' " カーソル移動を加速する
NeoBundle 'rhysd/accelerated-jk.git'
NeoBundle 'fuenor/im_control.vim'
NeoBundle 'terryma/vim-multiple-cursors.git'
NeoBundle 'airblade/vim-gitgutter'
NeoBundle "sudar/vim-arduino-syntax"
NeoBundle 'Shougo/neocomplete.vim'

" Javascript
NeoBundle 'pangloss/vim-javascript.git'
NeoBundle 'open-browser.vim'
NeoBundle 'mattn/webapi-vim'
NeoBundle 'tell-k/vim-browsereload-mac'
NeoBundle 'hail2u/vim-css3-syntax'
NeoBundle 'jiangmiao/simple-javascript-indenter'
NeoBundle 'jQuery.git'
NeoBundle 'jelera/vim-javascript-syntax.git'
NeoBundle "YankRing.vim"
NeoBundle 'kchmck/vim-coffee-script' " CofeeScript syntax + 自動compile
" color shcheme
NeoBundle 'ujihisa/unite-colorscheme'
NeoBundle 'ujihisa/unite-font'
NeoBundle 'tomasr/molokai'

NeoBundle 'Shougo/vimproc', {
      \     'build': {
      \        'windows': 'make_mingw64.mak',
      \        'unix': 'make -f make_unix.mak',
      \        'mac': 'make -f make_mac.mak'
      \     }
      \   }


" Ruby
NeoBundle 'vim-ruby/vim-ruby.git'
NeoBundle 'tpope/vim-rbenv.git'
NeoBundle 'tpope/vim-endwise' "endを自動入力
NeoBundle 'kmnk/vim-unite-giti.git'
NeoBundle 'tsukkee/unite-tag.git'
NeoBundle 'h1mesuke/unite-outline'

" NeoBundle 'Shougo/vimfiler.git'
NeoBundle 'Shougo/vimfiler',  '',  'default'
call neobundle#config('vimfiler',  {
      \ 'lazy' : 1,
      \ 'depends' : 'Shougo/unite.vim',
      \ 'autoload' : {
      \    'commands' : [
      \                  { 'name' : 'VimFiler',
      \                    'complete' : 'customlist, vimfiler#complete' },
      \                  { 'name' : 'VimFilerExplorer',
      \                    'complete' : 'customlist, vimfiler#complete' },
      \                  { 'name' : 'Edit',
      \                    'complete' : 'customlist, vimfiler#complete' },
      \                  { 'name' : 'Write',
      \                    'complete' : 'customlist, vimfiler#complete' },
      \                  'Read',  'Source'],
      \    'mappings' : ['<Plug>(vimfiler_switch)'],
      \    'explorer' : 1,
      \ }
      \ })
NeoBundleLazy 'Shougo/vimshell', {
\   'autoload' : { 'commands' : [ 'VimShell' ] },
\   'depends': [ 'Shougo/vimproc' ],
\ }
NeoBundle 'Shougo/unite.vim',  '',  'default'
call neobundle#config('unite.vim', {
      \ 'lazy' : 1,
      \ 'autoload' : {
      \   'commands' : [{ 'name' : 'Unite',
      \                   'complete' : 'customlist, unite#complete_source'},
      \                 'UniteWithCursorWord',  'UniteWithInput']
      \ }})


call neobundle#end()


let g:evervim_devtoken='S=s77:U=81fc4e:E=1521b35992a:C=14ac3846b38:P=1cd:A=en-devtoken:V=2:H=fa7856e10da89a7f422725f5b141653f'
let g:airline_powerline_fonts = 1

filetype plugin on

syntax on
set title
set encoding=utf-8
set fileencodings=ucs-bom,utf-8,iso-2022-jp,sjis,cp932,euc-jp,cp20932
set fileformats=unix,dos,mac
set wrapscan
set ruler
set tabstop=2
set autoindent
set showmode
set number
set expandtab
set runtimepath+=/home/homepage/.vim/plugin/
set backspace=2
highlight Comment ctermfg=DarkCyan

map ,ptv :'<,'>! perltidy

inoremap <C-j> <Down>
inoremap <C-k> <Up>
inoremap <C-h> <Left>
inoremap <C-l> <Right>

nnoremap sy :call YanktmpYank()<CR>
nnoremap sp :call YanktmpPaste_p()<CR>
nnoremap sP :call YanktmpPaste_P()<CR>

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

" JS支援
let g:html_indent_inctags  = "html, body, head, tbody"
let g:html_indent_autotags = "th, td, tr, tfoot, thead"
let g:html_indent_script1  = "inc"
let g:html_indent_style1   = "inc"
"autocmd BufWritePost *.coffee silent make! -cb |$ cwindow | redraw!
autocmd QuickFixCmdPost * nested cwindow | redraw!

nnoremap / :M/

" ヤンクを辿れるようにする
let g:yankring_manual_clipboard_check = 0
let g:yankring_max_history            = 30
let g:yankring_max_display            = 70
" Yankの履歴参照
nmap ,y :YRShow<CR>

" for quickrun.vim
let g:quickrun_config            = {}
let g:quickrun_config.objc       = {
      \   'command': 'clang',
      \   'exec': ['%c %s -o %s:p:r -framework Foundation', '%s:p:r %a', 'rm -f %s:p:r'],
      \   'tempfile': '{tempname()}.m',
      \ }
let g:quickrun_config.processing = {
      \   'command': 'processing-java',
      \   'exec': '%c --sketch     = $PWD/ --output = /Library/Processing --run --force',
      \ }
let g:quickrun_config.markdown   = {
      \   'outputter' : 'null',
      \   'command'   : 'open',
      \   'exec'      : '%c %s',
      \ }
let g:quickrun_config.coffee     = {
      \   'command' : 'coffee',
      \   'exec' : ['%c -cbp %s']
      \ }

" for neocomplete
let g:neocomplete#enable_at_startup = 1

" inoremap <expr> = smartchr#loop(' = ', ' => ', '=', ' == ')
inoremap <expr> , smartchr#one_of(', ', ',')

" Ruby環境
au BufNewFile, BufRead Gemfile setl filetype = Gemfile
au BufWritePost Gemfile call vimproc#system('rbenv ctags')

" undo treeを表示する
nnoremap U      :<C-u>GundoToggle<CR>

" ステータスラインをかっこ良く
let g:Powerline_symbols='fancy'

let g:accelerated_jk_acceleration_table = [10,5,3]

"<C-^>でIM制御が行える場合の設定
let IM_CtrlMode = 4
""ctrl+iで日本語入力固定モードをOnOff
inoremap <silent> <C-i> <C-^><C-r>=IMState('FixMode')<CR>


set completeopt-=preview
autocmd BufEnter *
            \   if empty(&buftype)
            \|      nnoremap <buffer> <C-]> :<C-u>UniteWithCursorWord -immediately tag<CR>
            \|  endif

let s:bundle = neobundle#get('vimfiler')
function! s:bundle.hooks.on_source(bundle)
  let g:vimfiler_as_default_explorer = 1
  let g:vimfiler_safe_mode_by_default = 0
endfunction
nnoremap ,vf :VimFiler -split -simple -winwidth=35 -no-quit<CR>
autocmd FileType vimfiler
        \ nnoremap <buffer><silent>/
        \ :<C-u>Unite file -default-action=vimfiler<CR>

let s:bundle = neobundle#get('vimshell')
function! s:bundle.hooks.on_source(bundle)
endfunction
nnoremap ,vs :VimShell<CR>

let s:bundle = neobundle#get('unite.vim')
function! s:bundle.hooks.on_source(bundle)
  let g:unite_update_time = 1000
  let g:unite_enable_start_insert=1
  let g:unite_source_file_mru_filename_format = ''
  let g:unite_source_grep_default_opts = "-Hn --color=never"
  let g:loaded_unite_source_bookmark = 1
  let g:loaded_unite_source_tab = 1
  let g:loaded_unite_source_window = 1
  " the silver searcher を unite-grep のバックエンドにする
  if executable('ag')
    let g:unite_source_grep_command = 'ag'
    let g:unite_source_grep_default_opts = '--nocolor --nogroup --column'
    let g:unite_source_grep_recursive_opt = ''
    let g:unite_source_grep_max_candidates = 200
  endif

  " ウィンドウを分割して開く
  au FileType unite nnoremap <silent> <buffer> <expr> <C-j> unite#do_action('split')
  au FileType unite inoremap <silent> <buffer> <expr> <C-j> unite#do_action('split')
  " ウィンドウを縦に分割して開く
  au FileType unite nnoremap <silent> <buffer> <expr> <C-l> unite#do_action('vsplit')
  au FileType unite inoremap <silent> <buffer> <expr> <C-l> unite#do_action('vsplit')
  au FileType unite nnoremap <silent> <buffer> <ESC><ESC> q
  au FileType unite inoremap <silent> <buffer> <ESC><ESC> <ESC>q

  autocmd FileType unite call s:unite_my_settings()
  function! s:unite_my_settings()
    " Overwrite settings.
    imap <buffer> jj <Plug>(unite_insert_leave)
    imap <buffer> <ESC> <ESC><ESC>
    imap <buffer> <C-w> <Plug>(unite_delete_backward_path)
    nnoremap <buffer> t G
    startinsert
  endfunction
  call unite#custom_default_action('source/bookmark/directory', 'vimfiler')
endfunction

" Disable AutoComplPop.
let g:acp_enableAtStartup = 0

" Enable omni completion.
autocmd FileType css setlocal omnifunc=csscomplete#CompleteCSS
autocmd FileType html,markdown setlocal omnifunc=htmlcomplete#CompleteTags
autocmd FileType javascript setlocal omnifunc=javascriptcomplete#CompleteJS
autocmd FileType xml setlocal omnifunc=xmlcomplete#CompleteTags

" Enable heavy omni completion.
if !exists('g:neocomplcache_omni_patterns')
  let g:neocomplcache_omni_patterns = {}
endif
let g:neocomplcache_omni_patterns.perl = '\h\w*->\h\w*|\h\w*::'

" <TAB>: completion.
imap <expr><TAB> "\<TAB>"
smap <expr><TAB> "\<TAB>"
inoremap <expr><S-TAB>  pumvisible() ? "\<C-p>" : "\<S-TAB>"

" For snippet_complete marker.
if has('conceal')
  set conceallevel=2 concealcursor=i
endif

" ctags
let g:neocomplcache_ctags_arguments_list = {
  \ 'perl' : '-R -h ".pm"',
  \ }

"--------------------------------------------------------------------------
" BasicSetting
"--------------------------------------------------------------------------
" ファイル名と内容をもとにファイルタイププラグインを有効にする
filetype plugin indent on
" ハイライトON
syntax on
" 認識されないっぽいファイルタイプを追加
au BufNewFile,BufRead *.psgi       set filetype=perl
au BufNewFile,BufRead *.t          set filetype=perl
au BufNewFile,BufRead *.ejs        set filetype=html
au BufNewFile,BufRead *.ep         set filetype=html
au BufNewFile,BufRead *.pde        set filetype=processing
au BufNewFile,BufRead *.erb        set filetype=html
au BufNewFile,BufRead *.tt         set filetype=html
au BufNewFile,BufRead *.tt2        set filetype=html
au BufNewFile,BufRead *.scss       set filetype=scss
au BufNewFile,BufRead *.sass       set filetype=sass
au BufNewFile,BufRead cpanfile     set filetype=cpanfile
au BufNewFile,BufRead cpanfile     set syntax=perl.cpanfile
au BufRead, BufNewFile jquery.*.js set ft=javascript syntax=jquery

" ファイルエンコーディング
set fileencodings=ucs-bom,utf-8,iso-2022-jp,sjis,cp932,euc-jp,cp20932
set encoding=utf-8
" 未保存のバッファでも裏に保持
set hidden
" コマンドラインでの補完候補が表示されるようになる
set wildmenu
" コマンドをステータス行に表示
set showcmd
" 検索語を強調表示
set hlsearch
" 検索時に大文字・小文字を区別しない。ただし、検索後に大文字小文字が
" 混在しているときは区別する
set ignorecase
set smartcase
" オートインデント
set autoindent
set smartindent

" 画面最下行にルーラーを表示する
set ruler

" ステータスラインを常に表示する
set laststatus=2

" Ctrl+eキーで'paste'と'nopaste'を切り替える
set pastetoggle=<C-e>

set cindent
set tabstop=2
set shiftwidth=4
autocmd FileType apache     setlocal sw=4 sts=4 ts=4 et
autocmd FileType aspvbs     setlocal sw=4 sts=4 ts=4 et
autocmd FileType c          setlocal sw=4 sts=4 ts=4 et
autocmd FileType cpp        setlocal sw=4 sts=4 ts=4 et
autocmd FileType cs         setlocal sw=4 sts=4 ts=4 et
autocmd FileType scss       setlocal sw=2 sts=2 ts=2 et
autocmd FileType sass       setlocal sw=2 sts=2 ts=2 et
autocmd FileType css        setlocal sw=2 sts=2 ts=2 et
autocmd FileType diff       setlocal sw=4 sts=4 ts=4 et
autocmd FileType eruby      setlocal sw=2 sts=2 ts=2 et
autocmd FileType html       setlocal sw=2 sts=2 ts=2 et
autocmd FileType slim       setlocal sw=2 sts=2 ts=2 et
autocmd FileType java       setlocal sw=4 sts=4 ts=4 et
autocmd FileType javascript setlocal sw=4 sts=4 ts=4 et
autocmd FileType json       setlocal sw=2 sts=2 ts=2 et
autocmd FileType jade       setlocal sw=2 sts=2 ts=2 et
autocmd FileType coffee     setlocal sw=2 sts=2 ts=2 et
autocmd FileType perl       setlocal sw=4 sts=4 ts=4 et
autocmd FileType php        setlocal sw=4 sts=4 ts=4 et
autocmd FileType python     setlocal sw=4 sts=4 ts=4 et
autocmd FileType ruby       setlocal sw=2 sts=2 ts=2 et
autocmd FileType haml       setlocal sw=2 sts=2 ts=2 et
autocmd FileType sh         setlocal sw=4 sts=4 ts=4 et
autocmd FileType sql        setlocal sw=4 sts=4 ts=4 et
autocmd FileType vb         setlocal sw=4 sts=4 ts=4 et
autocmd FileType vim        setlocal sw=2 sts=2 ts=2 et
autocmd FileType wsh        setlocal sw=4 sts=4 ts=4 et
autocmd FileType xhtml      setlocal sw=2 sts=2 ts=2 et
autocmd FileType xml        setlocal sw=4 sts=4 ts=4 et
autocmd FileType yaml       setlocal sw=2 sts=2 ts=2 et
autocmd FileType zsh        setlocal sw=4 sts=4 ts=4 et
autocmd FileType scala      setlocal sw=2 sts=2 ts=2 et
autocmd FileType scheme     setlocal sw=2 sts=2 ts=2 et

set autoread
set expandtab
set cmdheight=2
set showmode                     " 現在のモードを表示
set modelines=0                  " モードラインは無効
set showmatch
set number
set list
set listchars=tab:»-,trail:-,nbsp:%
set display=uhex
set t_Co=256

" 全角スペースの表示
highlight ZenkakuSpace cterm=underline ctermfg=lightblue guibg=darkgray
match ZenkakuSpace /　/

" カーソル行をハイライト
set cursorline
" カレントウィンドウにのみ罫線を引く
augroup cch
  autocmd! cch
  autocmd WinLeave * set nocursorline
  autocmd WinEnter,BufRead * set cursorline
augroup END

hi clear CursorLine
hi CursorLine gui=underline
highlight CursorLine ctermbg=black guibg=black

" コマンド実行中は再描画しない
set lazyredraw

nnoremap <ESC><ESC> :nohlsearch<CR><ESC>
noremap ; :
noremap : ;

" 保存時に行末の空白を除去する
autocmd BufWritePre * :%s/\s\+$//ge
" 保存時にtabをスペースに変換する
autocmd BufWritePre * :%s/\t/    /ge

" ファイルを開いた時に最後のカーソル位置を再現する
au BufReadPost * if line("'\"") > 1 && line("'\"") <= line("$") | exe "normal! g`\"" | endif

" 無限undo
if has('persistent_undo')
  set undodir=~/.vim/undo
  set undofile
endif

" OSのクリップボードを使用する
" set clipboard=unnamed
set clipboard+=unnamedplus,unnamed

" ターミナルでマウスを使用できるようにする
set mouse=a
set guioptions+=a
set ttymouse=xterm2

" .vimrcを瞬時に開く
nnoremap <Space><Space>. :e $MYVIMRC<CR>

" vimrcの設定を反映
nnoremap <Space><Space>.. :<C-u>source $MYVIMRC<CR>

" 念の為C-cでEsc
inoremap <C-c> <Esc>

" ヘルプを3倍の速度で引く
nnoremap <C-h>  :<C-u>help<Space><C-r><C-w><CR>

" ヘルプを日本語に
set helplang=ja

" カーソル下の単語を置換
nnoremap g/ :<C-u>%s/<C-R><C-w>//gc<Left><Left><Left>

" ビジュアルモードで選択した部分を置換
vnoremap g/ y:<C-u>%s/<C-R>"//gc<Left><Left><Left>

" バックアップを取らない
set nobackup
colorscheme molokai
