#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
const source=fs.readFileSync(path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts'),'utf8');
const PREFIX='__MACTRANSLATE_REAL_MESSAGE_V6__';
const assert=(v,m)=>{if(!v)throw new Error(m)};
function rawConst(name,next){
  const start=source.indexOf(`const ${name} = String.raw\``); if(start<0) throw new Error(name+' missing');
  const bodyStart=source.indexOf('`',start)+1;
  const end=source.indexOf(next?`const ${next} = String.raw\``:'function scriptFor',bodyStart);
  const bodyEnd=source.lastIndexOf('`;',end); return source.slice(bodyStart,bodyEnd);
}
const shared=rawConst('BRIDGE_SHARED','WHATSAPP_BRIDGE').replace('${JSON.stringify(CONSOLE_PREFIX)}',JSON.stringify(PREFIX));
const telegram=rawConst('TELEGRAM_BRIDGE','TEAMS_BRIDGE').replace('${BRIDGE_SHARED}',shared);
const teams=rawConst('TEAMS_BRIDGE','SIGNAL_BRIDGE').replace('${BRIDGE_SHARED}',shared);

// Ferdium upstream #2463: no TrustedHTML sink in service-document style injection.
for(const rel of ['src/webview/contextMenuBuilder.ts','src/webview/darkmode.ts','src/webview/lib/RecipeWebview.ts','src/webview/recipe.ts']){
  const text=fs.readFileSync(path.join(root,rel),'utf8');
  assert(!/\.innerHTML\s*[-+]*=/.test(text),`${rel}: innerHTML assignment remains`);
  assert(/textContent/.test(text),`${rel}: upstream textContent fix missing`);
}
// Teams bridge itself ran in page world and still had a Trusted Types sink after #2463.
assert(!/DOMParser\s*\(\)\.parseFromString\([^,]+,\s*['\"]text\/html['\"]\)/.test(teams),'Teams bridge still uses DOMParser text/html TrustedHTML sink');
assert(teams.includes('decodeHtmlEntities'),'Teams sink-free HTML decoder missing');

// Telegram official GlobalState says Connecting/Ready/Broken. While Connecting,
// MacTranslate must not send fetchChats/fetchMessages at all.
const sharedState={settings:{shouldAllowHttpTransport:true}};
const indexedDB={open(){const req={};queueMicrotask(()=>{const store={get(key){const r={};queueMicrotask(()=>{r.result=key==='tt-shared-state'?sharedState:undefined;r.onsuccess?.()});return r},put(){}};const db={objectStoreNames:{contains:n=>n==='store'},transaction(){return {objectStore:()=>store,set oncomplete(fn){queueMicrotask(fn)},set onerror(_){},set onabort(_){}}},close(){}};req.result=db;req.onsuccess?.()});return req}};
let apiCalls=0;
class BC{constructor(){this.listeners=[];queueMicrotask(()=>{for(const f of this.listeners)f({data:{type:'globalDiffUpdate',diff:{connectionState:'connectionStateConnecting'}}})})}addEventListener(t,f){if(t==='message')this.listeners.push(f)}postMessage(data){if(data?.type==='callApi')apiCalls+=1}close(){}}
class MO{constructor(cb){this.cb=cb}observe(){}disconnect(){}}
class LS{constructor(entries={}){this.m=new Map(Object.entries(entries))}get length(){return this.m.size}key(i){return [...this.m.keys()][i]??null}getItem(k){return this.m.has(k)?this.m.get(k):null}setItem(k,v){this.m.set(String(k),String(v))}removeItem(k){this.m.delete(k)}}
const localStorage=new LS({account1:JSON.stringify({dcId:2,userId:'999'})});
const sessionStorage=new LS();
const location={pathname:'/a/',href:'https://web.telegram.org/a/',hash:'',reload(){}};
const document={documentElement:{},querySelector(){return null},querySelectorAll(){return[]},createTextNode:t=>({textContent:t})};
const window={addEventListener(){},removeEventListener(){}};
const pageConsole={info(){},warn(){},error(){},log(){}};
const ctx={window,document,location,indexedDB,localStorage,sessionStorage,BroadcastChannel:BC,MutationObserver:MO,Date,Number,String,Boolean,JSON,Set,Map,Object,Promise,URL,Math,console:pageConsole,queueMicrotask,setTimeout:(fn,ms)=>{if(ms<1000)queueMicrotask(fn);return 1},clearTimeout(){},setInterval:()=>1,clearInterval(){}};
vm.createContext(ctx);vm.runInContext(telegram,ctx,{timeout:3000});
for(let i=0;i<80;i++)await new Promise(r=>setImmediate(r));
assert(apiCalls===0,'Telegram API history ran while official connectionStateConnecting');
assert(telegram.includes("data.type==='globalDiffUpdate'"),'Telegram live globalDiffUpdate listener missing');
assert(telegram.includes('data.diff?.connectionState'),'Telegram live connectionState diff missing');
assert(telegram.includes("'connectionStateReady'"),'Telegram Ready gate missing');
assert(!telegram.includes('readTelegramConnectionState'),'Telegram stale cached readiness gate remains');

console.log('R10_UPSTREAM_CONSOLE_FIXES_OK');
console.log('ferdium-2463-trustedtypes/teams-no-domparser-sink/telegram-connectionStateReady-gate=PASS');
