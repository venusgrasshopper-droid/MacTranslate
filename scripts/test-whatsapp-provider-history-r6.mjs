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
const mk=(id,body,t)=>({isNewMsg:false,type:'chat',body,t,id:{fromMe:false,remote,id,_serialized:`false_${remoteString}_${id}`},from:remote,to:self});
const newest=mk('N1','august local',1786400100);
const july2=mk('J2','july 19 provider',1784400100);
const july1=mk('J1','july 17 provider',1784227300);
const msgs=new Collection();
msgs.models=[newest];
msgs.getModelsArray=()=>msgs.models.slice();
msgs.head=()=>msgs.models[0]||null;
msgs.msgLoadState={noEarlierMsgs:false,isLoadingEarlierMsgs:false};
const chat={id:remote,formattedTitle:'July Chat',msgs};
const Msg=new Collection();Msg.getModelsArray=()=>[newest];
const Chat=new Collection();Chat.getModelsArray=()=>[chat];Chat.get=x=>String(x?._serialized||x)===remoteString?chat:null;
let providerCalls=0;
const loader={async loadEarlierMsgs({chat:c}){
  assert(c===chat,'wrong live chat passed to loadEarlierMsgs');
  providerCalls++;
  if(providerCalls===1){msgs.models=[july2,newest];return [july2]}
  if(providerCalls===2){msgs.models=[july1,july2,newest];return [july1]}
  msgs.msgLoadState.noEarlierMsgs=true;return [];
}};
const finder={async msgFindBefore({anchor}){
  if(anchor?.remote) return {status:200,messages:[newest]};
  return {status:200,messages:[]};
}};
const modules={
  WATagsLogger:{whenReady:()=>Promise.resolve()},
  WAWebCollections:{Msg,Chat,Contact:{get:()=>null}},
  WAWebSchemaChat:{getChatTable:()=>({all:async()=>[{id:remoteString,name:'July Chat'}]})},
  WAWebWidFactory:{createWid:()=>remote},
  WAWebDBMessageFindLocal:finder,
  WAWebChatLoadMessages:loader,
  WAWebSchemaContact_DO_NOT_USE_DIRECTLY:{getContactTable:()=>({all:async()=>[]})},
};
const window={Debug:{VERSION:'test'},require:n=>modules[n]||null,addEventListener(){},removeEventListener(){}};
const ctx={window,document:{documentElement:{}},queueMicrotask,Date,Number,String,Boolean,JSON,Set,Map,Object,Promise,console:consoleObj,setTimeout:(fn)=>{queueMicrotask(fn);return 1},clearTimeout(){}};
vm.createContext(ctx);vm.runInContext(code,ctx,{timeout:3000});
for(let i=0;i<120;i++) await new Promise(r=>setImmediate(r));
const rows=envelopes.filter(x=>x.kind==='message').map(x=>x.payload);
assert(providerCalls>=3,'provider history loader did not continue until EOF');
assert(rows.some(x=>x.text==='july 19 provider'&&x.providerEvent==='whatsapp-wawebchatloadmessages-history'),'July 19 provider message missing');
assert(rows.some(x=>x.text==='july 17 provider'&&x.providerEvent==='whatsapp-wawebchatloadmessages-history'),'July 17 provider message missing');
const done=envelopes.find(x=>x.kind==='status'&&x.status==='whatsapp-history-snapshot-complete');
assert(done?.details?.networkPages===2,'provider page count mismatch');
assert(done?.details?.networkCaptured>=2,'provider capture count mismatch');
console.log('WHATSAPP_PROVIDER_HISTORY_R6_HARNESS_OK');
console.log('local-exportchat-then-provider-loadEarlierMsgs-until-eof=PASS');
