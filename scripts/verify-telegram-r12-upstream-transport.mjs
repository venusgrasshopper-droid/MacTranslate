#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2]||process.cwd();
const rec=fs.readFileSync(path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts'),'utf8');
const service=fs.readFileSync(path.join(root,'src/models/Service.ts'),'utf8');
const index=fs.readFileSync(path.join(root,'src/index.ts'),'utf8');
const fail=(m)=>{console.error('R12_VERIFY_FAIL '+m);process.exit(1)};
if(!rec.includes("telegram-upstream-transport-restored"))fail('restore status missing');
if(!rec.includes("settings.shouldAllowHttpTransport=true"))fail('allow HTTP upstream default not restored');
if(!rec.includes("delete settings.shouldForceHttpTransport"))fail('R11 forced HTTP not cleared');
if(!rec.includes("Date.now()-state.readySince>=8000"))fail('stable ready gate missing');
if(rec.includes("forceHttp:true"))fail('forced HTTP still present');
if(rec.includes("corsBridge:'scoped-apiw1-response-header'"))fail('R11 CORS bridge still present');
if(service.includes('configureTelegramHttpCors'))fail('Service still configures Telegram CORS');
if(index.includes('configureTelegramHttpCors')||index.includes("https://*.web.telegram.org/apiw1*"))fail('main-process apiw1 CORS override remains');
console.log('TELEGRAM_R12_UPSTREAM_TRANSPORT_VERIFY_OK');
console.log('upstream-allow-http/no-force-http/no-cors-override/stable-ready-8s=PASS');
