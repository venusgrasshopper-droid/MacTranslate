#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';

const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
const source=fs.readFileSync(path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts'),'utf8');
const PREFIX='__MACTRANSLATE_REAL_MESSAGE_V6__';
function rawConst(name,next){
  const start=source.indexOf(`const ${name} = String.raw\``); if(start<0) throw new Error(name+' missing');
  const bodyStart=source.indexOf('`',start)+1;
  const end=source.indexOf(next?`const ${next} = String.raw\``:'function scriptFor',bodyStart);
  const bodyEnd=source.lastIndexOf('`;',end); return source.slice(bodyStart,bodyEnd);
}
const shared=rawConst('BRIDGE_SHARED','WHATSAPP_BRIDGE').replace('${JSON.stringify(CONSOLE_PREFIX)}',JSON.stringify(PREFIX));
const bridge=(name,next)=>rawConst(name,next).replace('${BRIDGE_SHARED}',shared);
const assert=(v,m)=>{if(!v)throw new Error(m)};
const flush=async(n=30)=>{for(let i=0;i<n;i++) await new Promise(r=>setImmediate(r));};
const waitFor=async(predicate,timeoutMs=3000)=>{const end=Date.now()+timeoutMs;while(Date.now()<end){if(predicate())return true;await new Promise(r=>setImmediate(r));}return Boolean(predicate());};
const logger=envelopes=>({info(v){const x=String(v);if(x.startsWith(PREFIX))envelopes.push(JSON.parse(x.slice(PREFIX.length)));},warn(){},error(){},log(){}});
class MO{constructor(cb){this.cb=cb}observe(){}disconnect(){}}
class LS{constructor(entries={}){this.m=new Map(Object.entries(entries))}get length(){return this.m.size}key(i){return [...this.m.keys()][i]??null}getItem(k){return this.m.has(k)?this.m.get(k):null}setItem(k,v){this.m.set(String(k),String(v))}removeItem(k){this.m.delete(k)}}

// WhatsApp: exact native ExportChat local-history pattern, including a DB-only chat.
{
  const code=bridge('WHATSAPP_BRIDGE','TELEGRAM_BRIDGE');
  class Collection extends EventEmitter{off(e,f){return super.off(e,f)}}
  const Msg=new Collection(); Msg.getModelsArray=()=>[];
  const Chat=new Collection(); Chat.getModelsArray=()=>[]; Chat.get=()=>null;
  const remoteString='19998887777@c.us';
  const remote={_serialized:remoteString,toString(){return this._serialized}};
  const mk=(id,body,t,fromMe=false)=>({
    isNewMsg:false,type:'chat',body,t,
    id:{fromMe,remote,id,_serialized:`${fromMe?'true':'false'}_${remoteString}_${id}`},
    from:fromMe?{_serialized:'15550001111@c.us'}:remote,
    to:remote,
  });
  const m3=mk('H3','newest local',1786400300);
  const mediaCaption={...mk('H4','',1786400400),type:'image',caption:'photo caption'};
  const internalReaction={...mk('H5','internal reaction payload',1786400500),type:'reaction'};
  const m2=mk('H2','middle local',1786400200);
  const m1=mk('H1','oldest local',1786400100);
  const calls=[];
  const finder={async msgFindBefore({anchor,count}){
    calls.push({anchor,count});
    if(anchor?.remote && !anchor?.id){assert(anchor.remote===remote,'WA first anchor must use DB chat WID');return {status:200,messages:[m2,m3,mediaCaption,internalReaction]};}
    if(anchor===m2.id)return {status:200,messages:[m1]};
    if(anchor===m1.id)return {status:200,messages:[]};
    throw new Error('unexpected WA anchor');
  }};
  const modules={
    WATagsLogger:{whenReady:()=>Promise.resolve()},
    WAWebCollections:{Msg,Chat,Contact:{get:()=>null}},
    WAWebSchemaChat:{getChatTable:()=>({all:async()=>[{id:remoteString,name:'DB Chat'}]})},
    WAWebWidFactory:{createWid:value=>{assert(value===remoteString,'WA createWid got wrong chat id');return remote}},
    WAWebDBMessageFindLocal:finder,
    WAWebSchemaContact_DO_NOT_USE_DIRECTLY:{getContactTable:()=>({all:async()=>[{id:remoteString,name:'Alice'}]})},
  };
  const envelopes=[];
  const window={Debug:{VERSION:'test'},require:n=>modules[n]||null,addEventListener(){},removeEventListener(){}};
  const ctx={window,document:{documentElement:{}},queueMicrotask,Date,Number,String,Boolean,JSON,Set,Map,Object,Promise,console:logger(envelopes),setTimeout:(fn)=>{queueMicrotask(fn);return 1},clearTimeout(){}};
  vm.createContext(ctx); vm.runInContext(code,ctx,{timeout:3000}); await flush(80);
  const rows=envelopes.filter(x=>x.kind==='message'&&x.payload?.providerEvent==='whatsapp-native-exportchat-local-history').map(x=>x.payload);
  assert(calls.length>=3,'WA native msgFindBefore pagination did not continue to EOF');
  assert(calls[0].count===50,'WA native page size must match ExportChatAction (50)');
  assert(rows.some(x=>x.text==='newest local')&&rows.some(x=>x.text==='middle local')&&rows.some(x=>x.text==='oldest local'),'WA native local history missed a page');
  assert(rows.some(x=>x.text==='photo caption'),'WA ExportChat media caption was dropped');
  assert(!rows.some(x=>x.text==='internal reaction payload'),'WA internal reaction payload must not become message text');
  assert(rows.every(x=>x.conversationId===remoteString),'WA DB-only conversation id missing');
  const done=envelopes.find(x=>x.kind==='status'&&x.status==='whatsapp-history-snapshot-complete');
  assert(done?.details?.enumeratedChats===1&&done?.details?.dbOnlyChats===1,'WA chat-table enumeration did not include DB-only chat');
}

// Telegram: official tt-global callApi -> paged GetDialogs + paged GetHistory.
{
  const code=bridge('TELEGRAM_BRIDGE','TEAMS_BRIDGE'); const envelopes=[];
  const sharedState={settings:{shouldAllowHttpTransport:true}};
  const indexedDB={open(){const req={};queueMicrotask(()=>{const store={get(key){const r={};queueMicrotask(()=>{r.result=key==='tt-shared-state'?sharedState:undefined;r.onsuccess?.()});return r},put(){}};const db={objectStoreNames:{contains:n=>n==='store'},transaction(){return {objectStore:()=>store,set oncomplete(fn){queueMicrotask(fn)},set onerror(_){},set onabort(_){}}},close(){}};req.result=db;req.onsuccess?.()});return req}};
  const apiCalls=[];
  const historyPage=()=>Array.from({length:100},(_,i)=>({
    id:200-i,chatId:'123',date:1786400200-i,isOutgoing:i===1,senderId:i===1?undefined:'456',content:{text:{text:i===0?'incoming API':(i===1?'outgoing API':'bulk '+i)}},
  }));
  class BC{
    constructor(name){this.name=name;this.listeners=[];queueMicrotask(()=>{for(const fn of this.listeners)fn({data:{type:'globalDiffUpdate',diff:{connectionState:'connectionStateConnecting'}}});queueMicrotask(()=>{for(const fn of this.listeners)fn({data:{type:'globalDiffUpdate',diff:{connectionState:'connectionStateReady'}}})})})}
    addEventListener(type,fn){if(type==='message')this.listeners.push(fn)}
    postMessage(data){if(data?.type!=='callApi')return;apiCalls.push({name:data.name,args:data.args});let response;
      if(data.name==='fetchChats'){
        const a=data.args?.[0]||{};
        if(a.archived) response={chats:[],users:[],lastMessageByChatId:{},totalChatCount:0};
        else if(!a.offsetId) response={chats:[{id:'123',title:'Alice Chat',accessHash:'h1'}],users:[{id:'456',firstName:'Alice'}],lastMessageByChatId:{'123':200},totalChatCount:2,nextOffsetId:200,nextOffsetPeerId:'123',nextOffsetDate:1786400200};
        else response={chats:[{id:'124',title:'Second Chat',accessHash:'h2'}],users:[],lastMessageByChatId:{'124':5},totalChatCount:2};
      }else if(data.name==='fetchMessages'){
        const a=data.args?.[0]||{};
        if(a.chat?.id==='123' && !a.offsetId) response={messages:historyPage(),users:[{id:'456',firstName:'Alice'}],chats:[]};
        else if(a.chat?.id==='123' && Number(a.offsetId)===101) response={messages:[{id:100,chatId:'123',date:1786390000,isOutgoing:false,senderId:'456',content:{text:{text:'older page'}}}],users:[{id:'456',firstName:'Alice'}],chats:[]};
        else if(a.chat?.id==='124') response={messages:[{id:5,chatId:'124',date:1786400000,isOutgoing:false,senderId:'456',content:{text:{text:'second dialog'}}}],users:[{id:'456',firstName:'Alice'}],chats:[]};
        else throw new Error('unexpected Telegram fetchMessages args '+JSON.stringify(a));
      }
      queueMicrotask(()=>{for(const fn of this.listeners)fn({data:{type:'messageResponse',token:data.token,messageId:data.messageId,response}})});
    }
    close(){}
  }
  const localStorage=new LS({account1:JSON.stringify({dcId:2,userId:'999'})}); const sessionStorage=new LS();
  const location={pathname:'/a/',href:'https://web.telegram.org/a/',hash:'',reload(){}};
  const document={documentElement:{},querySelector(){return null},querySelectorAll(){return[]},createTextNode:t=>({textContent:t})};
  const window={addEventListener(){},removeEventListener(){},Debug:{}};
  const FakeDate=class extends Date{static t=1786400000000;static now(){this.t+=9000;return this.t}};
  const ctx={window,document,location,indexedDB,localStorage,sessionStorage,BroadcastChannel:BC,MutationObserver:MO,Date:FakeDate,Number,String,Boolean,JSON,Set,Map,Object,Promise,URL,Math,console:logger(envelopes),queueMicrotask,setTimeout:(fn,ms)=>{if(ms>=20000)return 1;queueMicrotask(fn);return 1},clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  vm.createContext(ctx); vm.runInContext(code,ctx,{timeout:3000}); await flush(180);
  const msgs=envelopes.filter(x=>x.kind==='message'&&x.payload?.providerEvent==='telegram-web-a-api-fetchMessages');
  const chatCalls=apiCalls.filter(x=>x.name==='fetchChats');
  const historyCalls=apiCalls.filter(x=>x.name==='fetchMessages');
  assert(chatCalls.some(x=>Number(x.args?.[0]?.offsetId)===200),'Telegram GetDialogs pagination missing');
  assert(historyCalls.some(x=>x.args?.[0]?.chat?.id==='123'&&Number(x.args?.[0]?.offsetId)===101),'Telegram GetHistory offset pagination missing');
  assert(msgs.some(x=>x.payload.text==='incoming API'&&x.payload.senderName==='Alice'&&x.payload.direction==='incoming'),'Telegram incoming API message missing');
  assert(msgs.some(x=>x.payload.text==='outgoing API'&&x.payload.direction==='outgoing'),'Telegram outgoing API message missing');
  assert(msgs.some(x=>x.payload.text==='older page'),'Telegram older history page missing');
  assert(msgs.some(x=>x.payload.text==='second dialog'&&x.payload.conversationId==='124'),'Telegram second dialog missing');
  const done=envelopes.find(x=>x.kind==='status'&&x.status==='telegram-api-history-snapshot-complete');
  assert(done?.details?.chats===2&&done?.details?.dialogPages>=3&&done?.details?.historyPages>=3,'Telegram full dialog/history completion counts wrong');
}

// Teams Free: all conversations from IDB, Chat Service backwardLink, token refresh per page, one network retry.
{
  const code=bridge('TEAMS_BRIDGE','SIGNAL_BRIDGE'); const envelopes=[];
  const rawKey=webcrypto.getRandomValues(new Uint8Array(32));
  const makeEntry=async token=>{
    const iv=webcrypto.getRandomValues(new Uint8Array(16));
    const aes=await webcrypto.subtle.importKey('raw',rawKey,{name:'AES-CBC'},false,['encrypt']);
    const cipher=new Uint8Array(await webcrypto.subtle.encrypt({name:'AES-CBC',iv},aes,new TextEncoder().encode(token)));
    return {encryptedToken:Buffer.from(cipher).toString('base64url'),iv:Buffer.from(iv).toString('base64url'),expiration:Date.now()+600000,regionGtms:{chatService:'https://msgapi.teams.live.com'},userDetails:{skypeid:'me'}};
  };
  const token1='header.'+Buffer.from(JSON.stringify({skypeid:'me',v:1})).toString('base64url')+'.sig';
  const token2='header.'+Buffer.from(JSON.stringify({skypeid:'me',v:2})).toString('base64url')+'.sig';
  const entry1=await makeEntry(token1); const entry2=await makeEntry(token2);
  const tokenKey='tmp.auth.v1.cid.Discover.SKYPE-TOKEN';
  const localStorage=new LS({
    'tmp.auth.v1.GLOBAL.ExportedEncryptionKey.ExportedEncryptionKey':JSON.stringify({item:{exportedKey:Buffer.from(rawKey).toString('base64url')}}),
    [tokenKey]:JSON.stringify({item:entry1}),
  });
  const convId='19:test@thread.v2';
  const convRows=[{id:'48:notes',lastMessageTimeUtc:1786400300000,chatTitle:{shortTitle:'Notes'},threadProperties:{threadType:'streamofnotes'}},{id:convId,lastMessageTimeUtc:1786400200000,chatTitle:{shortTitle:'Local Thread'},threadProperties:{threadType:'chat'}}];
  const indexedDB={async databases(){return[{name:'Teams:conversation-manager:test',version:1}]},open(){const req={};queueMicrotask(()=>{const db={objectStoreNames:{contains:n=>n==='conversations'},transaction(){return {objectStore(){return {getAll(){const r={};queueMicrotask(()=>{r.result=convRows;r.onsuccess?.()});return r}}}}},close(){}};req.result=db;req.onsuccess?.()});return req}};
  const calls=[]; let page2Attempts=0;
  const fetch=async (url,init={})=>{
    const u=String(url); const auth=String(init?.headers?.authentication||init?.headers?.Authorization||''); calls.push({u,auth});
    if(u.includes('/messages?')){
      assert(auth.includes(token1),'Teams first page did not use current token');
      localStorage.setItem(tokenKey,JSON.stringify({item:entry2}));
      return {ok:true,status:200,statusText:'OK',headers:{get:()=>null},async json(){return {messages:[{id:'m2',conversationid:convId,messagetype:'RichText/Html',content:'<div>hello <b>from</b> Alice<br>&amp; team</div>',from:'8:live:alice',imdisplayname:'Alice',composetime:'2026-08-11T20:00:00Z'}],_metadata:{backwardLink:'https://teams.live.com/api/chatsvc/consumer/page2'}}}};
    }
    if(u.endsWith('/page2')){
      assert(auth.includes(token2),'Teams backwardLink page did not refresh token');
      page2Attempts+=1;
      if(page2Attempts===1)throw new TypeError('simulated transient network reset');
      return {ok:true,status:200,statusText:'OK',headers:{get:()=>null},async json(){return {messages:[{id:'m1',conversationid:convId,messagetype:'RichText/Html',content:'my older reply',from:'8:live:me',imdisplayname:'Me',composetime:'2026-08-11T19:00:00Z'}],_metadata:{}}}};
    }
    throw new Error('unexpected fetch '+u);
  };
  const sessionStorage=new LS(); const location={hostname:'teams.live.com',href:'https://teams.live.com/v2/',pathname:'/v2/'};
  const document={documentElement:{},querySelector(){return null},querySelectorAll(){return[]},createTextNode:t=>({textContent:t})}; const window={addEventListener(){},removeEventListener(){}};
  const ctx={window,document,location,indexedDB,localStorage,sessionStorage,MutationObserver:MO,Date,Number,String,Boolean,JSON,Set,Map,Object,Promise,URL,Math,console:logger(envelopes),queueMicrotask,crypto:webcrypto,TextEncoder,TextDecoder,atob,btoa,AbortController,fetch,setTimeout:(fn,ms)=>{if(ms>=12000)return 1;queueMicrotask(fn);return 1},clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  vm.createContext(ctx); vm.runInContext(code,ctx,{timeout:3000});
  await waitFor(()=>calls.some(x=>x.u.includes('/messages?pageSize=200'))&&calls.filter(x=>x.u.endsWith('/page2')).length===2&&envelopes.some(x=>x.kind==='status'&&x.status==='teams-chat-service-history-snapshot-complete'),3000);
  const msgs=envelopes.filter(x=>x.kind==='message'&&x.payload?.providerEvent==='teams-chat-service-api');
  assert(calls.some(x=>x.u.includes('/messages?pageSize=200'))&&calls.filter(x=>x.u.endsWith('/page2')).length===2,'Teams backwardLink/network retry missing');
  assert(!calls.some(x=>x.u.includes('48%3Anotes')||x.u.includes('48:notes')),'Teams 48:notes must not be sent to normal Chat Service history endpoint');
  assert(envelopes.some(x=>x.kind==='status'&&x.status==='teams-chat-service-special-conversation-local-only'&&x.details?.conversationId==='48:notes'),'Teams 48:notes special-conversation gate status missing');
  assert(msgs.some(x=>x.payload.text==='hello from Alice\n& team'&&x.payload.direction==='incoming'&&x.payload.senderName==='Alice'),'Teams incoming API message missing');
  assert(msgs.some(x=>x.payload.text==='my older reply'&&x.payload.direction==='outgoing'),'Teams outgoing API message missing');
  assert(envelopes.some(x=>x.kind==='status'&&x.status==='teams-chat-service-history-snapshot-complete'&&x.details?.pages===2),'Teams API completion missing');
}


// Teams Free fallback: no cached Discover.SKYPE-TOKEN; use cached SKYPE-AUTHZ-URL + MSAL Skype token,
// then consume authz's skypeToken.skypetoken as the messaging token.
{
  const code=bridge('TEAMS_BRIDGE','SIGNAL_BRIDGE'); const envelopes=[];
  const now=Math.floor(Date.now()/1000);
  const skypeMsal='header.'+Buffer.from(JSON.stringify({skypeid:'me'})).toString('base64url')+'.sig';
  const localStorage=new LS({
    'msal.2|me.consumer|login.microsoftonline.com|accesstoken|client|realm|api.fl.spaces.skype.com|':JSON.stringify({secret:skypeMsal,expiresOn:String(now+3600)}),
    'tmp.auth.v1.cid.Discover.SKYPE-AUTHZ-URL':JSON.stringify({item:'https://teams.live.com/api/authz/consumer'}),
  });
  const convId='19:fallback@thread.v2';
  const convRows=[{id:convId,lastMessageTimeUtc:1786400200000,chatTitle:{shortTitle:'Fallback Thread'},threadProperties:{threadType:'chat'}}];
  const indexedDB={async databases(){return[{name:'Teams:conversation-manager:fallback',version:1}]},open(){const req={};queueMicrotask(()=>{const db={objectStoreNames:{contains:n=>n==='conversations'},transaction(){return {objectStore(){return {getAll(){const r={};queueMicrotask(()=>{r.result=convRows;r.onsuccess?.()});return r}}}}},close(){}};req.result=db;req.onsuccess?.()});return req}};
  const fetchCalls=[];
  const fetch=async (url,init={})=>{
    const u=String(url); fetchCalls.push({u,headers:init.headers||{}});
    if(u==='https://teams.live.com/api/authz/consumer'){
      assert(String(init.headers?.Authorization||'').includes(skypeMsal),'Teams Free authz fallback did not use MSAL Skype token');
      return {ok:true,status:200,statusText:'OK',headers:{get:()=>null},async json(){return {regionGtms:{chatService:'https://msgapi.teams.live.com'},skypeToken:{skypetoken:'authz-messaging-token'}}}};
    }
    if(u.includes('/messages?')){
      assert(String(init.headers?.authentication||'')==='skypetoken=authz-messaging-token','Teams Free authz messaging token not used by chat service');
      return {ok:true,status:200,statusText:'OK',headers:{get:()=>null},async json(){return {messages:[{id:'f1',conversationid:convId,messagetype:'RichText/Html',content:'authz fallback message',from:'8:live:alice',imdisplayname:'Alice',composetime:'2026-08-11T20:00:00Z'}],_metadata:{}}}};
    }
    throw new Error('unexpected Teams Free fallback fetch '+u);
  };
  const sessionStorage=new LS(); const location={hostname:'teams.live.com',href:'https://teams.live.com/v2/',pathname:'/v2/'};
  const document={documentElement:{},querySelector(){return null},querySelectorAll(){return[]},createTextNode:t=>({textContent:t})}; const window={addEventListener(){},removeEventListener(){}};
  const ctx={window,document,location,indexedDB,localStorage,sessionStorage,MutationObserver:MO,Date,Number,String,Boolean,JSON,Set,Map,Object,Promise,URL,Math,console:logger(envelopes),queueMicrotask,crypto:webcrypto,TextEncoder,TextDecoder,atob,btoa,AbortController,AbortSignal,fetch,setTimeout:(fn,ms)=>{if(ms>=12000)return 1;queueMicrotask(fn);return 1},clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  vm.createContext(ctx); vm.runInContext(code,ctx,{timeout:3000});
  await waitFor(()=>fetchCalls.some(x=>x.u==='https://teams.live.com/api/authz/consumer')&&envelopes.some(x=>x.kind==='message'&&x.payload?.providerEvent==='teams-chat-service-api'&&x.payload?.text==='authz fallback message'),3000);
  assert(fetchCalls.some(x=>x.u==='https://teams.live.com/api/authz/consumer'),'Teams Free authz fallback was not called');
  assert(envelopes.some(x=>x.kind==='message'&&x.payload?.providerEvent==='teams-chat-service-api'&&x.payload?.text==='authz fallback message'),'Teams Free authz fallback message missing');
}

// Signal 8.17.0: loadNewestMessages may center on oldest-unseen; prove both newer + older SQL paging,
// and prove ConversationController.getAll() can enumerate a conversation absent from Redux presentation lookup.
{
  const marker='const SIGNAL_HISTORY_PRIME_SCRIPT = String.raw`'; const start=source.indexOf(marker); assert(start>=0,'Signal prime missing');
  const bodyStart=source.indexOf('`',start)+1; const bodyEnd=source.indexOf('`;',bodyStart); const code=source.slice(bodyStart,bodyEnd);
  const state={conversations:{conversationLookup:{s1:{id:'s1',title:'Alice'}},conversationsByServiceId:{aciAlice:'s1'},conversationsByE164:{},messagesByConversation:{},messagesLookup:{}}};
  const actions={
    messagesAdded(_payload){ /* Simulates Signal thunk refusing Redux update while not on Chats tab. */ },
    messagesReset(_payload){ /* same */ },
  };
  let forcedNewest=false;
  const msg=(id,body,sent,type='incoming')=>({id,conversationId:'c1',body,sent_at:sent,received_at:sent,type,sourceServiceId:type==='incoming'?'aciAlice':''});
  const newest=msg('n3','Aug 11 newest',1786400300000);
  const middle=msg('n2','Aug 10 unread-center',1786313900000);
  const oldest=msg('n1','Aug 09 oldest',1786227500000);
  const model={
    attributes:{id:'c1',title:'Signal Chat',activeAt:3},
    async loadNewestMessages(_id,force){forcedNewest=force===true; actions.messagesReset({conversationId:'c1',messages:[middle]});},
    async loadNewerMessages(id){if(id==='n2')actions.messagesAdded({conversationId:'c1',messages:[newest]});},
    async loadOlderMessages(id){if(id==='n2')actions.messagesAdded({conversationId:'c1',messages:[oldest]});},
  };
  const controller={get:id=>id==='c1'?model:null,getAll:()=>[model]};
  const ctx={reduxStore:{getState:()=>state},ConversationController:controller,reduxActions:{conversations:actions},Object,String,Array,Number,Promise,Map,Set,setTimeout:(fn)=>{fn();return 1}};
  vm.createContext(ctx); const result=await vm.runInContext(code,ctx,{timeout:3000});
  assert(result.ok&&result.intercepted===true,'Signal action interception not installed');
  assert(forcedNewest,'Signal newest local SQL load was not forced past preload cache');
  assert(result.attempted===1,'Signal ConversationController.getAll enumeration failed');
  assert(result.pages>=4,'Signal newer+older paging did not run to both EOFs');
  assert(result.messages?.length===3,'Signal bidirectional local SQL pages missing messages');
  assert(result.messages.some(x=>x.text==='Aug 11 newest')&&result.messages.some(x=>x.text==='Aug 10 unread-center')&&result.messages.some(x=>x.text==='Aug 09 oldest'),'Signal newer/center/older history incomplete');
  assert(Object.keys(state.conversations.messagesLookup).length===0,'Signal harness must prove capture independent of Redux cache');
}

console.log('HISTORY_CAPTURE_RUNTIME_HARNESS_OK');
console.log('telegram-official-api-upstream-transport/teams-chat-service-refresh+retry+48-special-gate+authz-fallback/whatsapp-native-exportchat-text-types/signal-8.17.0-controller-getAll+newer+older-pre-redux-sql=PASS');
