#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2]||process.cwd();
const rec=fs.readFileSync(path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts'),'utf8');
const fail=m=>{console.error('R13_VERIFY_FAIL '+m);process.exit(1)};
if(rec.includes('readTelegramConnectionState'))fail('stale IDB connectionState gate remains');
if(rec.includes("objectStore('store').get(telegramGlobalStateKey())"))fail('cached global-state readiness read remains');
if(!rec.includes("data.type==='globalDiffUpdate'"))fail('official globalDiffUpdate listener missing');
if(!rec.includes("data.type==='globalUpdate'"))fail('official globalUpdate listener missing');
if(!rec.includes("data.diff?.connectionState"))fail('live diff connectionState missing');
if(!rec.includes("data.global?.connectionState"))fail('live full connectionState missing');
if(!rec.includes("Date.now()-state.readySince>=8000"))fail('8s stable ready gate missing');
if(!rec.includes('MACTRANSLATE_TELEGRAM_NOT_READY'))fail('reconnect in-flight cancellation missing');
if(rec.includes("https://*.web.telegram.org/apiw1*"))fail('apiw1 CORS override returned');
console.log('TELEGRAM_R13_LIVE_STATE_VERIFY_OK');
console.log('official-tt-global-live-state/no-cached-connectionState/stable-ready-8s=PASS');
