#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..')); const fail=[];
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const recipe=read('src/webview/recipe.ts'), waRecipe=read('recipes/recipes/whatsapp/webview.js'), tgRecipe=read('recipes/recipes/telegram/webview.js'), rec=read('src/electron/message-recognition/UnifiedMessageRecognition.ts');
const must=(s,x,n)=>{if(!s.includes(x))fail.push('missing '+n)}; const ban=(s,x,n)=>{if(s.includes(x))fail.push('forbidden '+n)};
must(recipe,'if (!document.documentElement || !document.head || !document.body)','recipe DOM-ready guard');
ban(tgRecipe,'window.onload(() => {})','Telegram invalid window.onload call'); must(tgRecipe,'event.target instanceof Element','Telegram click target guard');
must(waRecipe,'const body = document.body;','WhatsApp body guard'); must(waRecipe,'.catch(error => {','WhatsApp IndexedDB rejection catch');
must(rec,"const marker = '__mactranslateRealWhatsAppV722'",'WhatsApp v722 marker'); must(rec,'whatsapp-wawebcollections-history-snapshot','history snapshot event'); must(rec,"safeRequire('WAWebDBMessageFindLocal')",'local DB history module'); must(rec,'finder.msgFindBefore({ anchor, count: PAGE_SIZE })','local DB backward paging'); must(rec,'const MAX_PER_CHAT = 100000','WhatsApp ExportChat per-chat safety limit'); must(rec,'const PAGE_SIZE = 50','WhatsApp ExportChat page size'); must(rec,"safeRequire('WAWebChatLoadMessages')",'provider history loader'); must(rec,'loader.loadEarlierMsgs({ chat })','provider older-history completion'); must(rec,"modelsOf(chat?.msgs)",'resident chat history snapshot'); must(rec,"safeRequire('WAWebApiChatBulkGetByHistory')",'historyChatId/LID resolver'); must(rec,'bulkGetChatsMaybeByHistory','historyChatId/LID lookup'); must(rec,'whatsapp-chat-msgs-history-add','late resident history add'); must(rec,'whatsapp-chat-resident-history','resident chat history event'); must(rec,'let anchor = { remote: chat.remote }','WhatsApp ExportChat initial remote anchor');
if(fail.length){console.error('V722_CONSOLE_HISTORY_AUDIT_FAILED'); for(const x of fail)console.error('- '+x); process.exit(1)}
console.log('V722_CONSOLE_HISTORY_AUDIT_OK');
