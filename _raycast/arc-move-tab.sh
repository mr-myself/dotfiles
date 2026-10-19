#!/usr/bin/env bash
# いま見ているタブを別の space に移す。
#
# @raycast.schemaVersion 1
# @raycast.title Move Tab to Space
# @raycast.mode compact
# @raycast.packageName Arc
# @raycast.icon 🚚
# @raycast.argument1 { "type": "dropdown", "placeholder": "移す先", "data": [{"title":"mr-myself","value":"mr-myself"},{"title":"kotoage","value":"kotoage"},{"title":"理科大","value":"理科大"},{"title":"OYKOT","value":"OYKOT"}] }
# @raycast.description Arc の最前面のタブを別の space に移す。閉じて開き直す実装なのでスクロール位置と戻る履歴は失われる。

exec "$HOME/.local/bin/web" move "$1"
