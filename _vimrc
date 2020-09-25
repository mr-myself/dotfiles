if &compatible
  set nocompatible
endif

"dein.vimのディレクトリ
let s:dein_dir = expand('~/.cache/dein')
let s:dein_repo_dir = s:dein_dir . '/repos/github.com/Shougo/dein.vim'

" なければgit clone
if !isdirectory(s:dein_repo_dir)
  execute '!git clone https://github.com/Shougo/dein.vim' s:dein_repo_dir
endif
execute 'set runtimepath^=' . s:dein_repo_dir

if dein#load_state(s:dein_dir)
  call dein#begin(s:dein_dir)

  call dein#add('Shougo/dein.vim')
  call dein#add('Shougo/vimproc.vim', {'build' : 'make'})

  " below plugins should be loading from dein.toml
  call dein#add('thinca/vim-visualstar')
  call dein#add('thinca/vim-quickrun.git')
  call dein#add('Lokaltog/vim-easymotion')
  call dein#add('tomtom/tcomment_vim')
  call dein#add('othree/eregex.vim')
  call dein#add('vim-scripts/yanktmp.vim')
  call dein#add('bling/vim-airline')
  " call dein#add('alpaca-tc/vim-rails')
  call dein#add('slim-template/vim-slim')
  call dein#add('yosssi/vim-ace')
  call dein#add('digitaltoad/vim-jade')
  "call dein#add('kakkyz81/evervim')
  call dein#add('thinca/vim-qfreplace.git')
  call dein#add('thinca/vim-ref')
  call dein#add('othree/eregex.vim')
  call dein#add("tmhedberg/matchit.git")
  call dein#add('vim-scripts/repeat.vim')
  call dein#add('sjl/gundo.vim.git')
  call dein#add('Lokaltog/vim-powerline.git')
  call dein#add('kana/vim-fakeclip.git')
  call dein#add('rhysd/clever-f.vim')
  call dein#add('rhysd/accelerated-jk.git')
  call dein#add('fuenor/im_control.vim')
  call dein#add('terryma/vim-multiple-cursors.git')
  call dein#add('airblade/vim-gitgutter')
  call dein#add('sudar/vim-arduino-syntax')
  call dein#add('Shougo/vimshell')
  call dein#add('leafgarland/typescript-vim')

  " below plugins should be loading from dein_lazy.toml
  call dein#add('pangloss/vim-javascript.git')
  call dein#add('vim-scripts/open-browser.vim')
  call dein#add('mattn/webapi-vim')
  call dein#add('tell-k/vim-browsereload-mac')
  call dein#add('hail2u/vim-css3-syntax')
  call dein#add('jiangmiao/simple-javascript-indenter')
  call dein#add('vim-scripts/jQuery.git')
  call dein#add('jelera/vim-javascript-syntax.git')
  call dein#add('leafgarland/typescript-vim.git')
  call dein#add('Shougo/neosnippet-snippets')
  call dein#add('vim-scripts/YankRing.vim')
  call dein#add('kchmck/vim-coffee-script')
  call dein#add('posva/vim-vue')
  call dein#add('jason0x43/vim-js-indent')

  call dein#add('vim-ruby/vim-ruby.git')
  call dein#add('tpope/vim-rbenv.git')
  call dein#add('tpope/vim-endwise.git')
  call dein#add('kmnk/vim-unite-giti.git')
  call dein#add('fatih/vim-go.git')
  call dein#add('fatih/vim-go')
  call dein#add('AndrewRadev/splitjoin.vim')
  call dein#add('elixir-lang/vim-elixir')
  call dein#add('vim-syntastic/syntastic.git')
  call dein#add('neomake/neomake')

  call dein#add('Shougo/neosnippet')
  call dein#add('kazuph/snipmate-snippets.git')
  call dein#add('tsukkee/unite-tag.git')
  call dein#add('h1mesuke/unite-outline')
  call dein#add('Shougo/vimfiler')
  call dein#add('Shougo/unite.vim')

  call dein#add('tomasr/molokai')

  "let g:rc_dir    = expand('~/.vim/rc')
  "let s:toml      = g:rc_dir . '/dein.toml'
  "let s:lazy_toml = g:rc_dir . '/dein_lazy.toml'

  ""TOML を読み込み、キャッシュしておく
  "call dein#load_toml(s:toml,      {'lazy': 0})
  "call dein#load_toml(s:lazy_toml, {'lazy': 1})

  call dein#end()
  call dein#save_state()
endif

call dein#add('roxma/nvim-yarp')
call dein#add('roxma/vim-hug-neovim-rpc')
call dein#add('Shougo/deoplete.nvim')
call dein#add('deoplete-plugins/deoplete-go', {'build': 'make'})

" deoplete for Ruby
call dein#add('uplus/deoplete-solargraph')
call dein#add('fishbullet/deoplete-ruby')
call dein#add('osyo-manga/vim-monster')
let g:monster#completion#rcodetools#backend = "async_rct_complete"
let g:deoplete#sources#omni#input_patterns = {
      \ "ruby" : '[^. *\t]\.\w*\|\h\w*::',
      \}
let g:monster#completion#backend = 'solargraph' " gem install solargraph

if dein#check_install()
  call dein#install()
endif

syntax enable

filetype off
filetype plugin indent off

set nocompatible


let g:evervim_devtoken='S=s77:U=81fc4e:E=1521b35992a:C=14ac3846b38:P=1cd:A=en-devtoken:V=2:H=fa7856e10da89a7f422725f5b141653f'
let g:airline_powerline_fonts = 1
"
" Javascript
let g:html_indent_inctags  = "html, body, head, tbody"
let g:html_indent_autotags = "th, td, tr, tfoot, thead"
let g:html_indent_script1  = "inc"
let g:html_indent_style1   = "inc"
autocmd QuickFixCmdPost * nested cwindow | redraw!

let g:yankring_manual_clipboard_check = 0
let g:yankring_max_history            = 30
let g:yankring_max_display            = 70
nnoremap ,y :YRShow<CR>

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


" undo treeを表示する
nnoremap U      :<C-u>GundoToggle<CR>

let g:Powerline_symbols='fancy' " Status Line
let g:accelerated_jk_acceleration_table = [10,5,3]

"<C-^>でIM制御が行える場合の設定
let IM_CtrlMode = 4

set completeopt-=preview
autocmd BufEnter *
            \   if empty(&buftype)
            \|      nnoremap <buffer> <C-]> :<C-u>UniteWithCursorWord -immediately tag<CR>
            \|  endif

nnoremap ,vf :VimFiler -split -simple -winwidth=35 -no-quit<CR>

nnoremap ,vs :VimShell<CR>


" Disable AutoComplPop.
let g:acp_enableAtStartup = 0

" For snippet_complete marker.
if has('conceal')
  set conceallevel=2 concealcursor=i
endif

" Use deoplete.
let g:deoplete#enable_at_startup = 1
set runtimepath+=~/.cache/dein/repos/github.com/roxma/vim-hug-neovim-rpc/
set runtimepath+=~/.cache/dein/repos/github.com/roxma/nvim-yarp/
set runtimepath+=~/.cache/dein/repos/github.com/Shougo/deoplete.nvim/
call deoplete#custom#option('omni_patterns', {
      \ 'go': '[^. *\t]\.\w*',
      \ 'rb': '[^. *\t]\.\w*'
      \})

"--------------
" BasicSetting
"--------------
filetype plugin indent on
syntax on

set fileencodings=ucs-bom,utf-8,iso-2022-jp,sjis,cp932,euc-jp,cp20932
set encoding=utf-8
set hidden
set wildmenu
set showcmd
set hlsearch
set ignorecase
set smartcase
set autoindent
set smartindent
set ruler
set laststatus=2
set pastetoggle=<C-e> " Ctrl+eキーで'paste'と'nopaste'を切り替える
set cindent
set tabstop=2
set shiftwidth=4
set autoread
set expandtab
set cmdheight=2
set showmode    " 現在のモードを表示
set modelines=0 " モードラインは無効
set showmatch
set number
set list
set listchars=tab:»-,trail:-,nbsp:%
set display=uhex
set t_Co=256
set cursorline
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
set mouse=a " ターミナルでマウスを使用できるようにする
set guioptions+=a
set ttymouse=xterm2
"set clipboard+=unnamed,unnamedplus " set clipboard=unnamed
set lazyredraw
set nobackup
set helplang=ja
set autowrite

if $TMUX == ''
  set clipboard+=unnamed,unnamedplus
end

highlight Comment ctermfg=DarkCyan

inoremap <C-j> <Down>
inoremap <C-k> <Up>
inoremap <C-h> <Left>
inoremap <C-l> <Right>
inoremap <C-c> <Esc>
"ctrl+iで日本語入力固定モードをOnOff
inoremap <silent> <C-i> <C-^><C-r>=IMState('FixMode')<CR>
imap <expr><TAB> "\<TAB>"
smap <expr><TAB> "\<TAB>"
inoremap <expr><S-TAB>  pumvisible() ? "\<C-p>" : "\<S-TAB>"

nnoremap sy :call YanktmpYank()<CR>
nnoremap sp :call YanktmpPaste_p()<CR>
nnoremap sP :call YanktmpPaste_P()<CR>

nnoremap <ESC><ESC> :nohlsearch<CR><ESC>
noremap ; :
noremap : ;

" Open .vimrc
nnoremap <Space><Space>. :e $MYVIMRC<CR>

" vimrcの設定を反映
nnoremap <Space><Space>.. :<C-u>source $MYVIMRC<CR>

" Fast Help
nnoremap <C-h>  :<C-u>help<Space><C-r><C-w><CR>

" Replacing
nnoremap g/ :<C-u>%s/<C-R><C-w>//gc<Left><Left><Left>
vnoremap g/ y:<C-u>%s/<C-R>"//gc<Left><Left><Left>

" eregex
"nnoremap / :M/


" 認識されないっぽいファイルタイプを追加
au BufNewFile,BufRead *.psgi       set filetype=perl
au BufNewFile,BufRead *.t          set filetype=perl
au BufNewFile,BufRead *.ejs        set filetype=html
au BufNewFile,BufRead *.ep         set filetype=html
au BufNewFile,BufRead *.pde        set filetype=processing
au BufNewFile,BufRead *.erb        set filetype=html
au BufNewFile,BufRead *.tt         set filetype=html
au BufNewFile,BufRead *.tt2        set filetype=html
au BufNewFile,BufRead *.tmpl       set filetype=html
au BufNewFile,BufRead *.scss       set filetype=scss
au BufNewFile,BufRead *.sass       set filetype=sass
au BufNewFile,BufRead cpanfile     set filetype=cpanfile
au BufNewFile,BufRead cpanfile     set syntax=perl.cpanfile
au BufRead, BufNewFile jquery.*.js set ft=javascript syntax=jquery

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
autocmd FileType javascript setlocal sw=2 sts=2 ts=2 et
autocmd FileType vue        setlocal sw=2 sts=2 ts=2 et
autocmd FileType jsx        setlocal sw=2 sts=2 ts=2 et
autocmd FileType tsx        setlocal sw=2 sts=2 ts=2 et
autocmd FileType ts         setlocal sw=2 sts=2 ts=2 et
autocmd FileType json       setlocal sw=4 sts=4 ts=4 et
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
autocmd FileType tmpl       setlocal sw=2 sts=2 ts=2 et

autocmd FileType css setlocal omnifunc=csscomplete#CompleteCSS
autocmd FileType html,markdown setlocal omnifunc=htmlcomplete#CompleteTags
autocmd FileType javascript setlocal omnifunc=javascriptcomplete#CompleteJS
autocmd FileType xml setlocal omnifunc=xmlcomplete#CompleteTags
autocmd BufNewFile,BufRead *.go setlocal noexpandtab tabstop=4 shiftwidth=4
autocmd FileType vue syntax sync fromstart

" For Python
let g:syntastic_python_pylint_exe = 'python -m pylint'
let g:neomake_python_enabled_makers = ['flake8']

" For Ruby
au BufNewFile, BufRead Gemfile setl filetype = Gemfile
au BufWritePost Gemfile call vimproc#system('rbenv ctags')

" For Go from vim-go
let g:go_gocode_propose_source = 0
let g:go_gocode_unimported_packages = 1

let g:go_highlight_types = 1
let g:go_highlight_fields = 1
let g:go_highlight_functions = 1
let g:go_highlight_methods = 1
let g:go_metalinter_enabled = ['vet', 'golint', 'errcheck']
let g:go_metalinter_autosave = 1
let g:go_metalinter_autosave_enabled = ['vet', 'golint']
let g:syntastic_go_checkers = ['go', 'golint', 'errcheck']
let g:syntastic_aggregate_errors = 1
let g:rehash256 = 1
let g:molokai_original = 1
let g:go_fmt_command = "goimports"

let g:pymode_rope = 0

" For vue.js
let g:ft = ''
function! NERDCommenter_before()
  if &ft == 'vue'
    let g:ft = 'vue'
    let stack = synstack(line('.'), col('.'))
    if len(stack) > 0
      let syn = synIDattr((stack)[0], 'name')
      if len(syn) > 0
        exe 'setf ' . substitute(tolower(syn), '^vue_', '', '')
      endif
    endif
  endif
endfunction
function! NERDCommenter_after()
  if g:ft == 'vue'
    setf vue
    let g:ft = ''
  endif
endfunction

" 全角スペースの表示
highlight ZenkakuSpace cterm=underline ctermfg=lightblue guibg=darkgray
match ZenkakuSpace /　/

" カレントウィンドウにのみ罫線を引く
augroup cch
  autocmd! cch
  autocmd WinLeave * set nocursorline
  autocmd WinEnter,BufRead * set cursorline
augroup END

hi clear CursorLine
hi CursorLine gui=underline
highlight CursorLine ctermbg=black guibg=black

" 保存時に行末の空白を除去する
autocmd BufWritePre * :%s/\s\+$//ge
" 保存時にtabをスペースに変換する
autocmd BufWritePre * :%s/\t/    /ge

" Remember the last cursor position
au BufReadPost * if line("'\"") > 1 && line("'\"") <= line("$") | exe "normal! g`\"" | endif

" Unlimited undo
if has('persistent_undo')
  set undodir=~/.vim/undo
  set undofile
endif

colorscheme molokai
