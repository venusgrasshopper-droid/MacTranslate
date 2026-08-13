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
const shared=rawConst('BRIDGE_SHARED','WHATSAPP_BRIDGE').replace('${JSON.stringify(CONSOLE_PREFIX)}', JSON.stringify('__MACTRANSLATE_REAL_MESSAGE_V6__'));
const bridge=rawConst('WHATSAPP_BRIDGE','TELEGRAM_BRIDGE').replace('${BRIDGE_SHARED}',shared);

class ModelEmitter extends EventEmitter { off(e,f){ return super.off(e,f); } }
class MsgModel extends EventEmitter {
  constructor(v){ super(); Object.assign(this,v); }
  get(k){ return this[k]; }
  serialize(){ return {...this}; }
}
const Msg=new ModelEmitter();
const chats=new Map(); const contacts=new Map();
const me={_serialized:'15550001111@c.us'};
let collectionsReady=true;
const modules={
  WATagsLogger:{ whenReady:()=>Promise.resolve() },
  WAWebCollections:{ Msg, Chat:{get:k=>chats.get(k?._serialized||k)}, Contact:{get:k=>contacts.get(k?._serialized||k)} },
};
const envelopes=[];
const listeners={};
const window={
  Debug:{VERSION:'2.3000.test'},
  require(name){ if(name==='WAWebCollections'&&!collectionsReady) return undefined; return modules[name]; },
  addEventListener(name,cb){ listeners[name]=cb; },
  removeEventListener(name){ delete listeners[name]; },
};
const context={
  window,
  document:{documentElement:{}},
  queueMicrotask,
  console:{info(v){ const prefix='__MACTRANSLATE_REAL_MESSAGE_V6__'; if(String(v).startsWith(prefix)) envelopes.push(JSON.parse(String(v).slice(prefix.length))); }},
  Date, Number, String, Boolean, JSON, Set, Map,
};
vm.createContext(context); vm.runInContext(bridge,context,{timeout:3000});
await new Promise(r=>setImmediate(r));
const assert=(cond,msg)=>{ if(!cond) throw new Error(msg); };
assert(Msg.listenerCount('add')===1,'add listener not installed exactly once');
assert(Msg.listenerCount('change:type')===0,'global change:type listener must not be installed');

const remote1={_serialized:'15551234567@c.us'};
chats.set(remote1._serialized,{formattedTitle:'Alice'});
contacts.set(remote1._serialized,{formattedName:'Alice Sender'});
Msg.emit('add',new MsgModel({isNewMsg:true,type:'chat',body:'hello',t:1700000000,id:{fromMe:false,remote:remote1,id:'A1',_serialized:'false_15551234567@c.us_A1'},from:remote1}));
const remote2={_serialized:'447700900123@c.us'};
chats.set(remote2._serialized,{formattedTitle:'Bob'});
Msg.emit('add',new MsgModel({isNewMsg:true,type:'chat',body:'sent text',t:1700000001,id:{fromMe:true,remote:remote2,id:'B1',_serialized:'true_447700900123@c.us_B1'},from:me,to:remote2}));
const group={_serialized:'120363000000000000@g.us'}, author={_serialized:'15557654321@c.us'};
chats.set(group._serialized,{formattedTitle:'Work Group'}); contacts.set(author._serialized,{pushname:'Carol'});
Msg.emit('add',new MsgModel({isNewMsg:true,type:'chat',body:'group text',t:1700000002,id:{fromMe:false,remote:group,id:'C1',_serialized:'false_120363000000000000@g.us_C1'},from:group,author}));
Msg.emit('add',new MsgModel({isNewMsg:true,type:'image',body:'ignored',t:1700000003,id:{fromMe:false,remote:remote1,id:'D1',_serialized:'false_15551234567@c.us_D1'},from:remote1}));
const cipher=new MsgModel({isNewMsg:true,type:'ciphertext',body:'',t:1700000004,id:{fromMe:false,remote:remote1,id:'E1',_serialized:'false_15551234567@c.us_E1'},from:remote1});
Msg.emit('add',cipher); cipher.type='chat'; cipher.body='decrypted'; cipher.emit('change:type',cipher);
// duplicate add must not duplicate output
Msg.emit('add',new MsgModel({isNewMsg:true,type:'chat',body:'hello',t:1700000000,id:{fromMe:false,remote:remote1,id:'A1',_serialized:'false_15551234567@c.us_A1'},from:remote1}));

const messages=envelopes.filter(x=>x.kind==='message').map(x=>x.payload);
assert(messages.length===4,'expected 4 text messages, got '+messages.length);
assert(messages[0].direction==='incoming'&&messages[0].conversationId===remote1._serialized&&messages[0].text==='hello','incoming normalization failed');
assert(messages[1].direction==='outgoing'&&messages[1].conversationId===remote2._serialized&&messages[1].accountId===me._serialized,'outgoing normalization failed');
assert(messages[2].senderId===author._serialized&&messages[2].conversationId===group._serialized,'group sender normalization failed');
assert(messages[3].text==='decrypted','ciphertext transition failed');

// Delayed provider readiness: bridge must retry with finite setTimeout backoff, not message polling.
collectionsReady=false;
const Msg2=new ModelEmitter(); modules.WAWebCollections={Msg:Msg2,Chat:{get:()=>null},Contact:{get:()=>null}};
const scheduled=[];
const window2={Debug:{VERSION:'2.3000.test'},require(name){ if(name==='WAWebCollections'&&!collectionsReady)return undefined; return modules[name]; },addEventListener(){},removeEventListener(){}};
const context2={...context,window:window2,console:{info(){}},setTimeout:(fn,delay)=>{scheduled.push({fn,delay}); return scheduled.length;},clearTimeout:()=>{}};
vm.createContext(context2); vm.runInContext(bridge,context2,{timeout:3000});
await new Promise(r=>setImmediate(r));
assert(scheduled.length===1&&scheduled[0].delay===250,'first readiness retry must be 250ms');
collectionsReady=true; scheduled.shift().fn();
assert(Msg2.listenerCount('add')===1,'delayed provider did not attach');
assert(!scheduled.some(x=>x.delay>0),'readiness retry must stop after provider attach');

console.log('WHATSAPP_V72_HARNESS_OK');
console.log('incoming/outgoing/group/ciphertext/dedupe/delayed-readiness=PASS');
