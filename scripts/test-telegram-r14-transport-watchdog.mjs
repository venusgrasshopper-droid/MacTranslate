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
class LS{constructor(entries={}){this.m=new Map(Object.entries(entries))}getItem(k){return this.m.has(k)?this.m.get(k):null}setItem(k,v){this.m.set(String(k),String(v))}removeItem(k){this.m.delete(k)}}
class MO{observe(){}disconnect(){}}
const run=async ({mode,initialForce,sendReady,watchdogFast})=>{
 const envelopes=[];const consoleProxy={info(v){const s=String(v);if(s.startsWith(PREFIX))envelopes.push(JSON.parse(s.slice(PREFIX.length)))},warn(){},error(){},log(){}};
 const sharedState={cacheVersion:1,settings:{shouldAllowHttpTransport:true,...(initialForce===undefined?{}:{shouldForceHttpTransport:initialForce})}};
 const indexedDB={open(){const req={};queueMicrotask(()=>{const store={get(k){const r={};queueMicrotask(()=>{r.result=k==='tt-shared-state'?structuredClone(sharedState):undefined;r.onsuccess?.()});return r},put(v,k){if(k==='tt-shared-state'){sharedState.cacheVersion=v.cacheVersion;sharedState.settings={...v.settings}}}};const tx={objectStore:()=>store};const db={objectStoreNames:{contains:n=>n==='store'},transaction(){queueMicrotask(()=>queueMicrotask(()=>tx.oncomplete?.()));return tx},close(){}};req.result=db;req.onsuccess?.()});return req}};
 const sessionStorage=new LS(mode?{__mactranslateTelegramAdaptiveHttpR14:mode}:{});const localStorage=new LS({account1:JSON.stringify({dcId:2,userId:'999'})});let reloads=0;const location={pathname:'/a/',href:'https://web.telegram.org/a/',hash:'',reload(){reloads++}};
 const document={documentElement:{},querySelector(){return null},querySelectorAll(){return[]},createTextNode:t=>({textContent:t})};const window={addEventListener(){},removeEventListener(){},Debug:{}};
 const realSetTimeout=globalThis.setTimeout;const fast=(fn,ms)=>realSetTimeout(fn,watchdogFast&&ms>=20000?10:Math.min(1000000,Math.max(1,ms)));
 const ctx={window,document,location,indexedDB,localStorage,sessionStorage,BroadcastChannel:globalThis.BroadcastChannel,MutationObserver:MO,Date,Number,String,Boolean,JSON,Set,Map,Object,Promise,URL,Math,console:consoleProxy,queueMicrotask,setTimeout:fast,clearTimeout:globalThis.clearTimeout,setInterval:()=>1,clearInterval(){},structuredClone};vm.createContext(ctx);
 vm.runInContext(code,ctx,{timeout:3000});
 const channel=new BroadcastChannel('tt-global_1');if(sendReady)realSetTimeout(()=>channel.postMessage({type:'globalDiffUpdate',diff:{connectionState:'connectionStateReady'}}),5);
 await new Promise(r=>realSetTimeout(r,watchdogFast?80:40));channel.close();try{ctx.window.__mactranslateRealTelegramV70?.apiChannel?.close?.()}catch{}
 return {sharedState,sessionStorage,reloads,envelopes};
};
// First run: persist official force=true and request one reload.
const first=await run({mode:'',initialForce:undefined,sendReady:false,watchdogFast:false});
if(first.sharedState.settings.shouldForceHttpTransport!==true)throw new Error('initial adaptive setup did not persist force=true');
if(first.reloads!==1)throw new Error('initial adaptive setup did not reload exactly once');
if(first.sessionStorage.getItem('__mactranslateTelegramAdaptiveHttpR14')!=='force-pending')throw new Error('force-pending marker missing');
// Forced mode failure: no live Ready -> revert to official allow-fallback mode and reload.
const failed=await run({mode:'force-pending',initialForce:true,sendReady:false,watchdogFast:true});
if(failed.sharedState.settings.shouldForceHttpTransport!==false)throw new Error('watchdog did not revert force=false');
if(failed.reloads!==1)throw new Error('watchdog did not reload after revert');
if(failed.sessionStorage.getItem('__mactranslateTelegramAdaptiveHttpR14')!=='fallback-only')throw new Error('fallback-only marker missing');
if(!failed.envelopes.some(x=>x.kind==='status'&&x.status==='telegram-force-http-reverted'))throw new Error('revert status missing');
console.log('TELEGRAM_R14_TRANSPORT_WATCHDOG_OK');
console.log('persist-force/reload-once/no-ready-revert-fallback=PASS');
process.exit(0);
