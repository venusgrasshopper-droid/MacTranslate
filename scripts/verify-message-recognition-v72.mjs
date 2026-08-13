#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
const file=path.join(root,'src/electron/message-recognition/UnifiedMessageRecognition.ts');
const source=fs.readFileSync(file,'utf8');
const fail=[];
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const wa=slice('const WHATSAPP_BRIDGE','const TELEGRAM_BRIDGE');
for(const forbidden of ['WPP.','WAJS_BUNDLE','MsgStore','MsgCollection','getMessages(','getUnreadChats(','setInterval(','MutationObserver','.message-in','.message-out','rowSelector']) if(wa.includes(forbidden)) fail.push('WhatsApp forbidden: '+forbidden);
if(wa.includes("Msg.on('change:type'")) fail.push('WhatsApp must not attach global change:type');
for(const required of [
  "safeRequire('WAWebCollections')",
  "Msg.on('add', state.addHandler)",
  "msg.isNewMsg !== true",
  "conversationId === 'status@broadcast'",
  "safeRequire('WAWebMsgGetters')",
  "safeRequire('WAWebMsgModelFromData')",
  'getCaption',
  'getPollName',
  "adapter: 'whatsapp-webjs-msg-add-readonly-v722'",
  "state.collections = collections",
  "msg.once('change:type'",
  'scheduleRetry()',
  'clearRetry()',
  'const delays = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000]',
]) if(!wa.includes(required)) fail.push('WhatsApp missing: '+required);
const tg=slice('const TELEGRAM_BRIDGE','const TEAMS_BRIDGE');
const teams=slice('const TEAMS_BRIDGE','const SIGNAL_BRIDGE');
const sig=slice('const SIGNAL_BRIDGE','function scriptFor');
for(const x of ['last-message-summary']) if(tg.includes(x)) fail.push('Telegram changed into pseudo path: '+x);
for(const required of ["telegramChannelName = () => 'tt-global_'","telegramCallApi('fetchChats'","telegramCallApi('fetchMessages'",'threadId:-1','telegram-web-a-api-fetchMessages',"document.querySelector('#LeftColumn')",'.ChatBadge.unread:not(.muted)']) if(!tg.includes(required)) fail.push('Telegram native API history missing: '+required);
if(teams.includes('document.body || null')) fail.push('Teams body fallback returned');
if(teams.includes('location.pathname + location.search + location.hash')) fail.push('Teams /v2/ id returned');
for(const x of ['archiveCollectorStatus','getUserhash','webview.mactranslate-base.js','WAWebUserPrefsMeUser','WAWebSocketModel']) if(source.includes(x)) fail.push('legacy symbol: '+x);
for(const required of ['RECOGNITION_RUN_ID = randomUUID()', "'current-run.json'", 'recognitionRunId: RECOGNITION_RUN_ID', 'beginRecognitionRun = () =>']) if(!source.includes(required)) fail.push('current-run proof missing: '+required);
for(const [name,part] of [['telegram',tg],['teams',teams],['signal',sig]]) if(!part.trim()) fail.push(name+' bridge missing');
for(const required of ['normalizedTeamsTitle','directionOf = node','teams-title:',"senderName: outgoing ? '' : senderName","teamsDbNames('conversation-manager')",'fetchTeamsHistory','data?._metadata?.backwardLink','refreshTeamsMessagingAuth','networkRetries<1','isTeamsChatServiceHistoryEligible','teams-chat-service-api',".Discover.SKYPE-TOKEN"]) if(!teams.includes(required)) fail.push('Teams API history missing: '+required);

if(tg.includes('telegram-web-a-idb-last-message-cache')) fail.push('Telegram obsolete cache-as-history path returned');
if(teams.includes('teams-local-replychain-idb')) fail.push('Teams obsolete replychain-as-history path returned');
for(const required of ['SIGNAL_HISTORY_PRIME_SCRIPT','loadNewestMessages(undefined, true)','loadOlderMessages(oldestId)','actions.messagesAdded = wrappedAdded','actions.messagesReset = wrappedReset','signal-local-history-primed','SIGNAL_CACHE_SNAPSHOT_SCRIPT','messagesLookup','messagesByConversation','executeJavaScriptInIsolatedWorld(999','signal-8.17.0-local-sql-history','signal-8.17.0-redux-cache-live']) if(!source.includes(required)) fail.push('Signal cache capture missing: '+required);
for(const required of ["safeRequire('WAWebDBMessageFindLocal')","safeRequire('WAWebSchemaChat')","safeRequire('WAWebWidFactory')",'finder.msgFindBefore({ anchor, count: PAGE_SIZE })','let anchor = { remote: chat.remote }','const PAGE_SIZE = 50','const MAX_PER_CHAT = 100000','whatsapp-native-exportchat-local-history',"safeRequire('WAWebChatLoadMessages')",'loader.loadEarlierMsgs({ chat })','whatsapp-wawebchatloadmessages-history','whatsapp-chat-resident-history','modelsOf(chat?.msgs)',"safeRequire('WAWebApiChatBulkGetByHistory')",'bulkGetChatsMaybeByHistory','whatsapp-chat-msgs-history-add']) if(!wa.includes(required)) fail.push('WhatsApp native local history missing: '+required);
if(wa.includes('messageTable.all()')) fail.push('WhatsApp raw full message-table scan returned');
try {
  const require=createRequire(import.meta.url); let ts;
  try { ts=require(require.resolve('typescript',{paths:[root]})); } catch {}
  if(ts){
    const out=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true,fileName:file});
    for(const d of out.diagnostics||[]) if(d.category===ts.DiagnosticCategory.Error) fail.push('TS '+ts.flattenDiagnosticMessageText(d.messageText,'\n'));
  } else console.log('TYPECHECK_DEFERRED_TO_BUILD');
} catch(e){ console.log('TYPECHECK_DEFERRED_TO_BUILD '+String(e?.message||e)); }
if(fail.length){ console.error('MESSAGE_CAPTURE_V72_AUDIT_FAILED'); for(const x of fail) console.error('- '+x); process.exit(1); }
console.log('MESSAGE_CAPTURE_V72_AUDIT_OK');
