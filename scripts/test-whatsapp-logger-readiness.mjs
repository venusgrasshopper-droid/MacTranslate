#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const source = fs.readFileSync(
  path.join(root, 'src/electron/message-recognition/UnifiedMessageRecognition.ts'),
  'utf8',
);

function rawConst(name, next) {
  const start = source.indexOf(`const ${name} = String.raw\``);
  if (start < 0) throw new Error(`${name} missing`);
  const bodyStart = source.indexOf('`', start) + 1;
  const end = source.indexOf(
    next ? `const ${next} = String.raw\`` : 'function scriptFor',
    bodyStart,
  );
  const bodyEnd = source.lastIndexOf('`;', end);
  return source.slice(bodyStart, bodyEnd);
}

const shared = rawConst('BRIDGE_SHARED', 'WHATSAPP_BRIDGE').replace(
  '${JSON.stringify(CONSOLE_PREFIX)}',
  JSON.stringify('__MACTRANSLATE_REAL_MESSAGE_V6__'),
);
const bridge = rawConst('WHATSAPP_BRIDGE', 'TELEGRAM_BRIDGE').replace(
  '${BRIDGE_SHARED}',
  shared,
);

class Collection extends EventEmitter {
  off(event, handler) { return super.off(event, handler); }
  getModelsArray() { return []; }
}

const Msg = new Collection();
let resolveLogger;
const loggerReady = new Promise(resolve => { resolveLogger = resolve; });
const requireCalls = [];
const modules = {
  WATagsLogger: { whenReady: () => loggerReady },
  WAWebCollections: {
    Msg,
    Chat: { get: () => null },
    Contact: { get: () => null },
  },
};

const window = {
  Debug: { VERSION: '2.3000.test' },
  require(name) {
    requireCalls.push(name);
    return modules[name];
  },
  addEventListener() {},
  removeEventListener() {},
};

const context = {
  window,
  document: { documentElement: {} },
  queueMicrotask,
  setTimeout,
  clearTimeout,
  console: { info() {} },
  Date,
  Number,
  String,
  Boolean,
  JSON,
  Set,
  Map,
  Promise,
};

vm.createContext(context);
vm.runInContext(bridge, context, { timeout: 3000 });
await new Promise(resolve => setImmediate(resolve));

if (requireCalls.includes('WAWebCollections')) {
  throw new Error('WAWebCollections was required before WATagsLogger.whenReady resolved');
}
if (Msg.listenerCount('add') !== 0) {
  throw new Error('message listener installed before WhatsApp logger readiness');
}

resolveLogger();
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));

if (!requireCalls.includes('WAWebCollections')) {
  throw new Error('WAWebCollections was not required after logger readiness');
}
if (Msg.listenerCount('add') !== 1) {
  throw new Error('message listener not installed exactly once after logger readiness');
}

console.log('WHATSAPP_LOGGER_READINESS_HARNESS_OK');
console.log('WATagsLogger.whenReady-before-WAWebCollections=PASS');
