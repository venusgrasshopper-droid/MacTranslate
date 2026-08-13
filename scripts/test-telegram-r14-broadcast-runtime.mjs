#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
const source=fs.readFileSync(path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts'),'utf8');
const PREFIX='__MACTRANSLATE_REAL_MESSAGE_V6__';
function rawConst(name,next){const start=source.indexOf(`const ${name} = String.raw\``);if(start<0)throw new Error(name+' missing');const bodyStart=source.indexOf('`',start)+1;const end=source.indexOf(next?`const ${next} = String.raw\``:'function scriptFor',bodyStart);const bodyEnd=source.lastIndexOf('`;',end);return source.slice(bodyStart,bodyEnd)}
const shared=rawConst('BRIDGE_SHARED','WHATSAPP_BRIDGE').replace('${JSON.stringify(CONSOLE_PREFIX)}',JSON.stringify(PREFIX));
const code=rawConst('TELEGRAM_BRIDGE','TEAMS_BRIDGE').replace('${BRIDGE_SHARED}',shared);
const envelopes=[];
const consoleProxy={info(v){const s=String(v);if(s.startsWith(PREFIX))envelopes.push(JSON.parse(s.slice(PREFIX.length)))},warn(){},error(){},log(){}};
class LS{constructor(entries={}){this.m=new Map(Object.entries(entries))}getItem(k){return this.m.has(k)?this.m.get(k):null}setItem(k,v){this.m.set(String(k),String(v))}removeItem(k){this.m.delete(k)}}
class MO{constructor(cb){this.cb=cb}observe(){}disconnect(){}}
const sharedState={cacheVersion:1,settings:{shouldAllowHttpTransport:true,shouldForceHttpTransport:true}};
const indexedDB={open(){const req={};queueMicrotask(()=>{const store={get(k){const r={};queueMicrotask(()=>{r.result=k==='tt-shared-state'?sharedState:undefined;r.onsuccess?.()});return r},put(v,k){if(k==='tt-shared-state'){sharedState.cacheVersion=v.cacheVersion;sharedState.settings={...v.settings}}}};const tx={objectStore:()=>store};const db={objectStoreNames:{contains:n=>n==='store'},transaction(){queueMicrotask(()=>tx.oncomplete?.());return tx},close(){}};req.result=db;req.onsuccess?.()});return req}};
const localStorage=new LS({account1:JSON.stringify({dcId:2,userId:'999'})});
const sessionStorage=new LS({__mactranslateTelegramAdaptiveHttpR14:'force-pending'});
let reloads=0; const location={pathname:'/a/',href:'https://web.telegram.org/a/',hash:'',reload(){reloads++}};
const document={documentElement:{},querySelector(){return null},querySelectorAll(){return[]},createTextNode:t=>({textContent:t})};
const window={addEventListener(){},removeEventListener(){},Debug:{}};
class FastDate extends Date{static t=1786400000000;static now(){this.t+=9000;return this.t}}
const realSetTimeout=globalThis.setTimeout;
const fastSetTimeout=(fn,ms)=>realSetTimeout(fn,ms>=20000?1000000:Math.min(5,Math.max(0,ms/1000)));
const ctx={window,document,location,indexedDB,localStorage,sessionStorage,BroadcastChannel:globalThis.BroadcastChannel,MutationObserver:MO,Date:FastDate,Number,String,Boolean,JSON,Set,Map,Object,Promise,URL,Math,console:consoleProxy,queueMicrotask,setTimeout:fastSetTimeout,clearTimeout:globalThis.clearTimeout,setInterval:()=>1,clearInterval(){}};
vm.createContext(ctx);
const master=new BroadcastChannel('tt-global_1'); const calls=[]; let failFirst=true;
master.addEventListener('message',e=>{const d=e.data;if(d?.type!=='callApi')return;calls.push(d.name);if(d.name==='fetchChats'&&failFirst){failFirst=false;master.postMessage({type:'globalDiffUpdate',diff:{connectionState:'connectionStateConnecting'}});realSetTimeout(()=>master.postMessage({type:'globalDiffUpdate',diff:{connectionState:'connectionStateReady'}}),5);return;}let response;if(d.name==='fetchChats')response={chats:[],users:[],lastMessageByChatId:{},totalChatCount:0};else if(d.name==='fetchMessages')response={messages:[],users:[],chats:[]};master.postMessage({type:'messageResponse',token:d.token,messageId:d.messageId,response});});
try{
 vm.runInContext(code,ctx,{timeout:3000});
 master.postMessage({type:'globalDiffUpdate',diff:{connectionState:'connectionStateReady'}});
 const deadline=Date.now()+3000;while(Date.now()<deadline){if(envelopes.some(x=>x.kind==='status'&&x.status==='telegram-api-history-snapshot-complete'))break;await new Promise(r=>realSetTimeout(r,5));}
 const errors=envelopes.filter(x=>x.kind==='status'&&x.status==='telegram-api-history-error');
 if(sessionStorage.getItem('__mactranslateTelegramAdaptiveHttpR14')!=='force-confirmed')throw new Error('force HTTP was not confirmed by live Ready');
 if(reloads!==0)throw new Error('unexpected reload in already-forced runtime');
 if(calls.filter(x=>x==='fetchChats').length<3)throw new Error('history collector did not retry after reconnect');
 if(errors.length)throw new Error('collector emitted telegram-api-history-error: '+JSON.stringify(errors));
 if(!envelopes.some(x=>x.kind==='status'&&x.status==='telegram-api-history-snapshot-complete'))throw new Error('history snapshot did not recover');
 console.log('TELEGRAM_R14_BROADCAST_RUNTIME_OK');
 console.log('force-http-ready/drop-during-RPC/re-ready/recover-without-history-error=PASS');
} finally {master.close();try{ctx.window.__mactranslateRealTelegramV70?.apiChannel?.close?.()}catch{}}
