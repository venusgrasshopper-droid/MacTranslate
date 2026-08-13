#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
const recognition=read('src/electron/message-recognition/UnifiedMessageRecognition.ts');
const recipe=read('recipes/recipes/telegram/index.js');
const service=read('src/models/Service.ts');
const index=read('src/index.ts');
const failures=[];
const req=(label,text,needle)=>{if(!text.includes(needle))failures.push(`${label}: missing ${needle}`)};
const forbid=(label,text,re)=>{if(re.test(text))failures.push(`${label}: forbidden ${re}`)};
req('transport',recognition,'shouldAllowHttpTransport:true,shouldForceHttpTransport:true');
req('transport',recognition,"corsBridge:'scoped-apiw1-response-header'");
forbid('transport',recognition,/window\.WebSocket\s*=|WebSocket\.prototype|window\.Worker\s*=|Worker\.prototype/);
forbid('frozen recipe',recipe,/modifyResponseHeaders|Access-Control-Allow-Origin|apiw1/);
req('service',service,"recipe.id === 'telegram'");
req('service',service,"ipcRenderer.send('configureTelegramHttpCors'");
req('main',index,"'configureTelegramHttpCors'");
req('main',index,"'https://*.web.telegram.org/apiw1*'");
req('main',index,'/^zws\\d+\\.web\\.telegram\\.org$/');
req('main',index,"responseHeaders['Access-Control-Allow-Origin'] = ['https://web.telegram.org']");
req('main',index,'.webRequest.onHeadersReceived');
if(failures.length){console.error('TELEGRAM_R11_FORCE_HTTP_CORS_VERIFY_FAILED');for(const f of failures)console.error('- '+f);process.exit(1)}
console.log('TELEGRAM_R11_FORCE_HTTP_CORS_VERIFY_OK');
console.log('official-HttpStream/scoped-apiw1-ACAO/force-http/no-websocket-monkeypatch=PASS');
