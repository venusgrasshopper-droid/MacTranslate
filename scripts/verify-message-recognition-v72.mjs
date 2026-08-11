#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
const file=path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts');
const source=fs.readFileSync(file,'utf8');
const fail=[];
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const wa=slice('const WHATSAPP_BRIDGE','const TELEGRAM_BRIDGE');
for(const forbidden of ['WPP.','WAJS_BUNDLE','MsgStore','MsgCollection','getMessages(','getUnreadChats(','setInterval(','MutationObserver','.message-in','.message-out','rowSelector']) if(wa.includes(forbidden)) fail.push('WhatsApp forbidden: '+forbidden);
if(wa.includes("Msg.on('change:type'")) fail.push('WhatsApp must not attach global change:type');
for(const required of [
  "safeRequire('WAWebCollections')",
  "Msg.on('add', state.addHandler)",
  "msg.isNewMsg !== true",
  "clean(msg.type) !== 'chat'",
  "conversationId === 'status@broadcast'",
  "adapter: 'whatsapp-webjs-msg-add-readonly-v722'",
  "state.collections = collections",
  "msg.once('change:type'",
  'scheduleRetry()',
  'clearRetry()',
  'const delays = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000]',
]) if(!wa.includes(required)) fail.push('WhatsApp missing: '+required);
const tg=slice('const TELEGRAM_BRIDGE','const TEAMS_BRIDGE');
const teams=slice('const TEAMS_BRIDGE','const SIGNAL_BRIDGE');
const sig=slice('const SIGNAL_BRIDGE','function scriptFor');
for(const x of ['last-message-summary','telegram-web-a-unread-chat-preview','ChatBadge.unread']) if(tg.includes(x)) fail.push('Telegram changed into pseudo path: '+x);
if(teams.includes('document.body || null')) fail.push('Teams body fallback returned');
if(teams.includes('location.pathname + location.search + location.hash')) fail.push('Teams /v2/ id returned');
for(const x of ['archiveCollectorStatus','getUserhash','webview.mactranslate-base.js','WAWebUserPrefsMeUser','WAWebSocketModel']) if(source.includes(x)) fail.push('legacy symbol: '+x);
for(const [name,part] of [['telegram',tg],['teams',teams],['signal',sig]]) if(!part.trim()) fail.push(name+' bridge missing');
try {
  const require=createRequire(import.meta.url); let ts;
  for(const c of [path.join(root,'node_modules/typescript/lib/typescript.js'),'/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js','/usr/local/lib/node_modules/typescript/lib/typescript.js','/opt/homebrew/lib/node_modules/typescript/lib/typescript.js']) { try { ts=require(c); break; } catch {} }
  if(ts){
    const out=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true,fileName:file});
    for(const d of out.diagnostics||[]) if(d.category===ts.DiagnosticCategory.Error) fail.push('TS '+ts.flattenDiagnosticMessageText(d.messageText,'\n'));
  } else console.log('TYPECHECK_DEFERRED_TO_BUILD');
} catch(e){ console.log('TYPECHECK_DEFERRED_TO_BUILD '+String(e?.message||e)); }
if(fail.length){ console.error('MESSAGE_CAPTURE_V72_AUDIT_FAILED'); for(const x of fail) console.error('- '+x); process.exit(1); }
console.log('MESSAGE_CAPTURE_V72_AUDIT_OK');
