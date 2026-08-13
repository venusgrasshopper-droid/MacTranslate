#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
const source=fs.readFileSync(path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts'),'utf8');
const PREFIX='__MACTRANSLATE_REAL_MESSAGE_V6__';
const start=source.indexOf('const BRIDGE_SHARED = String.raw`');
const sharedStart=source.indexOf('`',start)+1;
const waStart=source.indexOf('const WHATSAPP_BRIDGE = String.raw`');
const sharedEnd=source.lastIndexOf('`;',waStart);
const shared=source.slice(sharedStart,sharedEnd).replace('${JSON.stringify(CONSOLE_PREFIX)}',JSON.stringify(PREFIX));
const bodyStart=source.indexOf('`',waStart)+1;
const tgStart=source.indexOf('const TELEGRAM_BRIDGE = String.raw`',bodyStart);
const bodyEnd=source.lastIndexOf('`;',tgStart);
const code=source.slice(bodyStart,bodyEnd).replace('${BRIDGE_SHARED}',shared);
const assert=(v,m)=>{if(!v) throw new Error(m)};
const envelopes=[];
const consoleObj={info(v){const x=String(v);if(x.startsWith(PREFIX)) envelopes.push(JSON.parse(x.slice(PREFIX.length)))},warn(){},error(){},log(){}};
class Collection extends EventEmitter{off(e,f){return super.off(e,f)}}
const remoteString='15551234567@c.us';
const remote={_serialized:remoteString,toString(){return this._serialized}};
const self={_serialized:'15550000000@c.us',toString(){return this._serialized}};
const mk=(id,body,t,fromMe=false)=>({isNewMsg:false,type:'chat',body,t,id:{fromMe,remote,id,_serialized:`${fromMe?'true':'false'}_${remoteString}_${id}`},from:fromMe?self:remote,to:fromMe?remote:self});
const july17=mk('J17','july 17 already resident',1784227300,false);
const july19=mk('J19','july 19 already resident',1784400100,true);
const aug8=mk('A8','august 8 already resident',1786400100,false);
const msgs=new Collection();
msgs.models=[july17,july19,aug8];
msgs.getModelsArray=()=>msgs.models.slice();
msgs.head=()=>msgs.models[0]||null;
// Critical real-world condition: UI already hydrated the resident history and
// WhatsApp marks the collection complete. R6 skipped the whole chat here.
msgs.msgLoadState={noEarlierMsgs:true,isLoadingEarlierMsgs:false};
const chat={id:remote,formattedTitle:'Resident July Chat',msgs};
const Msg=new Collection(); Msg.getModelsArray=()=>[aug8];
const Chat=new Collection(); Chat.getModelsArray=()=>[chat]; Chat.get=x=>String(x?._serialized||x)===remoteString?chat:null;
let providerCalls=0;
const loader={async loadEarlierMsgs(){providerCalls++;return []}};
const finder={async msgFindBefore({anchor}){ if(anchor?.remote) return {status:200,messages:[aug8]}; return {status:200,messages:[]}; }};
const modules={
  WATagsLogger:{whenReady:()=>Promise.resolve()},
  WAWebCollections:{Msg,Chat,Contact:{get:()=>null}},
  WAWebSchemaChat:{getChatTable:()=>({all:async()=>[{id:remoteString,name:'Resident July Chat'}]})},
  WAWebWidFactory:{createWid:()=>remote},
  WAWebDBMessageFindLocal:finder,
  WAWebChatLoadMessages:loader,
  WAWebSchemaContact_DO_NOT_USE_DIRECTLY:{getContactTable:()=>({all:async()=>[]})},
};
const window={Debug:{VERSION:'test'},require:n=>modules[n]||null,addEventListener(){},removeEventListener(){}};
const ctx={window,document:{documentElement:{}},queueMicrotask,Date,Number,String,Boolean,JSON,Set,Map,Object,Promise,console:consoleObj,setTimeout:(fn)=>{queueMicrotask(fn);return 1},clearTimeout(){}};
vm.createContext(ctx); vm.runInContext(code,ctx,{timeout:3000});
for(let i=0;i<100;i++) await new Promise(r=>setImmediate(r));
const rows=envelopes.filter(x=>x.kind==='message').map(x=>x.payload);
assert(rows.some(x=>x.text==='july 17 already resident'&&x.providerEvent==='whatsapp-chat-resident-history'),'resident July 17 message missing');
assert(rows.some(x=>x.text==='july 19 already resident'&&x.providerEvent==='whatsapp-chat-resident-history'),'resident July 19 message missing');
assert(rows.some(x=>x.text==='august 8 already resident'),'resident August message missing');
assert(providerCalls===0,'loadEarlierMsgs must not be required when noEarlierMsgs=true');
const done=envelopes.find(x=>x.kind==='status'&&x.status==='whatsapp-history-snapshot-complete');
assert((done?.details?.residentCaptured||0)>=2,'resident capture status did not record hydrated rows');
console.log('WHATSAPP_RESIDENT_HISTORY_R7_HARNESS_OK');
console.log('chat.msgs-first/noEarlierMsgs-still-captured/july-visible-history=PASS');
