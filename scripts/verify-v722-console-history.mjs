#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..')); const fail=[];
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const recipe=read('src/webview/recipe.ts'), waRecipe=read('recipes/recipes/whatsapp/webview.js'), tgRecipe=read('recipes/recipes/telegram/webview.js'), rec=read('src/electron/message-recognition/UnifiedMessageRecognition.ts');
const must=(s,x,n)=>{if(!s.includes(x))fail.push('missing '+n)}; const ban=(s,x,n)=>{if(s.includes(x))fail.push('forbidden '+n)};
must(recipe,'if (!document.documentElement || !document.head || !document.body)','recipe DOM-ready guard');
ban(tgRecipe,'window.onload(() => {})','Telegram invalid window.onload call'); must(tgRecipe,'event.target instanceof Element','Telegram click target guard');
must(waRecipe,'const body = document.body;','WhatsApp body guard'); must(waRecipe,'.catch(error => {','WhatsApp IndexedDB rejection catch');
must(rec,"const marker = '__mactranslateRealWhatsAppV722'",'WhatsApp v722 marker'); must(rec,'whatsapp-wawebcollections-history-snapshot','history snapshot event'); must(rec,'const LIMIT = 500','bounded history snapshot'); ban(rec,'.loadEarlierMsgs(','automatic history network paging');
ban(rec,"safeRequire('WAWebChatLoadMessages')",'automatic history loader import');
if(fail.length){console.error('V722_CONSOLE_HISTORY_AUDIT_FAILED'); for(const x of fail)console.error('- '+x); process.exit(1)}
console.log('V722_CONSOLE_HISTORY_AUDIT_OK');
