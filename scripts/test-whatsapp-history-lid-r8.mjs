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

const pnString='18002428478@c.us';
const lidString='123456789012345@lid';
const selfString='15550000000@c.us';
const widObj=s=>({_serialized:s,toString(){return this._serialized}});
const pn=widObj(pnString), lid=widObj(lidString), self=widObj(selfString);
const mk=(id,body,t,remote=lid)=>({
  isNewMsg:false,type:'chat',body,t,
  id:{fromMe:false,remote,id,_serialized:`false_${remote._serialized}_${id}`},
  from:remote,to:self,
});
const aug8=mk('A8','august local row',1786400100);
const july17=mk('J17','july 17 via historyChatId',1784227300);
const july19Late=mk('J19','july 19 loaded after startup',1784400100);

const msgs=new Collection();
msgs.models=[];
msgs.getModelsArray=()=>msgs.models.slice();
msgs.head=()=>msgs.models[0]||null;
msgs.msgLoadState={noEarlierMsgs:true,isLoadingEarlierMsgs:false};
const chat={id:pn,formattedTitle:'+1 (800) 242-8478',msgs};
const Msg=new Collection(); Msg.getModelsArray=()=>[];
const Chat=new Collection(); Chat.getModelsArray=()=>[chat]; Chat.get=x=>String(x?._serialized||x)===pnString?chat:null;

const historyRow={id:lidString,historyChatId:pnString,name:'+1 (800) 242-8478'};
let bulkCalls=0;
const bulkHistory={async bulkGetChatsMaybeByHistory(ids){
  bulkCalls++;
  assert(ids.length===1,'bulk history input size mismatch');
  assert(String(ids[0]?._serialized||ids[0])===pnString,'bulk history must receive live PN Wid');
  return [historyRow];
}};
let finderFirstRemote='';
let finderCalls=0;
const finder={async msgFindBefore({anchor}){
  finderCalls++;
  if(anchor?.remote){
    finderFirstRemote=String(anchor.remote?._serialized||anchor.remote);
    return {status:200,messages:[july17,aug8]};
  }
  return {status:200,messages:[]};
}};
const loader={async loadEarlierMsgs(){throw new Error('provider loader should not be required in this noEarlierMsgs harness')}};
const modules={
  WATagsLogger:{whenReady:()=>Promise.resolve()},
  WAWebCollections:{Msg,Chat,Contact:{get:()=>null}},
  WAWebSchemaChat:{getChatTable:()=>({all:async()=>[historyRow]})},
  WAWebApiChatBulkGetByHistory:bulkHistory,
  WAWebWidFactory:{createWid:s=>s===lidString?lid:s===pnString?pn:widObj(String(s))},
  WAWebDBMessageFindLocal:finder,
  WAWebChatLoadMessages:loader,
  WAWebSchemaContact_DO_NOT_USE_DIRECTLY:{getContactTable:()=>({all:async()=>[]})},
};
const window={Debug:{VERSION:'test'},require:n=>modules[n]||null,addEventListener(){},removeEventListener(){}};
const ctx={window,document:{documentElement:{}},queueMicrotask,Date,Number,String,Boolean,JSON,Set,Map,Object,Promise,console:consoleObj,setTimeout:(fn)=>{queueMicrotask(fn);return 1},clearTimeout(){}};
vm.createContext(ctx); vm.runInContext(code,ctx,{timeout:3000});
for(let i=0;i<120;i++) await new Promise(r=>setImmediate(r));

assert(bulkCalls>=1,'WAWebApiChatBulkGetByHistory was not used');
assert(finderCalls>=1,'local history finder was not used');
assert(finderFirstRemote===lidString,`history DB paging used wrong remote: ${finderFirstRemote}`);
let rows=envelopes.filter(x=>x.kind==='message').map(x=>x.payload);
const july=rows.find(x=>x.text==='july 17 via historyChatId');
assert(july,'historyChatId July row missing');
assert(july.conversationId===pnString,`LID history row not canonicalized to live PN: ${july.conversationId}`);
assert(july.conversationTitle==='+1 (800) 242-8478','canonical conversation title missing');

// Critical second regression: opening/scrolling a chat can hydrate additional old
// rows after startup. They are not isNewMsg, and may be emitted only by chat.msgs.
msgs.models.push(july19Late);
msgs.emit('add',july19Late);
for(let i=0;i<20;i++) await new Promise(r=>setImmediate(r));
rows=envelopes.filter(x=>x.kind==='message').map(x=>x.payload);
const late=rows.find(x=>x.text==='july 19 loaded after startup');
assert(late,'late resident historical row was dropped');
assert(late.providerEvent==='whatsapp-chat-msgs-history-add',`wrong late-history providerEvent: ${late?.providerEvent}`);
assert(late.conversationId===pnString,'late LID row not canonicalized to PN');

console.log('WHATSAPP_HISTORY_LID_R8_HARNESS_OK');
console.log('historyChatId-lid-storage/live-pn-canonical/late-chat-msgs-history-add=PASS');
