#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] || process.cwd());
const file = path.join(root, 'src/electron/message-recognition/UnifiedMessageRecognition.ts');
const s = fs.readFileSync(file, 'utf8');
const required = [
  "app.getPath('appData'), 'MacTranslate', 'MessageRecognitionV6'",
  'function extractConsoleEnvelope(arguments_: unknown[]): string',
  'pendingConsoleEnvelopes = new Map<number, string[]>()',
  "tryAttach('console-message', false)",
  'queuePendingConsoleEnvelope(contents.id, message)',
  'flushPendingConsoleEnvelopes(target)',
  "appendJsonl('messages.jsonl', row)",
  "recognizedMessageEvents.emit('message', row)",
];
for (const needle of required) {
  if (!s.includes(needle)) throw new Error(`Missing real-capture persistence guard: ${needle}`);
}
if (/console\.(?:info|log)\([^\n]*kind:\s*['\"]message/.test(s)) {
  throw new Error('Synthetic production message emitter found');
}
console.log('REAL_CAPTURE_PERSISTENCE_VERIFY_OK');
