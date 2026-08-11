/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  webContents,
  type WebContents,
} from 'electron';
import { getSignalAccountIdForWebContents } from '../signal/EmbeddedSignalEngine';

const debug = require('../../preload-safe-debug')(
  'MacTranslate:RealMessageRecognitionV6',
);

const CONSOLE_PREFIX = '__MACTRANSLATE_REAL_MESSAGE_V6__';
const SCHEMA = 'mactranslate-real-message-v6';
const STATUS_SCHEMA = 'mactranslate-real-message-status-v6';
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_SEEN = 50_000;

type ServiceName = 'whatsapp' | 'telegram' | 'teams' | 'signal';
type MessageDirection = 'incoming' | 'outgoing';

export type RecognizedChatMessage = {
  schema: typeof SCHEMA;
  service: ServiceName;
  serviceInstanceId: string;
  accountId: string;
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  providerMessageId: string | null;
  idQuality: 'provider' | 'derived';
  senderId: string;
  senderName: string;
  direction: MessageDirection;
  sentAt: number;
  timestampQuality: 'provider' | 'rendered-full' | 'observed-preview' | 'fallback-observed';
  text: string;
  providerEvent: string;
  observedAt: number;
  deviceId: string;
  translationState: 'not-requested';
};

// Translation and archive modules can subscribe without rescanning any page.
export const recognizedMessageEvents = new EventEmitter();
recognizedMessageEvents.setMaxListeners(25);

type CapturedPayload = {
  conversationId?: unknown;
  conversationTitle?: unknown;
  messageId?: unknown;
  accountId?: unknown;
  senderId?: unknown;
  senderName?: unknown;
  direction?: unknown;
  sentAt?: unknown;
  timestampQuality?: unknown;
  text?: unknown;
  providerEvent?: unknown;
};

type ConsoleEnvelope =
  | { kind: 'message'; payload: CapturedPayload }
  | { kind: 'status'; status: string; details?: Record<string, unknown> };

type AttachedTarget = {
  service: ServiceName;
  serviceInstanceId: string;
  contents: WebContents;
  url: string;
  documentSequence: number;
  lastInjectedSequence: number;
  injectionGeneration: number;
  retryTimer: NodeJS.Timeout | null;
};

const targets = new Map<number, AttachedTarget>();
const hookedContents = new Set<number>();
const seen = new Set<string>();
const seenOrder: string[] = [];
let writeQueue = Promise.resolve();
let started = false;

function clean(value: unknown): string {
  return String(value ?? '')
    .replaceAll('\u200b', '')
    .replaceAll('\u00a0', ' ')
    .replaceAll(/\r\n?/g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

function safeTimestamp(value: unknown): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000
      ? Math.trunc(numeric * 1000)
      : Math.trunc(numeric);
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function remember(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  seenOrder.push(key);
  while (seenOrder.length > MAX_SEEN) {
    const oldest = seenOrder.shift();
    if (oldest) seen.delete(oldest);
  }
  return true;
}

function recognitionDirectory(): string {
  return path.join(app.getPath('userData'), 'MessageRecognitionV6');
}

function appendJsonl(fileName: string, value: unknown): void {
  const directory = recognitionDirectory();
  const file = path.join(directory, fileName);
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(file, `${JSON.stringify(value)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    })
    .catch(error => debug('Recognition log write failed', error));
}

function recordStatus(
  target: AttachedTarget,
  status: string,
  details: Record<string, unknown> = {},
): void {
  appendJsonl('status.jsonl', {
    schema: STATUS_SCHEMA,
    service: target.service,
    serviceInstanceId: target.serviceInstanceId,
    webContentsId: target.contents.id,
    status,
    details,
    url: target.contents.getURL() || target.url,
    observedAt: Date.now(),
  });
}

function normalizeDirection(value: unknown): MessageDirection {
  return value === 'outgoing' ? 'outgoing' : 'incoming';
}

function recordMessage(target: AttachedTarget, input: CapturedPayload): void {
  const text = clean(input.text).slice(0, MAX_TEXT_LENGTH);
  const conversationTitle = clean(input.conversationTitle).slice(0, 4096);
  let conversationId = clean(input.conversationId).slice(0, 4096);
  if (!conversationId && target.service === 'signal' && conversationTitle) {
    // Signal 8.17.0's rendered timeline exposes provider message IDs/timestamps but
    // not the selected conversation's internal ID in a stable DOM attribute.
    // Keep the existing RP01 host untouched and derive a stable local key from the
    // authoritative Signal account binding plus the rendered conversation title.
    conversationId = `signal-title-${sha256(`${target.serviceInstanceId}\u001f${conversationTitle}`).slice(0, 40)}`;
  }
  if (!text || !conversationId) return;

  const direction = normalizeDirection(input.direction);
  const rawSentAt = Number(input.sentAt);
  const hasNumericTimestamp = Number.isFinite(rawSentAt) && rawSentAt > 0;
  const parsedTimestamp = hasNumericTimestamp
    ? safeTimestamp(rawSentAt)
    : Date.parse(String(input.sentAt ?? ''));
  const hasProviderTimestamp = Number.isFinite(parsedTimestamp) && parsedTimestamp > 0;
  const sentAt = hasProviderTimestamp ? Math.trunc(parsedTimestamp) : Date.now();
  const requestedQuality = clean(input.timestampQuality);
  const timestampQuality: RecognizedChatMessage['timestampQuality'] =
    requestedQuality === 'provider' || requestedQuality === 'rendered-full' || requestedQuality === 'observed-preview' || requestedQuality === 'fallback-observed'
      ? requestedQuality
      : hasProviderTimestamp
        ? 'provider'
        : 'fallback-observed';
  const providerMessageId = clean(input.messageId).slice(0, 4096);
  const senderId = clean(input.senderId).slice(0, 4096);
  const accountId = clean(input.accountId).slice(0, 4096);
  const derived = [
    target.service,
    target.serviceInstanceId,
    conversationId,
    direction,
    timestampQuality === 'observed-preview' ? 'preview' : sentAt,
    senderId,
    text,
  ].join('\u001f');
  const messageId = providerMessageId || `derived-${sha256(derived).slice(0, 40)}`;
  const dedupeKey = [
    target.service,
    target.serviceInstanceId,
    conversationId,
    messageId,
  ].join('\u001f');
  if (!remember(dedupeKey)) return;

  const row: RecognizedChatMessage = {
    schema: SCHEMA,
    service: target.service,
    serviceInstanceId: target.serviceInstanceId,
    accountId: accountId || target.serviceInstanceId,
    conversationId,
    conversationTitle,
    messageId,
    providerMessageId: providerMessageId || null,
    idQuality: providerMessageId ? 'provider' : 'derived',
    senderId,
    senderName: clean(input.senderName).slice(0, 4096),
    direction,
    sentAt,
    timestampQuality,
    text,
    providerEvent: clean(input.providerEvent).slice(0, 256),
    observedAt: Date.now(),
    deviceId: os.hostname(),
    translationState: 'not-requested',
  };
  appendJsonl('messages.jsonl', row);
  recognizedMessageEvents.emit('message', row);
  recordStatus(target, 'real-message-captured', {
    conversationId,
    messageId,
    direction,
    timestampQuality,
  });
}
function detectService(url: string): ServiceName | null {
  if (/^https:\/\/web\.whatsapp\.com(?:\/|$)/i.test(url)) return 'whatsapp';
  if (/^https:\/\/web\.telegram\.org\/a(?:\/|$)/i.test(url)) return 'telegram';
  if (
    /^https:\/\/(?:teams\.cloud\.microsoft|teams\.microsoft|teams\.live)\.com(?:\/|$)/i.test(
      url,
    )
  ) {
    return 'teams';
  }
  if (
    url.startsWith('file:') &&
    /\/signal-runtime\/background\.html(?:$|[?#])/i.test(url)
  ) {
    return 'signal';
  }
  return null;
}

function sessionServiceInstanceId(contents: WebContents): string | null {
  const storagePath = clean((contents.session as any)?.storagePath);
  const match = storagePath.match(
    /(?:^|[/\\])Partitions[/\\]service-([a-zA-Z0-9_-]{8,128})(?:[/\\]|$)/,
  );
  if (match?.[1]) return match[1];
  return null;
}

function authoritativeInstanceId(
  contents: WebContents,
  service: ServiceName,
): string | null {
  if (service === 'signal') {
    // Signal has an authoritative account binding supplied by the existing RP01 host.
    return getSignalAccountIdForWebContents(contents);
  }
  // RP01 intentionally keeps ordinary web services on persist:general-session when
  // sandboxing is disabled. Do not block capture just because that session path has
  // no service UUID. WebContents id is a runtime instance key; provider account IDs
  // (for example WPP.conn.getMyUserWid()) remain in the normalized message itself.
  return sessionServiceInstanceId(contents) ?? `${service}-webcontents-${contents.id}`;
}

function parseConsoleMessage(
  target: AttachedTarget,
  message: string,
): void {
  if (!message.startsWith(CONSOLE_PREFIX)) return;
  try {
    const envelope = JSON.parse(message.slice(CONSOLE_PREFIX.length)) as ConsoleEnvelope;
    if (envelope.kind === 'message') {
      recordMessage(target, envelope.payload ?? {});
      return;
    }
    if (envelope.kind === 'status') {
      recordStatus(target, clean(envelope.status) || 'unknown', envelope.details ?? {});
    }
  } catch (error) {
    recordStatus(target, 'bridge-payload-error', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const BRIDGE_SHARED = String.raw`
  const PREFIX = ${JSON.stringify(CONSOLE_PREFIX)};
  const emit = envelope => {
    try { console.info(PREFIX + JSON.stringify(envelope)); } catch {}
  };
  const emitStatus = (status, details = {}) => emit({ kind: 'status', status, details });
  const clean = value => String(value ?? '')
    .replace(/\u200b/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const timeValue = value => {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10000000000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
    }
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
`;
const WHATSAPP_BRIDGE = String.raw`
(() => {
  'use strict';
  ${BRIDGE_SHARED}
  const marker = '__mactranslateRealWhatsAppV722';
  if (window[marker]?.installed) return;

  const state = {
    installed: true,
    collections: null,
    msgCollection: null,
    addHandler: null,
    retryTimer: null,
    retryAttempt: 0,
    loadHandler: null,
    accountId: '',
    seen: new Set(),
    unavailableReported: false,
    historyScanStarted: false,
    historyScanned: 0,
    historyCaptured: 0,
  };
  window[marker] = state;

  // Source path: whatsapp-web.js v1.34.7 Client.attachEventListeners().
  // It listens to window.require('WAWebCollections').Msg.on('add').
  // We stay read-only and keep only text messages (type === 'chat').
  const safeRequire = name => {
    try {
      return typeof window.require === 'function' ? window.require(name) : null;
    } catch {
      return null;
    }
  };

  const wid = value => {
    try {
      if (!value) return '';
      if (typeof value === 'string') return clean(value);
      if (typeof value._serialized === 'string') return clean(value._serialized);
      if (value.user && value.server) return clean(value.user + '@' + value.server);
      const rendered = value.toString?.();
      return rendered && rendered !== '[object Object]' ? clean(rendered) : '';
    } catch {
      return '';
    }
  };

  const serialize = msg => {
    try {
      if (typeof msg?.serialize === 'function') return msg.serialize() || {};
    } catch {}
    return msg || {};
  };

  const resolveAccountId = () => state.accountId;

  const conversationTitle = chatId => {
    try {
      const chat = state.collections?.Chat?.get?.(chatId);
      return clean(chat?.formattedTitle || chat?.name || chat?.contact?.formattedName || chat?.contact?.name || chat?.contact?.pushname || '');
    } catch {
      return '';
    }
  };

  const senderName = senderId => {
    try {
      const contact = state.collections?.Contact?.get?.(senderId);
      return clean(contact?.formattedName || contact?.name || contact?.pushname || contact?.shortName || '');
    } catch {
      return '';
    }
  };

  const capture = (msg, providerEvent, allowHistorical = false) => {
    try {
      if (!msg || (!allowHistorical && msg.isNewMsg !== true)) return false;
      if (clean(msg.type) !== 'chat') return false;

      const data = serialize(msg);
      const id = data.id || msg.id;
      const fromMe = Boolean(id?.fromMe);
      if (fromMe && !state.accountId) state.accountId = wid(data.from ?? msg.from);
      const text = clean(data.body ?? msg.body);
      if (!text) return false;

      // Mirror whatsapp-web.js Message._getChatId(): outgoing -> to, incoming -> from.
      // id.remote is retained only as a fallback for internal model variations.
      const chatWid = fromMe
        ? (data.to ?? msg.to ?? id?.remote)
        : (data.from ?? msg.from ?? id?.remote);
      const conversationId = wid(chatWid);
      if (!conversationId || conversationId === 'status@broadcast') return false;

      const providerMessageId = clean(id?._serialized) ||
        [fromMe ? 'true' : 'false', conversationId, clean(id?.id)].filter(Boolean).join('_');
      if (!providerMessageId || state.seen.has(providerMessageId)) return false;

      const sentAt = timeValue(data.t ?? msg.t ?? data.timestamp ?? msg.timestamp);
      if (!sentAt) return false;

      const authorWid = data.author ?? msg.author;
      const fromWid = data.from ?? msg.from;
      const sourceWid = fromMe ? null : (authorWid || fromWid);
      const sourceId = fromMe ? resolveAccountId() : wid(sourceWid);

      state.seen.add(providerMessageId);
      if (state.seen.size > 20000) state.seen.delete(state.seen.values().next().value);

      emit({ kind: 'message', payload: {
        accountId: resolveAccountId(),
        conversationId,
        conversationTitle: conversationTitle(chatWid),
        messageId: providerMessageId,
        senderId: sourceId,
        senderName: fromMe ? '' : senderName(sourceWid),
        direction: fromMe ? 'outgoing' : 'incoming',
        sentAt,
        timestampQuality: 'provider',
        text,
        providerEvent,
      }});
      return true;
    } catch (error) {
      emitStatus('whatsapp-message-parse-error', {
        message: clean(error?.message || error),
      });
      return false;
    }
  };

  const onAdd = msg => {
    if (!msg || msg.isNewMsg !== true) return;

    // Current whatsapp-web.js behavior: normal messages are emitted immediately;
    // ciphertext placeholders are emitted after that same model changes type.
    if (clean(msg.type) !== 'ciphertext') {
      capture(msg, 'whatsapp-wawebcollections-msg-add');
      return;
    }

    if (typeof msg.once === 'function') {
      msg.once('change:type', changed => {
        if (!changed || clean(changed.type) === 'revoked') return;
        capture(changed, 'whatsapp-wawebcollections-ciphertext-decrypted');
      });
    }
  };

  const loadedModels = Msg => {
    try {
      if (typeof Msg?.getModelsArray === 'function') return Msg.getModelsArray();
      if (Array.isArray(Msg?.models)) return Msg.models.slice();
      if (Array.isArray(Msg?._models)) return Msg._models.slice();
    } catch {}
    return [];
  };

  const scanLoadedHistory = Msg => {
    if (state.historyScanStarted) return;
    state.historyScanStarted = true;
    let models = loadedModels(Msg)
      .filter(model => model && clean(model.type) === 'chat')
      .sort((a, b) => Number(a?.t || 0) - Number(b?.t || 0));

    // This is deliberately a bounded snapshot of already-loaded provider models.
    // It does NOT call loadEarlierMsgs and therefore does not trigger network/history paging.
    const LIMIT = 500;
    if (models.length > LIMIT) models = models.slice(models.length - LIMIT);
    state.historyScanned = models.length;

    let index = 0;
    const runChunk = () => {
      const stop = Math.min(index + 25, models.length);
      for (; index < stop; index += 1) {
        if (capture(models[index], 'whatsapp-wawebcollections-history-snapshot', true)) {
          state.historyCaptured += 1;
        }
      }
      if (index < models.length) {
        setTimeout(runChunk, 0);
        return;
      }
      emitStatus('whatsapp-history-snapshot-complete', {
        scanned: state.historyScanned,
        captured: state.historyCaptured,
        limit: LIMIT,
        source: 'WAWebCollections.Msg already-loaded models',
      });
    };
    setTimeout(runChunk, 0);
  };

  const clearRetry = () => {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryAttempt = 0;
  };

  const detachCollection = () => {
    try {
      if (state.msgCollection && state.addHandler) {
        state.msgCollection.off?.('add', state.addHandler);
      }
    } catch {}
    state.msgCollection = null;
    state.addHandler = null;
  };

  const attachCollection = () => {
    try {
      const collections = safeRequire('WAWebCollections');
      const Msg = collections?.Msg;
      if (!Msg || typeof Msg.on !== 'function') {
        if (!state.unavailableReported) {
          state.unavailableReported = true;
          emitStatus('whatsapp-provider-not-ready', {
            hasRequire: typeof window.require === 'function',
            hasCollections: Boolean(collections),
            webVersion: clean(window.Debug?.VERSION || window.Debug?.BUILD_VERSION || ''),
          });
        }
        return false;
      }

      state.unavailableReported = false;
      state.collections = collections;
      if (state.msgCollection === Msg && state.addHandler) {
        clearRetry();
        return true;
      }

      detachCollection();
      state.msgCollection = Msg;
      state.addHandler = onAdd;
      Msg.on('add', state.addHandler);
      resolveAccountId();
      clearRetry();
      scanLoadedHistory(Msg);

      emitStatus('listener-installed', {
        service: 'whatsapp',
        adapter: 'whatsapp-webjs-msg-add-readonly-v722',
        accountId: state.accountId,
        webVersion: clean(window.Debug?.VERSION || window.Debug?.BUILD_VERSION || ''),
      });
      return true;
    } catch (error) {
      emitStatus('whatsapp-listener-install-error', {
        message: clean(error?.message || error),
        webVersion: clean(window.Debug?.VERSION || window.Debug?.BUILD_VERSION || ''),
      });
      return false;
    }
  };

  const scheduleRetry = () => {
    if (state.msgCollection || state.retryTimer) return;
    const delays = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000];
    const delay = delays[Math.min(state.retryAttempt, delays.length - 1)];
    state.retryAttempt += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!attachCollection()) scheduleRetry();
    }, delay);
  };

  const armProvider = () => {
    // Readiness backoff only. No message query, history paging, socket hook or DOM scan.
    if (!attachCollection()) scheduleRetry();
  };

  state.loadHandler = () => armProvider();
  window.addEventListener('load', state.loadHandler, { once: true });
  armProvider();

  window.addEventListener('beforeunload', () => {
    clearRetry();
    detachCollection();
    state.collections = null;
    try {
      if (state.loadHandler) window.removeEventListener?.('load', state.loadHandler);
    } catch {}
  }, { once: true });
})();
`;
const TELEGRAM_BRIDGE = String.raw`
(() => {
  'use strict';
  ${BRIDGE_SHARED}
  const marker='__mactranslateRealTelegramV70';
  if(window[marker]?.installed) return;
  if(!location.pathname.startsWith('/a/')) { emitStatus('telegram-unsupported-client',{pathname:location.pathname,expected:'/a/'}); return; }
  const state={installed:true,root:null,observer:null,rootObserver:null,seen:new Map()};
  window[marker]=state;
  const currentConversation=()=>{
    const peer=document.querySelector('#MiddleColumn .ChatInfo [data-peer-id],#MiddleColumn .MiddleHeader [data-peer-id]');
    const title=document.querySelector('#MiddleColumn .ChatInfo .fullName,#MiddleColumn .MiddleHeader .fullName,#MiddleColumn .MiddleHeader .title,#MiddleColumn header .fullName,#MiddleColumn header .title');
    const hash=clean(location.hash.replace(/^#/,'').split('?')[0]);
    return {id:clean(peer?.getAttribute('data-peer-id')||hash),title:clean(title?.textContent)};
  };
  const textOf=row=>{
    const source=row.querySelector('.text-content')||row.querySelector('.message-content-wrapper');
    if(!source) return '';
    const clone=source.cloneNode(true);
    for(const selector of ['.MessageMeta','.message-time','.message-signature','.message-replies-wrapper','.message-action-buttons-container','.message-action-buttons','.Reactions','.message-select-control','.InlineButtons','.inline-buttons','button']) for(const n of clone.querySelectorAll(selector)) n.remove();
    for(const img of clone.querySelectorAll('img.emoji')) img.replaceWith(document.createTextNode(img.getAttribute('alt')||''));
    for(const br of clone.querySelectorAll('br')) br.replaceWith(document.createTextNode('\n'));
    return clean(clone.innerText||clone.textContent);
  };
  const timeOf=row=>{
    const t=row.querySelector('.MessageMeta time[datetime],time[datetime],.message-time[title],.message-time');
    let v=timeValue(t?.getAttribute?.('datetime')||t?.getAttribute?.('title'));
    if(v) return v;
    const hm=clean(t?.textContent).match(/^(\d{1,2}):(\d{2})$/);
    if(hm){const now=new Date(); return new Date(now.getFullYear(),now.getMonth(),now.getDate(),Number(hm[1]),Number(hm[2]),0).getTime();}
    return 0;
  };
  const capture=row=>{
    if(!row?.isConnected) return;
    const messageId=clean(row.dataset?.messageId||row.getAttribute('data-message-id'));
    if(!messageId||!/^-?\d+$/.test(messageId)) return;
    const text=textOf(row); if(!text) return;
    const conversation=currentConversation(); if(!conversation.id) return;
    const sentAt=timeOf(row); if(!sentAt) return;
    const payload={conversationId:conversation.id,conversationTitle:conversation.title,messageId,senderId:clean(row.getAttribute('data-sender-id')),senderName:clean(row.querySelector('.sender-title')?.textContent),direction:row.classList.contains('own')?'outgoing':'incoming',sentAt,timestampQuality:'rendered-full',text,providerEvent:'telegram-web-a-message-row'};
    const fp=[payload.conversationId,messageId,payload.direction,sentAt,text].join('\u001f');
    if(state.seen.get(messageId)===fp) return; state.seen.set(messageId,fp); emit({kind:'message',payload});
  };
  const selector='.Message.message-list-item[data-message-id]';
  const process=node=>{const el=node?.nodeType===1?node:node?.parentElement;if(!el)return;if(el.matches?.(selector))capture(el);const c=el.closest?.(selector);if(c)capture(c);for(const row of el.querySelectorAll?.(selector)||[])capture(row);};
  const findRoot=()=>document.querySelector('#MiddleColumn .MessageList,.MessageList,#MiddleColumn');
  const bind=()=>{const root=findRoot();if(!root)return false;if(state.root===root&&state.observer)return true;state.observer?.disconnect?.();state.root=root;state.observer=new MutationObserver(ms=>{for(const m of ms){if(m.type==='characterData'||m.type==='attributes')process(m.target);else for(const n of m.addedNodes)process(n);}});state.observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-message-id','class','datetime','title']});process(root);emitStatus('listener-installed',{service:'telegram',adapter:'telegram-web-a-message-row-only'});return true;};
  bind();
  state.rootObserver=new MutationObserver(()=>{const current=findRoot();if(current&&current!==state.root)bind();});
  state.rootObserver.observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('beforeunload',()=>{state.observer?.disconnect?.();state.rootObserver?.disconnect?.();},{once:true});
})();
`;
const TEAMS_BRIDGE = String.raw`
(() => {
  'use strict';
  // Teams Web is closed-source. This compatibility adapter is deliberately based
  // on current public GitHub DOM exporters, not invented "ready" selectors.
  ${BRIDGE_SHARED}
  const marker = '__mactranslateRealTeamsV6';
  if (window[marker]?.installed) return;
  const state = {
    installed: true,
    observer: null,
    rootObserver: null,
    root: null,
    fingerprints: new Map(),
  };
  window[marker] = state;

  const rootSelectors = [
    '[data-tid="thread-body-scrollable-content"]',
    '[data-tid="chat-pane-message-list"]',
    '[data-tid="scrollable-thread-body"]',
    'div[role="log"][aria-label*="messages" i]',
    'div[role="list"][aria-label*="messages" i]',
    '[data-tid="thread-view"]',
    '[data-tid="message-pane"]',
    '[data-tid="message-pane-body"]',
    '[data-tid="message-pane-list-viewport"]',
  ];
  const candidateSelector = [
    '[data-tid="chat-pane-message"]',
    '[data-tid="message-list-item"]',
    '[data-tid="message-group-container"]',
    'div[role="listitem"]',
    'div[data-tid^="message-"]',
    'div[data-mid]',
  ].join(',');

  const firstText = (node, selectors) => {
    for (const selector of selectors) {
      const item = node.querySelector?.(selector);
      if (!item) continue;
      const value = clean(item.getAttribute?.('aria-label') || item.textContent);
      if (value) return value;
    }
    return '';
  };

  const extractText = node => {
    const selectors = [
      '[id^="message-body-"] [id^="content-"]',
      '[id^="content-"]',
      '[data-tid="message-content"]',
      '[data-tid="message-body"]',
      '[data-tid="bubble-text"]',
      '[data-tid^="message-content-"]',
      '[data-tid^="messageBody"]',
      '[role="document"]',
      '.ts-message-content',
      '.message-body',
      '.ui-chat__messagecontent',
    ];
    for (const selector of selectors) {
      const source = node.querySelector?.(selector);
      if (!source) continue;
      const clone = source.cloneNode(true);
      for (const remove of clone.querySelectorAll?.('button,[role="button"],[data-tid*="reaction" i],[data-tid*="timestamp" i],time') || []) remove.remove();
      for (const emoji of clone.querySelectorAll?.('img[alt]') || []) emoji.replaceWith(document.createTextNode(emoji.getAttribute('alt') || ''));
      for (const br of clone.querySelectorAll?.('br') || []) br.replaceWith(document.createTextNode('\n'));
      const value = clean(clone.innerText || clone.textContent);
      if (value) return value;
    }
    return '';
  };

  const findTime = (node, mid) => {
    const exact = mid ? document.getElementById('timestamp-' + mid) : null;
    const time = exact || node.querySelector?.('[id^="timestamp-"][datetime],time[datetime],[data-tid="message-time"],[data-tid="message-group-time"],[data-tid="message-timestamp"],time,[data-tid="message-group-header"]');
    if (!time) return 0;
    return timeValue(time.getAttribute?.('datetime') || time.getAttribute?.('title') || time.getAttribute?.('aria-label') || time.textContent);
  };

  const capture = candidate => {
    if (!candidate?.isConnected) return;
    // If a group/list container contains concrete chat-pane-message rows, let those
    // concrete rows be the records so one group cannot become one giant duplicate.
    if (!candidate.matches?.('[data-tid="chat-pane-message"],div[data-mid]')) {
      const concrete = candidate.querySelectorAll?.('[data-tid="chat-pane-message"],div[data-mid]') || [];
      if (concrete.length) {
        for (const row of concrete) capture(row);
        return;
      }
    }
    const node = candidate.closest?.('[data-tid="chat-pane-message"],div[data-mid],[data-tid="message-list-item"],div[role="listitem"],[data-tid="message-group-container"]') || candidate;
    const mid = clean(node.getAttribute?.('data-mid'));
    const idSource = node.querySelector?.('[id^="message-body-"],[id^="content-"],[id^="timestamp-"],[id^="author-"]');
    const rawId = clean(mid || idSource?.id || node.id || '');
    const idMatch = rawId.match(/(?:message-body-|content-|timestamp-|author-)?(.+)/);
    const messageId = clean(idMatch?.[1] || rawId);

    const text = extractText(node);
    if (!text) return;
    const sentAt = findTime(node, mid || messageId);
    // Do not invent historical Teams times. Current public DOM exporters expose a
    // real datetime/title/time field; if this page version does not, log diagnosis
    // and wait rather than writing observation time as the message time.
    if (!sentAt) return;

    const exactAuthor = (mid || messageId) ? document.getElementById('author-' + (mid || messageId)) : null;
    const senderName = clean(exactAuthor?.textContent) || firstText(node, [
      '[data-tid="message-author-name"]',
      '[data-tid="author-name"]',
      '[id^="message-author-"]',
      '[id^="author-"]',
      'div[role="button"][aria-label*="profile" i]',
      'button[aria-label*="profile" i]',
      '[data-tid="person-card-name"]',
      'span[data-tid="message-group-author"]',
      '[data-tid="message-group-header"]',
    ]);
    const titleNode = document.querySelector?.('[data-tid="chat-header-title"],[data-tid="chat-title"],[data-tid="conversation-title"],[data-tid="chat-header"] [role="heading"],header [role="heading"]');
    const conversationTitle = clean(titleNode?.textContent);
    const deepLink = document.querySelector?.('a[href*="/l/chat/19:"],a[href*="/l/message/19:"]')?.getAttribute?.('href') || '';
    const deepMatch = String(deepLink).match(/\/l\/(?:chat|message)\/(19:[^/]+)/);
    const domChatId = clean(document.querySelector?.('[data-chat-id],[data-conversation-id]')?.getAttribute?.('data-chat-id') || document.querySelector?.('[data-chat-id],[data-conversation-id]')?.getAttribute?.('data-conversation-id'));
    const conversationId = clean(deepMatch?.[1] || domChatId || (conversationTitle ? 'teams-title:' + conversationTitle : ''));
    if (!conversationId) return;
    const classes = String(node.className || '') + ' ' + String(node.parentElement?.className || '');
    const outgoing = node.getAttribute?.('data-is-own') === 'true' || /(?:^|\s)(?:own-message|from-me|message-outgoing|is-self)(?:\s|$)/i.test(classes);
    const payload = {
      conversationId,
      conversationTitle,
      messageId,
      senderId: clean(node.getAttribute?.('data-author-id')),
      senderName,
      direction: outgoing ? 'outgoing' : 'incoming',
      sentAt,
      timestampQuality: 'rendered-full',
      text,
      providerEvent: 'teams-web-current-dom-compat',
    };
    const fp = [conversationId,messageId || 'derived',senderName,payload.direction,sentAt,text].join('\u001f');
    const key = messageId || fp;
    if (state.fingerprints.get(key) === fp) return;
    state.fingerprints.set(key, fp);
    emit({ kind:'message', payload });
  };

  const process = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return;
    if (element.matches?.(candidateSelector)) capture(element);
    const closest = element.closest?.(candidateSelector);
    if (closest) capture(closest);
    for (const item of element.querySelectorAll?.(candidateSelector) || []) capture(item);
  };

  const findRoot = () => rootSelectors.map(selector => document.querySelector(selector)).find(Boolean) || null;
  const bind = () => {
    const root = findRoot();
    if (!root) return false;
    if (state.root === root && state.observer) return true;
    state.observer?.disconnect?.();
    state.root = root;
    state.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' || mutation.type === 'characterData') process(mutation.target);
        else for (const node of mutation.addedNodes) process(node);
      }
    });
    state.observer.observe(root, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['data-mid','data-tid','class','datetime','title','aria-label','id'] });
    emitStatus('listener-installed', {
      adapter:'teams-current-public-github-dom',
      rootTag: root.tagName,
      rootTid: clean(root.getAttribute?.('data-tid')),
      initialCandidates: root.querySelectorAll?.(candidateSelector)?.length || 0,
    });
    process(root);
    return true;
  };

  bind();
  state.rootObserver = new MutationObserver(() => {
    if (!state.root?.isConnected) bind();
  });
  state.rootObserver.observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener('beforeunload', () => {
    state.observer?.disconnect?.();
    state.rootObserver?.disconnect?.();
  }, { once:true });
})();
`;
const SIGNAL_BRIDGE = String.raw`
(() => {
  'use strict';
  // Exact RP01 runtime: Signal Desktop 8.17.0. Read-only rendered-DOM adapter.
  // Frozen Signal preload/Session/Partition/host are not changed.
  const marker = '__mactranslateRealSignalV6';
  if (window[marker]?.installed) return;
  ${BRIDGE_SHARED}
  const state = {
    installed: true,
    root: null,
    observer: null,
    rootObserver: null,
    fingerprints: new Map(),
  };
  window[marker] = state;

  const capture = row => {
    if (!row?.isConnected) return;
    const messageId = clean(row.getAttribute('data-message-id'));
    if (!messageId) return;
    const message = row.querySelector('.module-message');
    if (!message) return;
    const textNode = message.querySelector('.module-message__text');
    const textClone = textNode?.cloneNode(true);
    for (const item of textClone?.querySelectorAll?.('.module-message__metadata,[class*="module-message__metadata"],button,[role="button"]') || []) item.remove();
    const text = clean(textClone?.innerText || textClone?.textContent);
    if (!text) return;
    // In the exact 8.17.0 bundle, Message.render() assigns props.timestamp to
    // .module-message[data-testid]. That gives the real message timestamp.
    const sentAt = timeValue(message.getAttribute('data-testid'));
    if (!sentAt) return;
    const titleNode = document.querySelector('.module-ConversationHeader__header__info__title');
    const conversationTitle = clean(titleNode?.textContent);
    if (!conversationTitle) return;
    const outgoing = message.classList.contains('module-message--outgoing');
    const sender = row.querySelector('.module-message__author');
    const payload = {
      conversationId: '',
      conversationTitle,
      messageId,
      senderId: '',
      senderName: clean(sender?.textContent),
      direction: outgoing ? 'outgoing' : 'incoming',
      sentAt,
      timestampQuality: 'provider',
      text,
      providerEvent: 'signal-8.17.0-rendered-dom-readonly',
    };
    const fp = [conversationTitle,messageId,payload.direction,sentAt,text].join('\u001f');
    if (state.fingerprints.get(messageId) === fp) return;
    state.fingerprints.set(messageId, fp);
    emit({ kind:'message', payload });
  };

  const process = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return;
    const selector = '[data-message-id][role="listitem"]';
    if (element.matches?.(selector)) capture(element);
    const closest = element.closest?.(selector);
    if (closest) capture(closest);
    for (const row of element.querySelectorAll?.(selector) || []) capture(row);
  };

  const bind = () => {
    const root = document.querySelector('.module-timeline__messages__container,.module-timeline__messages,.module-timeline');
    if (!root) return false;
    if (state.root === root && state.observer) return true;
    state.observer?.disconnect?.();
    state.root = root;
    state.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' || mutation.type === 'characterData') process(mutation.target);
        else for (const node of mutation.addedNodes) process(node);
      }
    });
    state.observer.observe(root, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['data-message-id','data-testid','class'] });
    emitStatus('listener-installed', {
      adapter:'signal-8.17.0-rendered-dom-readonly',
      rootClass: clean(root.className),
    });
    process(root);
    return true;
  };

  bind();
  state.rootObserver = new MutationObserver(() => {
    if (!state.root?.isConnected) bind();
  });
  state.rootObserver.observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener('beforeunload', () => {
    state.observer?.disconnect?.();
    state.rootObserver?.disconnect?.();
  }, { once:true });
})();
`;
function scriptFor(service: ServiceName): string {
  switch (service) {
    case 'whatsapp':
      return WHATSAPP_BRIDGE;
    case 'telegram':
      return TELEGRAM_BRIDGE;
    case 'teams':
      return TEAMS_BRIDGE;
    case 'signal':
      return SIGNAL_BRIDGE;
    default:
      return '';
  }
}

async function inject(target: AttachedTarget, reason: string): Promise<void> {
  const { contents } = target;
  if (contents.isDestroyed()) return;
  const currentUrl = contents.getURL();
  const detected = detectService(currentUrl);
  if (detected !== target.service) return;
  if (target.lastInjectedSequence === target.documentSequence) return;
  target.lastInjectedSequence = target.documentSequence;
  target.injectionGeneration += 1;
  try {
    await contents.executeJavaScript(scriptFor(target.service), true);
    recordStatus(target, 'injection-complete', {
      reason,
      generation: target.injectionGeneration,
      documentSequence: target.documentSequence,
    });
  } catch (error) {
    target.lastInjectedSequence = -1;
    recordStatus(target, 'injection-error', {
      reason,
      generation: target.injectionGeneration,
      documentSequence: target.documentSequence,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function detach(contents: WebContents): void {
  const target = targets.get(contents.id);
  if (target?.retryTimer) clearTimeout(target.retryTimer);
  targets.delete(contents.id);
}

function attach(contents: WebContents): void {
  if (contents.isDestroyed() || hookedContents.has(contents.id)) return;
  hookedContents.add(contents.id);

  let instanceRetryTimer: NodeJS.Timeout | null = null;
  let instanceRetryCount = 0;

  const scheduleInstanceRetry = (): void => {
    if (instanceRetryTimer || contents.isDestroyed()) return;
    instanceRetryTimer = setTimeout(() => {
      instanceRetryTimer = null;
      tryAttach('authoritative-instance-retry', true);
    }, 500);
  };

  const tryAttach = (reason: string, shouldInject: boolean): void => {
    if (contents.isDestroyed()) return;
    const url = contents.getURL();
    const service = detectService(url);
    if (!service) return;
    const serviceInstanceId = authoritativeInstanceId(contents, service);
    if (!serviceInstanceId) {
      instanceRetryCount += 1;
      if (instanceRetryCount === 1 || instanceRetryCount % 20 === 0) {
        const temporary: AttachedTarget = {
          service,
          serviceInstanceId: `unresolved-webcontents-${contents.id}`,
          contents,
          url,
          documentSequence: 0,
          lastInjectedSequence: -1,
          injectionGeneration: 0,
          retryTimer: null,
        };
        recordStatus(temporary, 'waiting-authoritative-instance', {
          attempts: instanceRetryCount,
          storagePath: clean((contents.session as any)?.storagePath),
        });
      }
      scheduleInstanceRetry();
      return;
    }

    instanceRetryCount = 0;
    if (instanceRetryTimer) {
      clearTimeout(instanceRetryTimer);
      instanceRetryTimer = null;
    }

    let target = targets.get(contents.id);
    if (
      target &&
      (target.service !== service || target.serviceInstanceId !== serviceInstanceId)
    ) {
      detach(contents);
      target = undefined;
    }
    if (!target) {
      target = {
        service,
        serviceInstanceId,
        contents,
        url,
        documentSequence: 1,
        lastInjectedSequence: -1,
        injectionGeneration: 0,
        retryTimer: null,
      };
      targets.set(contents.id, target);
      recordStatus(target, 'target-attached', {
        reason,
        webContentsType: contents.getType(),
      });
    } else {
      target.url = url;
    }
    if (shouldInject) void inject(target, reason);
  };

  (contents as any).on(
    'console-message',
    (_event: unknown, ...arguments_: unknown[]) => {
      const first = arguments_[0] as { message?: unknown } | undefined;
      const message =
        first && typeof first === 'object' && 'message' in first
          ? String(first.message ?? '')
          : String(arguments_[1] ?? '');
      const target = targets.get(contents.id);
      if (target) parseConsoleMessage(target, message);
    },
  );
  contents.on(
    'did-start-navigation',
    (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      const target = targets.get(contents.id);
      if (target) {
        target.documentSequence += 1;
        target.lastInjectedSequence = -1;
      }
    },
  );
  contents.on('dom-ready', () => tryAttach('dom-ready', true));
  contents.on('did-finish-load', () => tryAttach('did-finish-load', true));
  contents.on('did-navigate', () => tryAttach('did-navigate', false));
  contents.on('did-navigate-in-page', () => tryAttach('did-navigate-in-page', false));
  contents.once('destroyed', () => {
    if (instanceRetryTimer) clearTimeout(instanceRetryTimer);
    hookedContents.delete(contents.id);
    detach(contents);
  });
  tryAttach('existing', true);
}

export default function registerUnifiedMessageRecognition(): void {
  if (started) return;
  started = true;
  app.on('web-contents-created', (_event, contents) => attach(contents));
  const attachExisting = () => {
    for (const contents of webContents.getAllWebContents()) attach(contents);
  };
  if (app.isReady()) attachExisting();
  else app.once('ready', attachExisting);
  debug('RP01 source-backed real-message recognition v6 registered (Signal/WhatsApp/Telegram/Teams)');
}
