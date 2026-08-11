#!/usr/bin/env bash
set -euo pipefail
LOG="$HOME/Library/Application Support/MacTranslate/MessageRecognitionV6/messages.jsonl"
STATUS="$HOME/Library/Application Support/MacTranslate/MessageRecognitionV6/status.jsonl"
START="$(node -e 'process.stdout.write(String(Date.now()))')"
echo 'WhatsApp：收一条纯文字，再发一条纯文字，完成后按回车。'
read -r _
sleep 1
node - "$LOG" "$STATUS" "$START" <<'NODE'
const fs=require('fs'); const [log,status,start]=process.argv.slice(2); const t=Number(start);
const read=p=>{try{return fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean)}catch{return[]}};
const allStatus=read(status).filter(x=>x.service==='whatsapp');
const rows=read(log).filter(x=>x.service==='whatsapp'&&x.observedAt>=t&&x.providerEvent!=='whatsapp-wawebcollections-history-snapshot');
const latestListener=[...allStatus].reverse().find(x=>x.status==='listener-installed');
const listener=Boolean(latestListener); const i=rows.filter(x=>x.direction==='incoming'),o=rows.filter(x=>x.direction==='outgoing');
console.log(`LISTENER=${listener?'PASS':'NOT PASSED'}`);console.log(`INCOMING=${i.length?'PASS':'NOT PASSED'} count=${i.length}`);console.log(`OUTGOING=${o.length?'PASS':'NOT PASSED'} count=${o.length}`);
for(const x of rows)console.log(JSON.stringify({direction:x.direction,conversationId:x.conversationId,messageId:x.messageId,text:x.text,providerEvent:x.providerEvent}));
process.exit(listener&&i.length&&o.length?0:2);
NODE
