#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const fail = [];
const must = (s, x, label) => { if (!s.includes(x)) fail.push(`missing ${label}`); };
const ban = (s, x, label) => { if (s.includes(x)) fail.push(`forbidden ${label}`); };

const pkg = JSON.parse(read('package.json'));
const index = read('src/index.ts');
const preload = read('src/webview/recipe.ts');
const recipeWebview = read('src/webview/lib/RecipeWebview.ts');
const telegramRecipe = read('recipes/recipes/telegram/index.js');
const teamsRecipe = read('recipes/recipes/msteams/index.js');

if (pkg.devDependencies?.electron !== '38.1.0') fail.push('Electron must remain pinned to 38.1.0 for Signal RP01');
must(recipeWebview, "styles.textContent = readFileSync(file, 'utf8');", 'Trusted Types-safe CSS sink');
ban(recipeWebview, 'styles.innerHTML =', 'Trusted Types-unsafe style innerHTML');

must(index, "permissionName === 'persistent-storage'", 'Electron durable-storage permission handling');
must(index, "hostname.toLowerCase() === 'web.whatsapp.com'", 'WhatsApp-only persistent storage scope');
must(index, 'isWhatsAppOrigin(requestingUrl)', 'WhatsApp request permission scope');

must(preload, "const STATE_KEY = 'tt-shared-state';", 'Telegram official shared-state key');
must(preload, "const DB_NAME = 'tt-data';", 'Telegram official IDB database');
must(preload, 'window.stop();', 'Telegram pre-bootstrap stop');
must(preload, 'shouldAllowHttpTransport: true', 'Telegram allow HTTP official setting');
must(preload, 'shouldForceHttpTransport: true', 'Telegram force HTTP official setting');
must(preload, 'loadCachedSharedState()', 'Telegram upstream cache-load rationale');
ban(preload, 'Worker.prototype.postMessage', 'Telegram Worker monkey patch');
ban(preload, 'contextBridge.executeInMainWorld', 'fragile executeInMainWorld function serialization');

must(preload, 'executeJavaScriptInIsolatedWorld(0', 'early Teams Main World guard');
must(preload, "window.addEventListener('unhandledrejection'", 'Teams rejection guard');
must(preload, 'event.stopImmediatePropagation();', 'Teams upstream logger short-circuit');
ban(preload, 'console.error =', 'console.error monkey patch');
ban(preload, 'console.warn =', 'console.warn monkey patch');

ban(telegramRecipe, 'shouldForceHttpTransport', 'late Telegram recipe transport mutation');
ban(telegramRecipe, 'indexedDB.open', 'late Telegram recipe IDB mutation');
ban(teamsRecipe, 'unhandledrejection', 'late Teams recipe event guard');

if (fail.length) {
  console.error('STABLE_ROOTCAUSE_VERIFY_FAILED');
  for (const item of fail) console.error(`- ${item}`);
  process.exit(1);
}
console.log('STABLE_ROOTCAUSE_VERIFY_OK');
