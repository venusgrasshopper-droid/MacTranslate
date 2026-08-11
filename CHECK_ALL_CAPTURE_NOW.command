#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/Library/Application Support/MacTranslate/MessageRecognitionV6/messages.jsonl"
node - "$LOG" <<'NODE'
const fs=require('fs');
const file=process.argv[2];
let rows=[];
try { rows=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)); } catch {}
for (const service of ['whatsapp','telegram','signal','teams']) {
  const count=rows.filter(x=>x.service===service).length;
  console.log(`${service.padEnd(8)} ${count>0?'PASS':'NOT PASSED'}  ${count}`);
}
console.log(`TOTAL    ${rows.length}`);
NODE
report="$(node "$ROOT/scripts/build-real-message-report-v6.mjs")"
echo "$report"
open "$report"
