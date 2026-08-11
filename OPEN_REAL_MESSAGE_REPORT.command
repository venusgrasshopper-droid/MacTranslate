#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
report="$(node "$ROOT/scripts/build-real-message-report-v6.mjs")"
open "$report"
