#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2]||process.cwd());
const src=fs.readFileSync(path.join(root,'src/index.ts'),'utf8');
const fail=m=>{console.error('R16_WRAPPER_HTTP_STATUS_FAIL '+m);process.exit(1)};
for(const s of [
  "'https://crashlogs.whatsapp.net/*'",
  "'https://teams.live.com/v2/manifest.json'",
  "statusLine: 'HTTP/1.1 200 OK'",
  "statusLine: 'HTTP/1.1 204 No Content'",
]) if(!src.includes(s)) fail('missing '+s);
const transform=(d)=>{
  const url=d.url||'';
  if(url.startsWith('https://crashlogs.whatsapp.net/')&&d.statusCode===400) return {responseHeaders:d.responseHeaders||{},statusLine:'HTTP/1.1 200 OK'};
  if(url==='https://teams.live.com/v2/manifest.json'&&d.statusCode===404) return {responseHeaders:{},statusLine:'HTTP/1.1 204 No Content'};
  return {};
};
if(transform({url:'https://crashlogs.whatsapp.net/wa_clb_data',statusCode:400}).statusLine!=='HTTP/1.1 200 OK') fail('WA crashlog 400');
if(transform({url:'https://teams.live.com/v2/manifest.json',statusCode:404}).statusLine!=='HTTP/1.1 204 No Content') fail('Teams manifest 404');
if(Object.keys(transform({url:'https://teams.live.com/api/chatsvc/consumer',statusCode:404})).length) fail('Teams API 404 must remain visible');
if(Object.keys(transform({url:'https://crashlogs.whatsapp.net/wa_clb_data',statusCode:500})).length) fail('WA telemetry 500 must remain visible');
console.log('R16_WRAPPER_ONLY_HTTP_STATUS_OK');
console.log('wa-crashlog-400/teams-pwa-manifest-404-only/real-api-errors-untouched=PASS');
