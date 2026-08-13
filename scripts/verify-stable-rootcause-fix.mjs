#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const failures = [];
const requireText = (label, text, needle) => {
  if (!text.includes(needle)) failures.push(`${label}: missing ${needle}`);
};
const forbid = (label, text, pattern) => {
  if (pattern.test(text)) failures.push(`${label}: forbidden ${pattern}`);
};

const pkg = JSON.parse(read('package.json'));
if (pkg.devDependencies?.electron !== '38.1.0' && pkg.dependencies?.electron !== '38.1.0') {
  failures.push('Electron must remain pinned to 38.1.0 for frozen Signal runtime');
}

const index = read('src/index.ts');
requireText('WhatsApp permission', index, "permissionName === 'persistent-storage'");
requireText('WhatsApp permission', index, "new URL(value).origin === 'https://web.whatsapp.com'");
requireText('WhatsApp permission', index, 'setPermissionRequestHandler');
requireText('WhatsApp permission', index, 'setPermissionCheckHandler');
forbid('WhatsApp permission', index, /permissionName\s*===\s*['\"]unknown['\"]/);
forbid('WhatsApp permission', index, /Browser\.setPermission|durableStorage/);

const recognition = read('src/electron/message-recognition/UnifiedMessageRecognition.ts');
requireText('WhatsApp logger barrier', recognition, "safeRequire('WATagsLogger')");
requireText('WhatsApp logger barrier', recognition, 'tagsLogger.whenReady()');
requireText('WhatsApp capture', recognition, "safeRequire('WAWebCollections')");
requireText('Telegram transport restore', recognition, 'settings.shouldAllowHttpTransport=true');
requireText('Telegram adaptive transport', recognition, 'settings.shouldForceHttpTransport=Boolean(force)');
requireText('Telegram adaptive transport', recognition, 'telegram-force-http-reverted');
requireText('Telegram transport restore', recognition, "indexedDB.open('tt-data')");
requireText('Telegram transport restore', recognition, "store.get('tt-shared-state')");
forbid('Telegram transport', recognition, /configureTelegramHttpCors|scoped-apiw1-response-header/);
forbid('Telegram HTTP', recognition, /window\.WebSocket\s*=|window\.Worker\s*=|WebSocket\.prototype|Worker\.prototype/);
requireText('Telegram readiness', recognition, "data.type==='globalDiffUpdate'");
requireText('Telegram readiness', recognition, "data.type==='globalUpdate'");
requireText('Telegram readiness', recognition, 'data.diff?.connectionState');
requireText('Telegram readiness', recognition, "'connectionStateReady'");
requireText('Telegram readiness', recognition, 'Date.now()-state.readySince>=8000');
forbid('Telegram readiness', recognition, /readTelegramConnectionState|telegramGlobalStateKey/);
forbid('storage API', recognition, /navigator\.storage\.persist\s*=|navigator\.permissions\.query\s*=/);

const service = read('src/models/Service.ts');
requireText('Teams Chrome UA', service, "recipe.id === 'msteams'");
requireText('Teams Chrome UA', service, 'Ferdium|Electron|MacTranslate');
const recipePreload = read('src/webview/recipe.ts');
forbid('Teams broad event hiding', recipePreload, /isTrustedDomEventRejection|stopImmediatePropagation\(\)/);
requireText('WhatsApp PerformanceObserver compatibility', recipePreload, 'delete normalized.buffered');
requireText('WhatsApp exact upstream invariant handling', recipePreload, 'Minified invariant #56367');
requireText('WhatsApp exact upstream QPL handling', recipePreload, 'Haste-supplied config for the QPL event');
requireText('Teams exact upstream isTrusted handling', recipePreload, "text.includes('Unhandled error/rejection')");
forbid('Generic ErrorUtils hiding', recipePreload, /text\.includes\(['"]ErrorUtils caught an error:/);
forbid('Generic Teams console hiding', recipePreload, /text\.includes\(['"]Unhandled error\/rejection['"]\)\s*\)\s*return/);
forbid('Teams TrustedHTML bridge', recognition, /new DOMParser\(\)\.parseFromString\([^,]+,\s*['\"]text\/html['\"]\)/);
requireText('Teams TrustedHTML bridge', recognition, 'decodeHtmlEntities');

for (const rel of [
  'src/webview/lib/RecipeWebview.ts',
  'src/webview/contextMenuBuilder.ts',
  'src/webview/darkmode.ts',
  'src/webview/recipe.ts',
  'src/features/appearance/index.ts',
]) {
  forbid(`TrustedHTML ${rel}`, read(rel), /\.innerHTML\s*[-+]*=/);
}

if (failures.length) {
  console.error('STABLE_ROOTCAUSE_VERIFY_FAILED');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('STABLE_ROOTCAUSE_VERIFY_OK');
console.log('SignalPin=38.1.0 WhatsApp=persistent-storage+logger-barrier Telegram=upstream-adaptive-force-http+stable-ready-gate Teams=chrome-UA+FluentUI-config no-broad-console-hiding+exact-upstream-only=PASS');
