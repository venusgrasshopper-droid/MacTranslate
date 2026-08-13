#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="$HOME/Library/Application Support/MacTranslate/MessageRecognitionV6"
set +e
node "$ROOT/scripts/check-current-run-capture.mjs" "$DATA"
status=$?
set -e
report="$(node "$ROOT/scripts/build-real-message-report-v6.mjs")"
echo "$report"
open "$report"
exit "$status"
