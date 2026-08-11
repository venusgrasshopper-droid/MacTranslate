#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
const source=fs.readFileSync(path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts'),'utf8');
function rawConst(name,next){
  const start=source.indexOf(`const ${name} = String.raw\``);
  if(start<0) throw new Error(name+' missing');
  const bodyStart=source.indexOf('`',start)+1;
  const end=source.indexOf(next?`const ${next} = String.raw\``:'function scriptFor',bodyStart);
  const bodyEnd=source.lastIndexOf('`;',end);
  return source.slice(bodyStart,bodyEnd);
}
const shared=rawConst('BRIDGE_SHARED','WHATSAPP_BRIDGE').replace('${JSON.stringify(CONSOLE_PREFIX)}',JSON.stringify('__MACTRANSLATE_REAL_MESSAGE_V6__'));
const bridge=rawConst('WHATSAPP_BRIDGE','TELEGRAM_BRIDGE').replace('${BRIDGE_SHARED}',shared);
class Collection extends EventEmitter { off(e,f){return super.off(e,f)} }
class Model extends EventEmitter { constructor(v){super();Object.assign(this,v)} serialize(){return {...this}} }
const remote={_serialized:'15551234567@c.us'};
const group={_serialized:'120363000000000000@g.us'};
const author={_serialized:'15557654321@c.us'};
const historical=[
 new Model({isNewMsg:false,type:'chat',body:'old direct',t:1699999900,id:{fromMe:false,remote,id:'H1',_serialized:'false_15551234567@c.us_H1'},from:remote}),
 new Model({isNewMsg:false,type:'chat',body:'old outgoing',t:1699999950,id:{fromMe:true,remote,id:'H2',_serialized:'true_15551234567@c.us_H2'},from:{_serialized:'15550001111@c.us'},to:remote}),
 new Model({isNewMsg:false,type:'chat',body:'old group',t:1699999990,id:{fromMe:false,remote:group,id:'H3',_serialized:'false_120363000000000000@g.us_H3'},from:group,author}),
 new Model({isNewMsg:false,type:'image',body:'ignored image',t:1699999991,id:{fromMe:false,remote,id:'H4',_serialized:'false_15551234567@c.us_H4'},from:remote}),
];
const Msg=new Collection(); Msg.getModelsArray=()=>historical.slice();
const chats=new Map([[remote._serialized,{formattedTitle:'Alice'}],[group._serialized,{formattedTitle:'Work Group'}]]);
const contacts=new Map([[remote._serialized,{formattedName:'Alice Sender'}],[author._serialized,{pushname:'Carol'}]]);
const envelopes=[]; const listeners={};
const window={
  Debug:{VERSION:'2.3000.test'},
  require(name){return name==='WAWebCollections'?{Msg,Chat:{get:k=>chats.get(k?._serialized||k)},Contact:{get:k=>contacts.get(k?._serialized||k)}}:undefined},
  addEventListener(name,cb){listeners[name]=cb}, removeEventListener(name){delete listeners[name]},
};
const context={
  window,document:{documentElement:{}},queueMicrotask,Date,Number,String,Boolean,JSON,Set,Map,
  console:{info(v){const p='__MACTRANSLATE_REAL_MESSAGE_V6__';if(String(v).startsWith(p))envelopes.push(JSON.parse(String(v).slice(p.length)))}},
  setTimeout:(fn)=>{queueMicrotask(fn); return 1}, clearTimeout:()=>{},
};
vm.createContext(context); vm.runInContext(bridge,context,{timeout:3000});
await new Promise(r=>setImmediate(r));
const assert=(v,m)=>{if(!v)throw new Error(m)};
const rows=envelopes.filter(x=>x.kind==='message'&&x.payload?.providerEvent==='whatsapp-wawebcollections-history-snapshot').map(x=>x.payload);
const done=envelopes.find(x=>x.kind==='status'&&x.status==='whatsapp-history-snapshot-complete');
assert(rows.length===3,'expected 3 historical text rows, got '+rows.length);
assert(rows.some(x=>x.text==='old direct'&&x.direction==='incoming'),'incoming history missing');
assert(rows.some(x=>x.text==='old outgoing'&&x.direction==='outgoing'),'outgoing history missing');
assert(rows.some(x=>x.text==='old group'&&x.senderId===author._serialized),'group history missing');
assert(done?.details?.scanned===3,'history scanned count should filter non-text before scan');
assert(done?.details?.captured===3,'history captured count mismatch');
assert(!bridge.includes('.loadEarlierMsgs('),'bridge must not page network history');
console.log('WHATSAPP_HISTORY_V722_HARNESS_OK');
console.log('loaded-history incoming/outgoing/group/text-filter/no-network-paging=PASS');
