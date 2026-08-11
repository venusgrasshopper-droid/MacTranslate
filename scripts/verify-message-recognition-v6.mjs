#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const sourcePath = path.join(root, 'src/electron/message-recognition/UnifiedMessageRecognition.ts');
const runtimePath = path.join(root, 'vendor/signal-runtime/bundles/preload/main.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');
const failures = [];
const requireText = (needle, description = needle) => { if (!source.includes(needle)) failures.push(`missing: ${description}`); };
const forbidText = (needle, description = needle) => { if (source.includes(needle)) failures.push(`forbidden: ${description}`); };

const vendorPath = path.join(root, 'vendor/message-recognition/wppconnect-wa-4.4.2.js');
if (!fs.existsSync(vendorPath)) failures.push('vendored WA-JS 4.4.2 bundle missing');
else {
  const vendor = fs.readFileSync(vendorPath);
  const digest = crypto.createHash('sha256').update(vendor).digest('hex');
  if (vendor.length !== 503710) failures.push(`WA-JS bytes mismatch: ${vendor.length}`);
  if (digest !== '967209a61b8d2e218965e0a7ec168d8b96cf38eb31749ce0cd7ec9e91e806514') failures.push(`WA-JS SHA mismatch: ${digest}`);
}

requireText("const SCHEMA = 'mactranslate-real-message-v6';", 'v6 schema');
requireText("'MessageRecognitionV6'", 'v6 log directory');
requireText('__MACTRANSLATE_REAL_MESSAGE_V6__', 'v6 console prefix');
forbidText("service: 'wire'", 'Wire capture');
forbidText('const DOM_OBSERVER_FACTORY', 'unused legacy DOM observer factory');

// WhatsApp: WA-JS v4.4.2 generated ChatEventTypes examples use root WPP.on; README also documents WPP.chat.on.
// Install regardless of transient auth state and support both public emitter surfaces.
requireText("rootOn('chat.new_message', handler);", 'WPP.on chat.new_message');
requireText("chatOn('chat.new_message', handler);", 'WPP.chat.on chat.new_message fallback');
requireText("state.adapter = 'WPP.on'", 'WPP.on adapter');
requireText("state.adapter = 'WPP.chat.on'", 'WPP.chat.on fallback adapter');
requireText('whatsapp-wajs-capabilities', 'WhatsApp capability diagnostics');
requireText('scheduleRetry(1000)', 'WhatsApp capability retry loop');
forbidText("if (!authenticated)", 'WhatsApp listener installation must not be gated by transient authentication');

// Telegram: preserve exact Web A message row while preventing optimistic clone duplicates.
requireText('.Message.message-list-item[data-message-id]', 'Telegram proven row selector');
requireText("row.classList.contains('own')", 'Telegram outgoing class');
requireText("if (!messageId || !/^-?\\d+$/.test(messageId)) return;", 'Telegram integer provider-id guard');
requireText('telegram-web-a-source-mapped-rendered-message', 'Telegram open-message provider event');
requireText('telegram-web-a-unread-chat-preview', 'Telegram unread preview capture');
requireText("row.querySelector('.ChatBadge.unread,.ChatBadge.mention')", 'Telegram unread/mention ChatBadge');
requireText("row.querySelector('.last-message-summary')", 'Telegram last message summary');
requireText("time.dispatchEvent(new MouseEvent('mouseover'", 'Telegram full-date activation');

// Signal: exact 8.17.0 rendered structures verified inside frozen vendored bundle.
for (const exact of [
  'data-message-id',
  'module-message__text',
  'module-message--${n}',
  '"data-testid":m',
  'timestamp:m',
  'module-ConversationHeader__header__info__title',
  'module-timeline__messages__container',
]) {
  if (!runtime.includes(exact)) failures.push(`Signal 8.17.0 runtime evidence missing: ${exact}`);
}
requireText("'[data-message-id][role=\"listitem\"]'", 'Signal provider message row');
requireText("message.getAttribute('data-testid')", 'Signal rendered provider timestamp');
requireText(".module-ConversationHeader__header__info__title", 'Signal rendered conversation title');
requireText('signal-8.17.0-rendered-dom-readonly', 'Signal rendered adapter');
forbidText('window.MessageCache?.getById', 'inaccessible Signal main-world MessageCache dependency');
forbidText('window.ConversationController?.get', 'inaccessible Signal main-world ConversationController dependency');

// Teams current public GitHub DOM exporter evidence.
requireText('[data-tid="chat-pane-message"]', 'Teams concrete chat-pane-message row');
requireText('div[data-mid]', 'Teams data-mid row fallback');
requireText("document.getElementById('author-' +", 'Teams exact author-mid lookup');
requireText("document.getElementById('timestamp-' + mid)", 'Teams exact timestamp-mid lookup');
requireText('[id^="message-body-"] [id^="content-"]', 'Teams body/content ids');
requireText('.ui-chat__messagecontent', 'Teams public exporter legacy/current body fallback');
requireText("document.body || null", 'Teams body observer fallback');
requireText("if (!sentAt) return;", 'Teams must not invent historical timestamp');
requireText('teams-web-current-dom-compat', 'Teams compatibility label');

// Syntax-only TypeScript parse. Before dependency installation this check is optional;
// after build RUN_ALL requires the project-local TypeScript module to be present.
try {
  const require = createRequire(import.meta.url);
  let ts = null;
  const candidates = [
    path.join(root, 'node_modules/typescript/lib/typescript.js'),
    'typescript',
  ];
  for (const candidate of candidates) {
    try { ts = require(candidate); break; } catch {}
  }
  if (!ts) {
    if (process.env.MACTRANSLATE_REQUIRE_TYPESCRIPT === '1') {
      failures.push('TypeScript syntax checker unavailable after dependency installation');
    } else {
      console.log('TypeScript syntax precheck skipped: dependencies not installed yet; build compiler will validate it.');
    }
  } else {
    const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true, fileName: sourcePath });
    for (const d of result.diagnostics || []) {
      if (d.category === ts.DiagnosticCategory.Error) failures.push(`TypeScript syntax: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    }
  }
} catch (error) {
  if (process.env.MACTRANSLATE_REQUIRE_TYPESCRIPT === '1') failures.push(`TypeScript syntax checker failed: ${error.message}`);
  else console.log(`TypeScript syntax precheck skipped: ${error.message}`);
}

if (failures.length) {
  console.error('MESSAGE_RECOGNITION_V6_SOURCE_CHECK_FAILED');
  failures.forEach(item => console.error(`- ${item}`));
  process.exit(1);
}
console.log('MESSAGE_RECOGNITION_V6_SOURCE_CHECK_OK');
console.log('WhatsApp=WA-JS v4.4.2 WPP.on/WPP.chat.on without auth gating; Telegram=proven WebA path+exact-time activation+unread preview; Signal=8.17.0 exact rendered DOM; Teams=current DOM compatibility.');
