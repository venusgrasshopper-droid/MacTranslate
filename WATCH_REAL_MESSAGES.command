#!/usr/bin/env bash
set -euo pipefail
DATA="$HOME/Library/Application Support/MacTranslate/MessageRecognitionV6"
RUN="$DATA/current-run.json"
LOG="$DATA/messages.jsonl"
for _ in $(seq 1 120); do
  [[ -s "$RUN" ]] && break
  sleep 0.5
done
[[ -s "$RUN" ]] || { echo 'REAL_CAPTURE_NOT_STARTED'; exit 2; }
run_id="$(node -e 'const fs=require("fs");const p=process.argv[1];console.log(JSON.parse(fs.readFileSync(p,"utf8")).recognitionRunId)' "$RUN")"
echo "REAL_CAPTURE_RUN_ID=$run_id"
echo "REAL_CAPTURE_LOG=$LOG"
touch "$LOG"
tail -n 0 -F "$LOG" | node -e '
const readline=require("readline"); const run=process.argv[1];
const rl=readline.createInterface({input:process.stdin});
rl.on("line", line=>{try{const x=JSON.parse(line);if(x.recognitionRunId===run&&x.schema==="mactranslate-real-message-v6")console.log(`[REAL] ${x.service} ${x.direction} ${x.conversationTitle||x.conversationId}: ${x.text}`)}catch{}});' "$run_id"
