#!/usr/bin/env bash
# Raycast から Arc の特定 space に URL / 検索を投げる。
#
# @raycast.schemaVersion 1
# @raycast.title Open in Arc Space
# @raycast.mode compact
# @raycast.packageName Arc
# @raycast.icon 🌐
# @raycast.argument1 { "type": "dropdown", "placeholder": "space", "data": [{"title":"mr-myself","value":"mr-myself"},{"title":"kotoage","value":"kotoage"},{"title":"理科大","value":"理科大"},{"title":"OYKOT","value":"OYKOT"}] }
# @raycast.argument2 { "type": "text", "placeholder": "URL または検索語", "percentEncoded": false }
# @raycast.description URL を指定した Arc の space に開く。space を間違えるとプロファイル違いでログイン壁に当たるので、迷ったら Where does this go? で先に確認する。

exec "$HOME/.local/bin/web" "$1" "$2"
