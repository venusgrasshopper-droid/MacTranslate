#!/usr/bin/env bash
set -euo pipefail
LOG="$HOME/Library/Application Support/MacTranslate/MessageRecognitionV6/messages.jsonl"
STATUS="$HOME/Library/Application Support/MacTranslate/MessageRecognitionV6/status.jsonl"
node - "$LOG" "$STATUS" <<'NODE'
const fs=require('fs'); const [log,status]=process.argv.slice(2);
const read=p=>{try{return fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean)}catch{return[]}};
const statuses=read(status).filter(x=>x.service==='whatsapp'&&x.status==='whatsapp-history-snapshot-complete');
const done=statuses.at(-1);
if(!done){console.log('HISTORY_SNAPSHOT=NOT PASSED');console.log('没有找到本次 WhatsApp 历史快照完成记录。');process.exit(2)}
const end=Number(done.observedAt||0), start=end-60000;
const rows=read(log).filter(x=>x.service==='whatsapp'&&x.providerEvent==='whatsapp-wawebcollections-history-snapshot'&&x.observedAt>=start&&x.observedAt<=end&&x.serviceInstanceId===done.serviceInstanceId);
const details=done.details||{};
console.log(`HISTORY_SNAPSHOT=${Number(details.scanned)>0?'PASS':'EMPTY'} scanned=${details.scanned||0} captured=${details.captured||0} rows=${rows.length}`);
console.log('STATUS='+JSON.stringify(details));
for(const x of rows.slice(-20)) console.log(JSON.stringify({sentAt:x.sentAt,direction:x.direction,conversationId:x.conversationId,messageId:x.messageId,text:x.text}));
process.exit(Number(details.scanned)>0?0:3);
NODE
