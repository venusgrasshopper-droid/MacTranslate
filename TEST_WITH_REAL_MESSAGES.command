#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
"$ROOT/CLEAR_REAL_MESSAGE_LOG.command"
open -a /Applications/MacTranslate.app
cat <<'TXT'
真实消息验收：
1. WhatsApp、Telegram、Signal、Teams 各收一条、发一条纯文字。
2. 完成后回终端按回车。
3. 报告只统计本次 messages.jsonl 的真实记录，不用左侧预览凑数。
TXT
read -r
"$ROOT/OPEN_REAL_MESSAGE_REPORT.command"
