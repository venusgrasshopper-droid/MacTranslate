#!/usr/bin/env node
import fs from 'node:fs';

const root = process.argv[2] || process.cwd();
const index = fs.readFileSync(`${root}/src/index.ts`, 'utf8');
const recog = fs.readFileSync(`${root}/src/electron/message-recognition/UnifiedMessageRecognition.ts`, 'utf8');

const must = (ok, msg) => { if (!ok) throw new Error(msg); };
must(index.includes('.app{height:100%;min-height:0;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}'), 'viewer app grid is not height-constrained');
must(index.includes('.main{min-height:0;overflow:hidden;display:grid;grid-template-columns:300px minmax(0,1fr)}'), 'viewer main is not height-constrained');
must(index.includes('.content{min-width:0;min-height:0;overflow:hidden;'), 'viewer content is not shrinkable');
must(index.includes('.messages{min-height:0;overflow-y:auto;overflow-x:hidden;'), 'viewer messages is not independently scrollable');
must(recog.includes("typeof controller.getAll === 'function'"), 'Signal does not enumerate ConversationController.getAll()');
must(recog.includes("typeof model.loadNewerMessages === 'function'"), 'Signal newer paging missing');
must(recog.includes('await model.loadNewerMessages(newestId)'), 'Signal newer paging call missing');
must(recog.includes('await model.loadOlderMessages(oldestId)'), 'Signal older paging call missing');
console.log('R5_SIGNAL_AND_VIEWER_VERIFY_OK');
console.log('viewer-independent-scroll/signal-controller-getAll/newer+older-paging=PASS');
