/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  webContents,
  type WebContents,
} from 'electron';
import { getSignalAccountIdForWebContents } from '../signal/EmbeddedSignalEngine';
import {
  armLiveMessageTranslation,
  stopLiveMessageTranslation,
} from './LiveMessageTranslation';

const debug = require('../../preload-safe-debug')(
  'MacTranslate:RealMessageRecognitionV6',
);

const CONSOLE_PREFIX = '__MACTRANSLATE_REAL_MESSAGE_V6__';
const SCHEMA = 'mactranslate-real-message-v6';
const STATUS_SCHEMA = 'mactranslate-real-message-status-v6';
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_SEEN = 300_000;
const RECOGNITION_RUN_ID = randomUUID();
const RECOGNITION_RUN_STARTED_AT = Date.now();

type ServiceName = 'whatsapp' | 'telegram' | 'teams' | 'signal';
type MessageDirection = 'incoming' | 'outgoing';

export type RecognizedChatMessage = {
  schema: typeof SCHEMA;
  recognitionRunId: string;
  recognitionRunStartedAt: number;
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
  signalCacheTimer: NodeJS.Timeout | null;
  signalCacheBusy: boolean;
  signalHistoryPrimed: boolean;
};

const targets = new Map<number, AttachedTarget>();
const hookedContents = new Set<number>();
const pendingConsoleEnvelopes = new Map<number, string[]>();
const MAX_PENDING_CONSOLE_ENVELOPES = 200;
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

export function recognitionDirectory(): string {
  // Keep the archive path stable on macOS regardless of package/app-name changes.
  // The acceptance/check scripts use the same canonical location.
  if (process.platform === 'darwin') {
    return path.join(app.getPath('appData'), 'MacTranslate', 'MessageRecognitionV6');
  }
  return path.join(app.getPath('userData'), 'MessageRecognitionV6');
}

function writeCurrentRunMarker(): void {
  const directory = recognitionDirectory();
  const file = path.join(directory, 'current-run.json');
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        file,
        `${JSON.stringify({
          schema: 'mactranslate-real-message-run-v1',
          recognitionRunId: RECOGNITION_RUN_ID,
          startedAt: RECOGNITION_RUN_STARTED_AT,
          pid: process.pid,
          appVersion: app.getVersion(),
          deviceId: os.hostname(),
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    })
    .catch(error => debug('Recognition run marker write failed', error));
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
    recognitionRunId: RECOGNITION_RUN_ID,
    recognitionRunStartedAt: RECOGNITION_RUN_STARTED_AT,
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
    recognitionRunId: RECOGNITION_RUN_ID,
    recognitionRunStartedAt: RECOGNITION_RUN_STARTED_AT,
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

function extractConsoleEnvelope(arguments_: unknown[]): string {
  // Electron has shipped both console-message shapes:
  //   (event, level, message, line, sourceId)
  // and (event, details:{ message, ... }).
  // Do not depend on a positional argument; find the actual prefixed payload.
  for (const value of arguments_) {
    if (typeof value === 'string' && value.startsWith(CONSOLE_PREFIX)) return value;
    if (value && typeof value === 'object') {
      const message = (value as { message?: unknown }).message;
      if (typeof message === 'string' && message.startsWith(CONSOLE_PREFIX)) {
        return message;
      }
    }
  }
  return '';
}

function queuePendingConsoleEnvelope(contentsId: number, message: string): void {
  const queue = pendingConsoleEnvelopes.get(contentsId) ?? [];
  queue.push(message);
  if (queue.length > MAX_PENDING_CONSOLE_ENVELOPES) {
    queue.splice(0, queue.length - MAX_PENDING_CONSOLE_ENVELOPES);
  }
  pendingConsoleEnvelopes.set(contentsId, queue);
}

function flushPendingConsoleEnvelopes(target: AttachedTarget): void {
  const queue = pendingConsoleEnvelopes.get(target.contents.id);
  if (!queue?.length) return;
  pendingConsoleEnvelopes.delete(target.contents.id);
  for (const message of queue) parseConsoleMessage(target, message);
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
    loggerReady: false,
    loggerWaitPromise: null,
    accountId: '',
    seen: new Set(),
    unavailableReported: false,
    historyScanStarted: false,
    historyScanned: 0,
    historyCaptured: 0,
    historyPages: 0,
    historyChats: 0,
    historyDbUnavailableReported: false,
    networkHistoryPages: 0,
    networkHistoryChats: 0,
    networkHistoryCaptured: 0,
    networkHistoryErrors: 0,
    residentHistoryScanned: 0,
    residentHistoryCaptured: 0,
    dbChatTitles: new Map(),
    dbContactNames: new Map(),
    historyConversationAliases: new Map(),
    chatMsgListeners: new Map(),
    chatCollectionAddHandler: null,
  };
  window[marker] = state;

  // Source path: whatsapp-web.js Client.attachEventListeners().
  // It listens to window.require('WAWebCollections').Msg.on('add').
  // WATagsLogger exposes whenReady(); wait for that bootstrap barrier before
  // requiring WAWebCollections so our read-only listener cannot initialize
  // WhatsApp modules ahead of the page's own logger.
  // We stay read-only. For message text, mirror WhatsApp ExportChat's
  // getters instead of restricting capture to MSG_TYPE.CHAT: media captions,
  // polls and rich-response text are valid textual message content too.
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

  const canonicalConversationId = value => {
    const key = wid(value);
    if (!key) return '';
    return clean(state.historyConversationAliases.get(key) || '') || key;
  };

  const conversationTitle = chatId => {
    try {
      const rawKey = wid(chatId);
      const key = canonicalConversationId(rawKey);
      const chat = state.collections?.Chat?.get?.(chatId) || state.collections?.Chat?.get?.(rawKey) || state.collections?.Chat?.get?.(key);
      const live = clean(chat?.formattedTitle || chat?.name || chat?.contact?.formattedName || chat?.contact?.name || chat?.contact?.pushname || '');
      return live || clean(state.dbChatTitles.get(key) || state.dbChatTitles.get(rawKey) || '') || key || rawKey;
    } catch {
      return canonicalConversationId(chatId) || wid(chatId);
    }
  };

  const senderName = senderId => {
    try {
      const key = wid(senderId);
      const contact = state.collections?.Contact?.get?.(senderId) || state.collections?.Contact?.get?.(key);
      const live = clean(contact?.formattedName || contact?.name || contact?.pushname || contact?.shortName || '');
      return live || clean(state.dbContactNames.get(key) || '');
    } catch {
      return '';
    }
  };

  const exportExcludedTypes = new Set(['protocol', 'reaction', 'reaction_enc', 'poll_update', 'keep_in_chat', 'pin_message']);
  const exportMediaTypes = new Set(['image', 'video', 'audio', 'ptt', 'ptv', 'document', 'sticker']);
  let cachedMsgGetters = null;
  let cachedBotPlainText = null;
  const extractMessageText = (msg, data) => {
    try {
      const getters = cachedMsgGetters || (cachedMsgGetters = safeRequire('WAWebMsgGetters'));
      const type = clean(getters?.getType?.(msg) ?? data?.type ?? msg?.type).toLowerCase();

      // WAWebExportChatAction deliberately excludes these internal event types.
      // Do the same so structured protocol payloads never become fake text.
      if (exportExcludedTypes.has(type)) return '';
      if (clean(data?.subtype ?? msg?.subtype).toLowerCase() === 'change_username') return '';
      if (data?.isViewOnce === true || msg?.isViewOnce === true) return '';

      const caption = clean(getters?.getCaption?.(msg) ?? data?.caption ?? msg?.caption);
      // ExportChat's formatter uses caption (not body) for media. This avoids
      // turning opaque media payload/body fields into fake text while preserving captions.
      if (exportMediaTypes.has(type)) return caption;
      if (caption) return caption;

      if (type === 'poll_creation') {
        const pollName = clean(getters?.getPollName?.(msg) ?? data?.pollName ?? msg?.pollName);
        if (pollName) return pollName;
      }

      if (type === 'rich_response') {
        const bot = cachedBotPlainText || (cachedBotPlainText = safeRequire('WAWebGetPlainTextFromBotMsg'));
        try {
          const botText = clean(bot?.getPlainTextFromBotMsg?.(msg, { includeBodyFallback: false }));
          if (botText) return botText;
        } catch {}
      }

      return clean(getters?.getBody?.(msg) ?? data?.body ?? msg?.body);
    } catch {
      return clean(data?.caption ?? msg?.caption ?? data?.body ?? msg?.body);
    }
  };

  const capture = (msg, providerEvent, allowHistorical = false) => {
    try {
      if (!msg || (!allowHistorical && msg.isNewMsg !== true)) return false;

      const data = serialize(msg);
      const id = data.id || msg.id;
      const fromMe = Boolean(id?.fromMe);
      if (fromMe && !state.accountId) state.accountId = wid(data.from ?? msg.from);
      const text = extractMessageText(msg, data);
      if (!text) return false;

      // Mirror whatsapp-web.js Message._getChatId(): outgoing -> to, incoming -> from.
      // id.remote is retained only as a fallback for internal model variations.
      const chatWid = fromMe
        ? (data.to ?? msg.to ?? id?.remote)
        : (data.from ?? msg.from ?? id?.remote);
      const rawConversationId = wid(chatWid);
      const conversationId = canonicalConversationId(rawConversationId);
      if (!conversationId || rawConversationId === 'status@broadcast' || conversationId === 'status@broadcast') return false;

      const providerMessageId = clean(id?._serialized) ||
        [fromMe ? 'true' : 'false', conversationId, clean(id?.id)].filter(Boolean).join('_');
      if (!providerMessageId) return false;
      const bridgeSeenKey = providerMessageId + '\u001f' + conversationId;
      if (state.seen.has(bridgeSeenKey)) return false;

      const sentAt = timeValue(data.t ?? msg.t ?? data.timestamp ?? msg.timestamp);
      if (!sentAt) return false;

      const authorWid = data.author ?? msg.author;
      const fromWid = data.from ?? msg.from;
      const sourceWid = fromMe ? null : (authorWid || fromWid);
      const sourceId = fromMe ? resolveAccountId() : wid(sourceWid);

      state.seen.add(bridgeSeenKey);
      if (state.seen.size > 20000) state.seen.delete(state.seen.values().next().value);

      emit({ kind: 'message', payload: {
        accountId: resolveAccountId(),
        conversationId,
        conversationTitle: conversationTitle(conversationId),
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
    if (!msg) return;

    // WAWebCollections.Msg also receives history rows that become resident after
    // opening/scrolling a chat. Those rows have isNewMsg !== true and must still
    // be archived as historical provider data. Live-message semantics remain the
    // same for isNewMsg === true.
    const historical = msg.isNewMsg !== true;
    if (clean(msg.type) !== 'ciphertext') {
      capture(
        msg,
        historical ? 'whatsapp-wawebcollections-history-add' : 'whatsapp-wawebcollections-msg-add',
        historical,
      );
      return;
    }

    if (typeof msg.once === 'function') {
      msg.once('change:type', changed => {
        if (!changed || clean(changed.type) === 'revoked') return;
        capture(
          changed,
          historical ? 'whatsapp-wawebcollections-history-decrypted' : 'whatsapp-wawebcollections-ciphertext-decrypted',
          historical,
        );
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

  const modelsOf = collection => {
    try {
      if (typeof collection?.getModelsArray === 'function') return collection.getModelsArray();
      if (Array.isArray(collection?.models)) return collection.models.slice();
      if (Array.isArray(collection?._models)) return collection._models.slice();
    } catch {}
    return [];
  };

  const detachChatMsgListeners = () => {
    for (const entry of state.chatMsgListeners.values()) {
      try { entry.collection?.off?.('add', entry.handler); } catch {}
    }
    state.chatMsgListeners.clear();
    try {
      if (state.collections?.Chat && state.chatCollectionAddHandler) {
        state.collections.Chat.off?.('add', state.chatCollectionAddHandler);
      }
    } catch {}
    state.chatCollectionAddHandler = null;
  };

  const attachChatMsgListener = chat => {
    try {
      const chatId = wid(chat?.id);
      const collection = chat?.msgs;
      if (!chatId || !collection || typeof collection.on !== 'function') return;
      const existing = state.chatMsgListeners.get(chatId);
      if (existing?.collection === collection) return;
      if (existing) {
        try { existing.collection?.off?.('add', existing.handler); } catch {}
      }
      const handler = msg => {
        if (!msg) return;
        state.historyScanned += 1;
        if (capture(msg, 'whatsapp-chat-msgs-history-add', true)) {
          state.historyCaptured += 1;
          state.residentHistoryCaptured += 1;
        }
      };
      collection.on('add', handler);
      state.chatMsgListeners.set(chatId, { collection, handler });
    } catch {}
  };

  const attachAllChatMsgListeners = () => {
    for (const chat of modelsOf(state.collections?.Chat)) attachChatMsgListener(chat);
    const Chat = state.collections?.Chat;
    if (Chat && typeof Chat.on === 'function' && !state.chatCollectionAddHandler) {
      state.chatCollectionAddHandler = chat => attachChatMsgListener(chat);
      Chat.on('add', state.chatCollectionAddHandler);
    }
  };

  const captureResidentChatHistory = () => {
    // whatsapp-web.js Chat.fetchMessages() starts from chat.msgs.getModelsArray()
    // BEFORE it calls WAWebChatLoadMessages.loadEarlierMsgs(). Capture the same
    // resident collections first; noEarlierMsgs may already be true precisely
    // because these rows are fully hydrated in the active chat.
    let scanned = 0;
    let captured = 0;
    for (const chat of modelsOf(state.collections?.Chat)) {
      attachChatMsgListener(chat);
      const chatId = wid(chat?.id);
      if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) continue;
      const title = clean(chat?.formattedTitle || chat?.name || chat?.contact?.formattedName || chat?.contact?.name || chat?.contact?.pushname || '');
      if (title) state.dbChatTitles.set(chatId, title);
      const resident = modelsOf(chat?.msgs)
        .filter(Boolean)
        .sort((a, b) => Number(a?.t || 0) - Number(b?.t || 0));
      for (const msg of resident) {
        scanned += 1;
        state.historyScanned += 1;
        if (capture(msg, 'whatsapp-chat-resident-history', true)) {
          captured += 1;
          state.historyCaptured += 1;
        }
      }
    }
    state.residentHistoryScanned += scanned;
    state.residentHistoryCaptured += captured;
    return { scanned, captured };
  };

  const scanLoadedHistory = Msg => {
    if (state.historyScanStarted) return;
    state.historyScanStarted = true;
    let models = loadedModels(Msg)
      .filter(Boolean)
      .sort((a, b) => Number(a?.t || 0) - Number(b?.t || 0));

    // First capture the provider models already resident in memory, then page
    // WhatsApp's own local message DB backwards. No loadEarlierMsgs/network call.
    const MEMORY_LIMIT = 1000;
    if (models.length > MEMORY_LIMIT) models = models.slice(models.length - MEMORY_LIMIT);
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
      captureResidentChatHistory();
      setTimeout(pageLocalHistory, 0);
    };
    setTimeout(runChunk, 0);
  };

  const messageAnchorKey = msg => {
    try {
      const id = msg?.id;
      const serialized = clean(id?._serialized);
      if (serialized) return serialized;
      const rendered = clean(id?.toString?.());
      if (rendered && rendered !== '[object Object]') return rendered;
      return [wid(id?.remote), id?.fromMe ? '1' : '0', clean(id?.id)].filter(Boolean).join(':');
    } catch { return ''; }
  };

  const syncLiveChatHistory = async () => {
    // whatsapp-web.js Chat.fetchMessages({limit: Infinity}) repeatedly calls
    // WAWebChatLoadMessages.loadEarlierMsgs({ chat }) until it returns no rows.
    // Use the same provider path after the native local ExportChat pass so chats
    // whose older history is not currently resident in the local DB can be
    // completed through WhatsApp's own history loader. This does not switch the
    // visible conversation; it operates on the existing Chat model/message collection.
    const loader = safeRequire('WAWebChatLoadMessages');
    if (!loader || typeof loader.loadEarlierMsgs !== 'function') {
      emitStatus('whatsapp-provider-history-loader-unavailable', {
        hasLoader: Boolean(loader),
        hasLoadEarlierMsgs: typeof loader?.loadEarlierMsgs === 'function',
      });
      return;
    }

    const liveChats = modelsOf(state.collections?.Chat)
      .filter(chat => {
        const id = wid(chat?.id);
        return id && id !== 'status@broadcast' && !id.endsWith('@newsletter');
      });
    const MAX_PROVIDER_PAGES_PER_CHAT = 2000;

    for (const chat of liveChats) {
      const chatId = wid(chat?.id);
      if (!chatId) continue;
      let pages = 0;
      let capturedForChat = 0;
      let progressed = false;

      // Refresh resident collections immediately before provider paging too.
      // This catches a chat opened while the local-DB pass was running; state.seen
      // keeps rows already captured by the pre-pass from being persisted twice.
      const resident = modelsOf(chat?.msgs)
        .filter(Boolean)
        .sort((a, b) => Number(a?.t || 0) - Number(b?.t || 0));
      for (const msg of resident) {
        state.residentHistoryScanned += 1;
        state.historyScanned += 1;
        if (capture(msg, 'whatsapp-chat-resident-history', true)) {
          state.residentHistoryCaptured += 1;
          state.historyCaptured += 1;
          capturedForChat += 1;
        }
      }

      let previousHead = messageAnchorKey(chat?.msgs?.head?.()) || messageAnchorKey(resident[0]);

      while (pages < MAX_PROVIDER_PAGES_PER_CHAT) {
        if (chat?.msgs?.msgLoadState?.noEarlierMsgs === true) break;
        let loaded;
        try {
          loaded = await loader.loadEarlierMsgs({ chat });
        } catch (error) {
          state.networkHistoryErrors += 1;
          emitStatus('whatsapp-provider-history-page-error', {
            chatId,
            page: pages + 1,
            message: clean(error?.message || error),
          });
          break;
        }

        const batch = Array.isArray(loaded) ? loaded : modelsOf(loaded);
        if (!batch.length) break;
        pages += 1;
        progressed = true;
        state.networkHistoryPages += 1;

        for (const msg of batch) {
          state.historyScanned += 1;
          if (capture(msg, 'whatsapp-wawebchatloadmessages-history', true)) {
            state.historyCaptured += 1;
            state.networkHistoryCaptured += 1;
            capturedForChat += 1;
          }
        }

        const currentHead = messageAnchorKey(chat?.msgs?.head?.()) || messageAnchorKey(batch[0]);
        // Defensive stop if the provider returned data but did not advance the
        // oldest anchor; prevents a bad runtime from looping the same page.
        if (currentHead && previousHead && currentHead === previousHead) break;
        previousHead = currentHead || previousHead;
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      if (progressed) state.networkHistoryChats += 1;
      if (pages >= MAX_PROVIDER_PAGES_PER_CHAT) {
        emitStatus('whatsapp-provider-history-chat-truncated', {
          chatId,
          pages,
          captured: capturedForChat,
          maxPages: MAX_PROVIDER_PAGES_PER_CHAT,
        });
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };

  const pageLocalHistory = async () => {
    // Follow WhatsApp Web's own ExportChat path:
    //   WAWebSchemaChat.getChatTable().all()
    //   -> first anchor { remote: chatWid }
    //   -> WAWebDBMessageFindLocal.msgFindBefore({ anchor, count: 50 })
    //   -> next anchor = returnedMessages[0].id
    // This stays entirely on WhatsApp's local storage and never calls loadEarlierMsgs/network.
    const finder = safeRequire('WAWebDBMessageFindLocal');
    const ChatSchema = safeRequire('WAWebSchemaChat');
    const WidFactory = safeRequire('WAWebWidFactory');
    const ChatBulkHistory = safeRequire('WAWebApiChatBulkGetByHistory');
    const ContactSchema = safeRequire('WAWebSchemaContact_DO_NOT_USE_DIRECTLY');
    const MsgModelFromData = safeRequire('WAWebMsgModelFromData');
    const chatTable = ChatSchema?.getChatTable?.();
    if (!finder || typeof finder.msgFindBefore !== 'function' || !chatTable || typeof chatTable.all !== 'function') {
      if (!state.historyDbUnavailableReported) {
        state.historyDbUnavailableReported = true;
        emitStatus('whatsapp-local-db-history-unavailable', {
          hasFinder: Boolean(finder),
          hasMsgFindBefore: typeof finder?.msgFindBefore === 'function',
          hasChatTable: Boolean(chatTable),
          hasChatTableAll: typeof chatTable?.all === 'function',
        });
      }
      await syncLiveChatHistory();
      emitStatus('whatsapp-history-snapshot-complete', {
        scanned: state.historyScanned,
        captured: state.historyCaptured,
        pages: state.historyPages,
        chats: state.historyChats,
        networkPages: state.networkHistoryPages,
        networkChats: state.networkHistoryChats,
        networkCaptured: state.networkHistoryCaptured,
        networkErrors: state.networkHistoryErrors,
        residentScanned: state.residentHistoryScanned,
        residentCaptured: state.residentHistoryCaptured,
        source: 'WAWebCollections.Msg memory + WAWebChatLoadMessages provider history (native local history API unavailable)',
      });
      return;
    }

    const makeChatWid = value => {
      const key = wid(value);
      if (!key) return null;
      if (value && typeof value === 'object' && clean(value?.toString?.()) === key) return value;
      try {
        if (typeof WidFactory?.createWid === 'function') return WidFactory.createWid(key);
      } catch {}
      return value || key;
    };

    try {
      const chatRows = await chatTable.all();
      const rows = Array.isArray(chatRows) ? chatRows : [];
      const chatsById = new Map();
      const liveChats = modelsOf(state.collections?.Chat);
      const liveIds = new Set(liveChats.map(chat => wid(chat?.id)).filter(Boolean));

      // Current WhatsApp history/LID rule (WAWebApiChatBulkGetByHistory): when
      // forced history-LID mode is active, a regular PN chat is resolved through
      // chat.historyChatId and the returned row.id is the storage chat id that
      // must be used for message DB paging. Keep the visible/live id canonical so
      // old LID-backed rows do not split into a second conversation in MacTranslate.
      for (const chat of liveChats) {
        const liveId = wid(chat?.id);
        if (!liveId || liveId === 'status@broadcast') continue;
        const title = clean(chat?.formattedTitle || chat?.name || chat?.contact?.formattedName || chat?.contact?.name || chat?.contact?.pushname || '');
        if (title) state.dbChatTitles.set(liveId, title);

        let storageRow = null;
        if (typeof ChatBulkHistory?.bulkGetChatsMaybeByHistory === 'function') {
          try {
            const resolved = await ChatBulkHistory.bulkGetChatsMaybeByHistory([makeChatWid(chat?.id) || liveId]);
            storageRow = Array.isArray(resolved) ? resolved[0] : null;
          } catch {}
        }
        if (!storageRow) storageRow = rows.find(row => wid(row?.id) === liveId) || rows.find(row => wid(row?.historyChatId) === liveId) || null;

        const storageId = wid(storageRow?.id) || liveId;
        const historyChatId = wid(storageRow?.historyChatId);
        state.historyConversationAliases.set(storageId, liveId);
        if (historyChatId) state.historyConversationAliases.set(historyChatId, liveId);
        if (title) state.dbChatTitles.set(storageId, title);
        chatsById.set(storageId, {
          id: liveId,
          storageId,
          remote: makeChatWid(storageRow?.id || chat?.id),
          source: storageId === liveId ? 'live' : 'live-history',
        });
      }

      for (const row of rows) {
        const storageId = wid(row?.id);
        if (!storageId || storageId === 'status@broadcast') continue;
        const historyChatId = wid(row?.historyChatId);
        let canonicalId = storageId;
        if (liveIds.has(storageId)) canonicalId = storageId;
        else if (historyChatId && liveIds.has(historyChatId)) canonicalId = historyChatId;
        else if (historyChatId) canonicalId = historyChatId;

        state.historyConversationAliases.set(storageId, canonicalId);
        if (historyChatId) state.historyConversationAliases.set(historyChatId, canonicalId);

        const title = clean(row?.name || row?.formattedTitle || row?.subject || row?.chatTitle || '');
        if (title) {
          if (!state.dbChatTitles.has(canonicalId)) state.dbChatTitles.set(canonicalId, title);
          state.dbChatTitles.set(storageId, title);
        }
        if (!chatsById.has(storageId)) chatsById.set(storageId, {
          id: canonicalId,
          storageId,
          remote: makeChatWid(row?.id),
          source: 'db',
        });
      }

      const contactTable = ContactSchema?.getContactTable?.();
      if (contactTable && typeof contactTable.all === 'function') {
        try {
          const contactRows = await contactTable.all();
          for (const row of Array.isArray(contactRows) ? contactRows : []) {
            const id = wid(row?.id || row?.wid);
            if (!id) continue;
            const name = clean(row?.formattedName || row?.name || row?.pushname || row?.shortName || row?.verifiedName || '');
            if (name) state.dbContactNames.set(id, name);
          }
        } catch {}
      }

      const PAGE_SIZE = 50;       // WhatsApp ExportChatAction uses 50.
      const MAX_PER_CHAT = 100000; // WhatsApp ExportChatAction default safety limit.
      let truncated = false;
      let dbOnlyChats = 0;

      for (const chat of chatsById.values()) {
        if (!chat.remote) continue;
        if (chat.source === 'db') dbOnlyChats += 1;
        let anchor = { remote: chat.remote };
        let lastAnchorKey = 'remote:' + chat.id;
        let chatRead = 0;
        let chatPaged = false;

        while (chatRead < MAX_PER_CHAT) {
          let result;
          try {
            result = await finder.msgFindBefore({ anchor, count: PAGE_SIZE });
          } catch (error) {
            emitStatus('whatsapp-local-db-history-page-error', {
              chatId: chat.id,
              message: clean(error?.message || error),
            });
            break;
          }

          const page = Array.isArray(result?.messages)
            ? result.messages
            : (Array.isArray(result) ? result : []);
          if ((result?.status && Number(result.status) >= 400) || page.length === 0) break;

          chatPaged = true;
          state.historyPages += 1;

          // Keep the provider's returned order for pagination. WhatsApp's own
          // export code uses messages[0].id as the next (older) anchor.
          for (const msg of page) {
            state.historyScanned += 1;
            chatRead += 1;
            let captureModel = msg;
            try {
              if (typeof MsgModelFromData?.msgModelFromMsgData === 'function') {
                captureModel = MsgModelFromData.msgModelFromMsgData(msg) || msg;
              }
            } catch {}
            if (capture(captureModel, 'whatsapp-native-exportchat-local-history', true)) state.historyCaptured += 1;
            if (chatRead >= MAX_PER_CHAT) break;
          }

          const oldest = page[0];
          const nextAnchor = oldest?.id;
          const nextKey = messageAnchorKey(oldest);
          if (!nextAnchor || !nextKey || nextKey === lastAnchorKey) break;
          lastAnchorKey = nextKey;
          anchor = nextAnchor;

          if (chatRead >= MAX_PER_CHAT) {
            truncated = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (chatPaged) state.historyChats += 1;
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      await syncLiveChatHistory();
      emitStatus('whatsapp-history-snapshot-complete', {
        scanned: state.historyScanned,
        captured: state.historyCaptured,
        pages: state.historyPages,
        chats: state.historyChats,
        enumeratedChats: chatsById.size,
        dbOnlyChats,
        truncated,
        networkPages: state.networkHistoryPages,
        networkChats: state.networkHistoryChats,
        networkCaptured: state.networkHistoryCaptured,
        networkErrors: state.networkHistoryErrors,
        residentScanned: state.residentHistoryScanned,
        residentCaptured: state.residentHistoryCaptured,
        source: 'WhatsApp resident chat.msgs + historyChatId/LID-aware ExportChat paging + WAWebChatLoadMessages provider history completion',
      });
    } catch (error) {
      emitStatus('whatsapp-local-db-history-error', {
        message: clean(error?.message || error),
      });
    }
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
      attachAllChatMsgListeners();
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
    if (state.msgCollection || state.retryTimer || state.loggerWaitPromise) return;
    const delays = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000];
    const delay = delays[Math.min(state.retryAttempt, delays.length - 1)];
    state.retryAttempt += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      armProvider();
    }, delay);
  };

  const armProvider = () => {
    // Readiness backoff only. No message query, history paging, socket hook or DOM scan.
    if (state.msgCollection) return;
    if (state.loggerReady) {
      if (!attachCollection()) scheduleRetry();
      return;
    }

    const tagsLogger = safeRequire('WATagsLogger');
    if (!tagsLogger || typeof tagsLogger.whenReady !== 'function') {
      scheduleRetry();
      return;
    }
    if (state.loggerWaitPromise) return;

    try {
      state.loggerWaitPromise = Promise.resolve(tagsLogger.whenReady())
        .then(() => {
          state.loggerWaitPromise = null;
          state.loggerReady = true;
          clearRetry();
          if (!attachCollection()) scheduleRetry();
        })
        .catch(error => {
          state.loggerWaitPromise = null;
          emitStatus('whatsapp-logger-readiness-error', {
            message: clean(error?.message || error),
          });
          scheduleRetry();
        });
    } catch (error) {
      state.loggerWaitPromise = null;
      emitStatus('whatsapp-logger-readiness-error', {
        message: clean(error?.message || error),
      });
      scheduleRetry();
    }
  };

  state.loadHandler = () => armProvider();
  window.addEventListener('load', state.loadHandler, { once: true });
  armProvider();

  window.addEventListener('beforeunload', () => {
    clearRetry();
    detachCollection();
    detachChatMsgListeners();
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

  // R14: Telegram Web A exposes an upstream Force HTTP setting specifically for
  // environments where the primary WebSocket path is unavailable. R13's real runtime
  // screenshot proves HTTP fallback succeeds on this Mac while the initial WebSocket
  // consistently times out. Persist the upstream setting only; no WebSocket/Worker/fetch
  // monkey patch and no CORS response rewriting. A watchdog reverts to upstream fallback
  // mode if Force HTTP cannot reach connectionStateReady.
  const transportMarker='__mactranslateTelegramAdaptiveHttpR14';
  const transportState={retryTimer:null,retryAttempt:0,watchdog:null,mode:sessionStorage.getItem(transportMarker)||''};
  const writeTransportSettings=(force,done)=>{
    let request;
    try{request=indexedDB.open('tt-data');}catch{return done(false,false);}
    request.onerror=()=>done(false,false);
    request.onupgradeneeded=()=>{try{request.transaction?.abort?.();}catch{}done(false,false);};
    request.onsuccess=()=>{
      const db=request.result;
      if(!db?.objectStoreNames?.contains?.('store')){try{db.close();}catch{}done(false,false);return;}
      let tx;
      try{tx=db.transaction('store','readwrite');}catch{try{db.close();}catch{}done(false,false);return;}
      const store=tx.objectStore('store');
      const getRequest=store.get('tt-shared-state');
      let found=false,changed=false;
      getRequest.onsuccess=()=>{
        const current=getRequest.result;
        if(!current||typeof current!=='object')return;
        found=true;
        const settings={...(current.settings&&typeof current.settings==='object'?current.settings:{})};
        if(settings.shouldAllowHttpTransport!==true){settings.shouldAllowHttpTransport=true;changed=true;}
        if(Boolean(settings.shouldForceHttpTransport)!==Boolean(force)){
          settings.shouldForceHttpTransport=Boolean(force);changed=true;
        }
        if(changed)store.put({...current,settings},'tt-shared-state');
      };
      tx.oncomplete=()=>{try{db.close();}catch{}done(found,changed);};
      tx.onerror=()=>{try{db.close();}catch{}done(false,false);};
      tx.onabort=()=>{try{db.close();}catch{}done(false,false);};
    };
  };
  const scheduleTransportRetry=()=>{
    if(transportState.retryTimer||transportState.mode)return;
    const delays=[100,250,500,1000,2000];
    const delay=delays[Math.min(transportState.retryAttempt,delays.length-1)];
    transportState.retryAttempt+=1;
    if(transportState.retryAttempt>40)return;
    transportState.retryTimer=setTimeout(()=>{transportState.retryTimer=null;configureAdaptiveTransport();},delay);
  };
  const configureAdaptiveTransport=()=>{
    if(transportState.mode)return;
    writeTransportSettings(true,(found,changed)=>{
      if(!found){scheduleTransportRetry();return;}
      transportState.mode='force-pending';
      sessionStorage.setItem(transportMarker,transportState.mode);
      emitStatus('telegram-native-http-transport',{allowHttp:true,forceHttp:true,reload:changed,source:'Ajaxy/telegram-tt setSharedSettingOption'});
      if(changed)location.reload();
    });
  };
  configureAdaptiveTransport();
  const state={installed:true,root:null,observer:null,rootObserver:null,leftRoot:null,leftObserver:null,seen:new Map(),previewSeen:new Map(),apiChannel:null,apiPending:new Map(),apiToken:Math.floor(Math.random()*1000000000)+1000000,apiBusy:false,apiTimer:null,apiRetryTimer:null,apiRetryAttempt:0,apiInitialComplete:false,knownTopIds:new Map(),peerTitles:new Map(),accountId:'',apiTruncated:false,connectionState:'',readySince:0};
  window[marker]=state;
  const confirmForceHttpReady=()=>{
    if(transportState.mode!=='force-pending')return;
    transportState.mode='force-confirmed';
    sessionStorage.setItem(transportMarker,transportState.mode);
    if(transportState.watchdog){clearTimeout(transportState.watchdog);transportState.watchdog=null;}
    emitStatus('telegram-force-http-confirmed',{connectionState:'connectionStateReady'});
  };
  const armForceHttpWatchdog=()=>{
    if(transportState.mode!=='force-pending'||transportState.watchdog)return;
    transportState.watchdog=setTimeout(()=>{
      transportState.watchdog=null;
      if(transportState.mode!=='force-pending'||state.connectionState==='connectionStateReady')return;
      writeTransportSettings(false,(found,changed)=>{
        if(!found)return;
        transportState.mode='fallback-only';
        sessionStorage.setItem(transportMarker,transportState.mode);
        emitStatus('telegram-force-http-reverted',{allowHttp:true,forceHttp:false,reload:changed,reason:'no connectionStateReady within watchdog'});
        if(changed)location.reload();
      });
    },20000);
  };
  armForceHttpWatchdog();
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
    const seenKey=payload.conversationId+'\u001f'+messageId;
    if(state.seen.get(seenKey)===fp) return; state.seen.set(seenKey,fp); emit({kind:'message',payload});
  };
  const previewTime = row => {
    const time = row.querySelector('.LastMessageMeta .time,.info-row .time,time[datetime]');
    const raw = clean(time?.getAttribute?.('datetime') || time?.getAttribute?.('title') || time?.textContent);
    let value = timeValue(raw);
    if (value) return value;
    const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (hm) {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hm[1]), Number(hm[2]), 0).getTime();
    }
    return Date.now();
  };
  const unreadCountOf = row => {
    const direct = row.querySelector('.ChatBadge.unread:not(.muted)');
    if (direct) return Math.max(1, Number(clean(direct.textContent)) || 1);
    const transition = row.querySelector('.chat-badge-transition');
    if (!transition || row.querySelector('.icon-muted')) return 0;
    const value = Number(clean(transition.textContent).replace(/\D+/g,''));
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const previewTextOf = row => {
    const subtitle = row.querySelector('.info .subtitle,.subtitle');
    if (!subtitle) return '';
    const clone = subtitle.cloneNode(true);
    for (const item of clone.querySelectorAll('.ChatBadge,.chat-badge-transition,.LastMessageMeta,.icon-muted,.typing-status,svg,button,[role="button"]')) item.remove();
    for (const img of clone.querySelectorAll('img.emoji,img[alt]')) img.replaceWith(document.createTextNode(img.getAttribute('alt')||''));
    return clean(clone.innerText || clone.textContent);
  };
  const captureUnreadPreview = row => {
    if (!row?.isConnected || !row.matches?.('#LeftColumn .ListItem.Chat,.ListItem.Chat')) return;
    const unreadCount = unreadCountOf(row);
    if (!unreadCount) return;
    let conversationId = clean(row.querySelector('div[data-peer-id]')?.getAttribute('data-peer-id'));
    if (!conversationId) return;
    if (conversationId.startsWith('-100') && conversationId.length === 14) conversationId = conversationId.replace('-100','-');
    const conversationTitle = clean(row.querySelector('div.info div.title .fullName,.info .title .fullName,.fullName')?.textContent);
    const text = previewTextOf(row);
    if (!text) return;
    const sentAt = previewTime(row);
    const timeLabel = clean(row.querySelector('.LastMessageMeta .time,.info-row .time')?.textContent);
    const messageId = 'preview-' + [conversationId,timeLabel,text].join('\u001f');
    const fp = [conversationId,unreadCount,timeLabel,text].join('\u001f');
    if (state.previewSeen.get(conversationId) === fp) return;
    state.previewSeen.set(conversationId, fp);
    emitStatus('telegram-unread-preview-observed',{conversationId,conversationTitle,unreadCount,timeLabel,text});
    scheduleTelegramApiSync(100);
  };
  const telegramSlot = () => Number(new URL(location.href).searchParams.get('account')) || 1;
  const telegramChannelName = () => 'tt-global_' + telegramSlot();
  const telegramAccountId = () => {
    if (state.accountId) return state.accountId;
    try {
      const raw = localStorage.getItem('account' + telegramSlot());
      const parsed = raw ? JSON.parse(raw) : null;
      state.accountId = clean(parsed?.userId);
    } catch {}
    return state.accountId;
  };
  const telegramPeerTitle = peerId => clean(state.peerTitles.get(clean(peerId)) || '');
  const rememberTelegramPeers = response => {
    for (const user of response?.users || []) {
      const id=clean(user?.id); if(!id) continue;
      const title=clean([user?.firstName,user?.lastName].filter(Boolean).join(' ') || user?.username || user?.phoneNumber || '');
      if(title) state.peerTitles.set(id,title);
    }
    for (const chat of response?.chats || []) {
      const id=clean(chat?.id); if(!id) continue;
      const title=clean(chat?.title || chat?.username || '');
      if(title) state.peerTitles.set(id,title);
    }
  };
  const telegramMessageText = message => {
    const text=clean(message?.content?.text?.text); if(text)return text;
    const content=message?.content || {};
    if(content.photo)return '[Photo]';
    if(content.video)return '[Video]';
    if(content.voice)return '[Voice message]';
    if(content.audio)return clean(content.audio.title||content.audio.fileName||'[Audio]');
    if(content.document)return clean(content.document.fileName||'[Document]');
    if(content.sticker)return clean(content.sticker.emoji||'[Sticker]');
    if(content.contact)return clean([content.contact.firstName,content.contact.lastName].filter(Boolean).join(' '))||'[Contact]';
    if(content.pollId)return '[Poll]';
    if(content.location)return '[Location]';
    return '';
  };
  const captureTelegramApiMessage = (chat,message) => {
    const conversationId=clean(message?.chatId||chat?.id); if(!conversationId)return false;
    const messageId=clean(message?.id); const text=telegramMessageText(message); const sentAt=timeValue(message?.date);
    if(!messageId||!text||!sentAt)return false;
    const outgoing=message?.isOutgoing===true;
    const senderId=outgoing?'':clean(message?.senderId);
    const payload={
      accountId:telegramAccountId(),conversationId,conversationTitle:telegramPeerTitle(conversationId)||clean(chat?.title||chat?.username||''),messageId,
      senderId,senderName:outgoing?'':telegramPeerTitle(senderId),direction:outgoing?'outgoing':'incoming',sentAt,timestampQuality:'provider',text,
      providerEvent:'telegram-web-a-api-fetchMessages'
    };
    const key=conversationId+'\u001f'+messageId;
    const fp=[conversationId,messageId,payload.direction,sentAt,text].join('\u001f');
    if(state.seen.get(key)===fp)return false;
    state.seen.set(key,fp); emit({kind:'message',payload}); return true;
  };
  // Telegram Web A does NOT persist connectionState in reduceGlobal(). The authoritative
  // live state is broadcast between tabs on DATA_BROADCAST_CHANNEL_NAME as globalUpdate /
  // globalDiffUpdate. Listen to that same upstream channel instead of reading stale IDB.
  const setTelegramConnectionState = (value,source) => {
    const next=clean(value);
    if(!next||next===state.connectionState)return;
    state.connectionState=next;
    if(next==='connectionStateReady'){
      state.readySince=Date.now();
      confirmForceHttpReady();
      emitStatus('telegram-live-connection-ready',{source:clean(source)||'tt-global'});
      return;
    }
    state.readySince=0;
    // A reconnect is normal. Abort only MacTranslate's in-flight history RPC waiters so
    // they do not manufacture 30-second timeout errors while Telegram changes transport.
    for(const [messageId,pending] of state.apiPending){
      state.apiPending.delete(messageId);
      clearTimeout(pending.timer);
      pending.reject(new Error('MACTRANSLATE_TELEGRAM_NOT_READY'));
    }
  };
  const telegramApiIsReady = async () => (
    state.connectionState==='connectionStateReady'
    && state.readySince>0
    && Date.now()-state.readySince>=8000
  );
  const ensureTelegramApiChannel = () => {
    if(state.apiChannel)return state.apiChannel;
    try{
      const channel=new BroadcastChannel(telegramChannelName());
      channel.addEventListener('message',event=>{
        const data=event?.data;
        if(!data)return;
        if(data.type==='globalDiffUpdate'){
          const live=data.diff?.connectionState;
          if(typeof live==='string')setTelegramConnectionState(live,'globalDiffUpdate');
          return;
        }
        if(data.type==='globalUpdate'){
          const live=data.global?.connectionState;
          if(typeof live==='string')setTelegramConnectionState(live,'globalUpdate');
          return;
        }
        if(data.type!=='messageResponse'||data.token!==state.apiToken)return;
        const pending=state.apiPending.get(clean(data.messageId));
        if(!pending)return;
        state.apiPending.delete(clean(data.messageId));
        clearTimeout(pending.timer);
        pending.resolve(data.response);
      });
      state.apiChannel=channel;
      return channel;
    }catch{return null;}
  };
  // Open the listener immediately at DOM-ready so we observe Telegram's own
  // Connecting -> Ready transition before the first history sync attempt.
  ensureTelegramApiChannel();
  const telegramCallApi = (name,args,timeoutMs=30000) => new Promise((resolve,reject)=>{
    const channel=ensureTelegramApiChannel();
    if(!channel){reject(new Error('Telegram BroadcastChannel unavailable'));return;}
    const messageId='mactr-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    const timer=setTimeout(()=>{state.apiPending.delete(messageId);reject(new Error('Telegram API timeout: '+name));},timeoutMs);
    state.apiPending.set(messageId,{resolve,reject,timer});
    try{channel.postMessage({type:'callApi',token:state.apiToken,messageId,name,args});}
    catch(error){clearTimeout(timer);state.apiPending.delete(messageId);reject(error);}
  });
  const fetchTelegramDialogSet = async archived => {
    const chats=new Map();
    const topIds=new Map();
    let args={limit:100,archived:Boolean(archived),withPinned:true};
    let pages=0;
    while(pages<100){
      const result=await telegramCallApi('fetchChats',[args]);
      if(!result)break;
      pages+=1; rememberTelegramPeers(result);
      for(const chat of result.chats||[]){const id=clean(chat?.id);if(id)chats.set(id,chat);}
      for(const [id,value] of Object.entries(result.lastMessageByChatId||{})){const n=Number(value);if(id&&Number.isFinite(n)&&n>0)topIds.set(clean(id),n);}
      const nextId=Number(result.nextOffsetId||0); const nextPeerId=clean(result.nextOffsetPeerId); const nextDate=Number(result.nextOffsetDate||0);
      if(!nextId||!nextPeerId||!nextDate||!(result.chats||[]).length)break;
      const offsetPeer=chats.get(nextPeerId)||{id:nextPeerId};
      args={limit:100,archived:Boolean(archived),withPinned:false,offsetDate:nextDate,offsetPeer,offsetId:nextId};
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(pages>=100)state.apiTruncated=true;
    return {chats,topIds,pages};
  };
  const fetchTelegramHistory = async (chat,stopAtId=0) => {
    const PAGE_SIZE=100; const MAX_PAGES=1000;
    let offsetId; let pages=0,captured=0,scanned=0,reachedKnown=false,lastOldest=0;
    while(pages<MAX_PAGES){
      const result=await telegramCallApi('fetchMessages',[{chat,threadId:-1,offsetId,limit:PAGE_SIZE}]);
      if(!result||!Array.isArray(result.messages)||!result.messages.length)break;
      pages+=1; rememberTelegramPeers(result);
      const messages=result.messages.slice().sort((a,b)=>Number(a?.date||0)-Number(b?.date||0));
      for(const message of messages){
        scanned+=1;
        if(stopAtId&&Number(message?.id)===Number(stopAtId))reachedKnown=true;
        if(captureTelegramApiMessage(chat,message))captured+=1;
      }
      if(reachedKnown)break;
      const positive=result.messages.map(m=>Number(m?.id)).filter(id=>Number.isFinite(id)&&id>0);
      if(!positive.length||result.messages.length<PAGE_SIZE)break;
      const oldest=Math.min(...positive);
      if(!oldest||oldest===lastOldest)break;
      lastOldest=oldest; offsetId=oldest;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const truncated=pages>=MAX_PAGES;
    if(truncated)state.apiTruncated=true;
    return {pages,captured,scanned,truncated,reachedKnown};
  };
  const syncTelegramApiHistory = async initial => {
    if(state.apiBusy)return;
    state.apiBusy=true;
    let dialogPages=0,chatCount=0,historyPages=0,scanned=0,captured=0,failed=0;
    try{
      telegramAccountId();
      if(!(await telegramApiIsReady())){
        if(initial&&!state.apiRetryTimer){
          state.apiRetryTimer=setTimeout(()=>{state.apiRetryTimer=null;void syncTelegramApiHistory(true);},1500);
        }
        return;
      }
      // Avoid two simultaneous GetDialogs requests immediately after a reconnect.
      const normal=await fetchTelegramDialogSet(false);
      const archived=await fetchTelegramDialogSet(true);
      dialogPages=normal.pages+archived.pages;
      const chats=new Map([...normal.chats,...archived.chats]);
      const topIds=new Map([...normal.topIds,...archived.topIds]);
      chatCount=chats.size;
      for(const [chatId,chat] of chats){
        const top=Number(topIds.get(chatId)||0); const known=Number(state.knownTopIds.get(chatId)||0);
        if(!initial&&known&&top===known)continue;
        try{
          const result=await fetchTelegramHistory(chat,initial?0:known);
          historyPages+=result.pages; scanned+=result.scanned; captured+=result.captured;
          if(top)state.knownTopIds.set(chatId,top);
        }catch(error){failed+=1;emitStatus('telegram-api-chat-error',{chatId,message:clean(error?.message||error)});}
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      state.apiInitialComplete=true; state.apiRetryAttempt=0;
      emitStatus(initial?'telegram-api-history-snapshot-complete':'telegram-api-history-incremental-complete',{
        chats:chatCount,dialogPages,historyPages,scanned,captured,failed,truncated:Boolean(state.apiTruncated),
        source:'Telegram Web A native fetchChats + fetchMessages/GetHistory via tt-global BroadcastChannel'
      });
    }catch(error){
      const message=clean(error?.message||error);
      if(message!=='MACTRANSLATE_TELEGRAM_NOT_READY'){
        emitStatus('telegram-api-history-error',{message,initial:Boolean(initial)});
      }
      if(initial&&!state.apiRetryTimer){
        const delays=[1000,2000,4000,8000,15000]; const delay=delays[Math.min(state.apiRetryAttempt++,delays.length-1)];
        state.apiRetryTimer=setTimeout(()=>{state.apiRetryTimer=null;void syncTelegramApiHistory(true);},delay);
      }
    }finally{state.apiBusy=false;}
  };
  const scheduleTelegramApiSync = (delay=100) => {
    if(state.apiBusy)return;
    if(state.apiRetryTimer)return;
    state.apiRetryTimer=setTimeout(()=>{state.apiRetryTimer=null;void syncTelegramApiHistory(!state.apiInitialComplete);},delay);
  };
  const processUnread = node => {
    const el=node?.nodeType===1?node:node?.parentElement;if(!el)return;
    const row=el.matches?.('.ListItem.Chat')?el:el.closest?.('.ListItem.Chat');
    if(row)captureUnreadPreview(row);
    for(const item of el.querySelectorAll?.('.ListItem.Chat')||[])captureUnreadPreview(item);
  };
  const bindUnread = () => {
    const root=document.querySelector('#LeftColumn');
    if(!root)return false;
    if(state.leftRoot===root&&state.leftObserver)return true;
    state.leftObserver?.disconnect?.();
    state.leftRoot=root;
    state.leftObserver=new MutationObserver(ms=>{for(const m of ms){if(m.type==='attributes'||m.type==='characterData')processUnread(m.target);else for(const n of m.addedNodes)processUnread(n);}});
    state.leftObserver.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','data-peer-id','title','aria-label']});
    processUnread(root);
    emitStatus('telegram-unread-preview-listener-installed',{rows:root.querySelectorAll('.ListItem.Chat').length});
    return true;
  };
  const selector='.Message.message-list-item[data-message-id]';
  const process=node=>{const el=node?.nodeType===1?node:node?.parentElement;if(!el)return;if(el.matches?.(selector))capture(el);const c=el.closest?.(selector);if(c)capture(c);for(const row of el.querySelectorAll?.(selector)||[])capture(row);};
  const findRoot=()=>document.querySelector('#MiddleColumn .MessageList,.MessageList,#MiddleColumn');
  const bind=()=>{const root=findRoot();if(!root)return false;if(state.root===root&&state.observer)return true;state.observer?.disconnect?.();state.root=root;state.observer=new MutationObserver(ms=>{for(const m of ms){if(m.type==='characterData'||m.type==='attributes')process(m.target);else for(const n of m.addedNodes)process(n);}});state.observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-message-id','class','datetime','title']});process(root);emitStatus('listener-installed',{service:'telegram',adapter:'telegram-web-a-message-row-only'});return true;};
  bind();
  bindUnread();
  scheduleTelegramApiSync(800);
  state.apiTimer=setInterval(()=>{void syncTelegramApiHistory(false);},30000);
  state.rootObserver=new MutationObserver(()=>{const current=findRoot();if(current&&current!==state.root)bind();const left=document.querySelector('#LeftColumn');if(left&&left!==state.leftRoot)bindUnread();});
  state.rootObserver.observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('beforeunload',()=>{state.observer?.disconnect?.();state.leftObserver?.disconnect?.();state.rootObserver?.disconnect?.();if(state.apiTimer)clearInterval(state.apiTimer);if(state.apiRetryTimer)clearTimeout(state.apiRetryTimer);try{state.apiChannel?.close?.();}catch{}},{once:true});
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
    apiTimer: null,
    apiRetryTimer: null,
    apiBusy: false,
    apiInitialComplete: false,
    selfUuid: '',
    selfIds: new Set(),
    knownTopMessageIds: new Map(),
    knownConversationActivity: new Map(),
    conversationTitles: new Map(),
  };
  window[marker] = state;

  const jsonParse = value => { try { return JSON.parse(value); } catch { return null; } };
  const b64uToBytes = value => {
    const s=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
    const padded=s+'='.repeat((4-s.length%4)%4);
    const bin=atob(padded); const out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i+=1)out[i]=bin.charCodeAt(i);
    return out;
  };
  const addSelfId = value => {
    const raw=clean(value).toLowerCase(); if(!raw)return;
    state.selfIds.add(raw);
    const uuid=raw.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)?.[0];
    if(uuid){state.selfIds.add(uuid);state.selfIds.add('8:orgid:'+uuid);state.selfIds.add('gid:'+uuid);if(!state.selfUuid)state.selfUuid=uuid;}
    if(!raw.includes(':')){state.selfIds.add('8:'+raw);state.selfIds.add('8:live:'+raw);state.selfIds.add('live:'+raw);}
  };
  const collectIdentityFields = value => {
    if(!value||typeof value!=='object')return;
    const keys=['mri','skypeid','skypeId','id','cid','userId','userMri','identity','sub'];
    for(const key of keys){const v=value[key];if(typeof v==='string')addSelfId(v);}
  };
  const decodeJwtPayload = token => {
    try{const parts=String(token||'').split('.');if(parts.length<2)return null;return jsonParse(new TextDecoder().decode(b64uToBytes(parts[1])));}catch{return null;}
  };
  const getCurrentUserUuid = () => {
    if(state.selfUuid)return state.selfUuid;
    const uuidRe=/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
    try{for(let i=0;i<localStorage.length;i+=1){const key=localStorage.key(i);const m=String(key||'').match(uuidRe);if(m){addSelfId(m[1]);break;}}}catch{}
    return state.selfUuid;
  };
  const activeConversationId = () => {
    const candidates=[];
    const self=getCurrentUserUuid();
    if(self)candidates.push('tmp.session.'+self+'-mainWindowNavHistory');
    try{for(let i=0;i<sessionStorage.length;i+=1){const key=sessionStorage.key(i);if(key&&key.endsWith('-mainWindowNavHistory')&&!candidates.includes(key))candidates.push(key);}}catch{}
    for(const histKey of candidates){
      try{
        const prefix=histKey.slice(0,-'mainWindowNavHistory'.length);
        const hist=JSON.parse(sessionStorage.getItem(histKey)||'[]');
        const index=JSON.parse(sessionStorage.getItem(prefix+'mainWindowNavHistoryIndex')||'{}');
        const i=typeof index?.windowHistoryIndex==='number'?index.windowHistoryIndex:0;
        const entry=hist?.[i]?.activeEntities?.mainEntity;
        if(entry?.action==='view'&&typeof entry?.id==='string')return clean(entry.id);
      }catch{}
    }
    return '';
  };
  const openDbRO = name => new Promise(resolve=>{try{const req=indexedDB.open(name);req.onsuccess=()=>resolve(req.result);req.onerror=()=>resolve(null);req.onblocked=()=>resolve(null);}catch{resolve(null);}});
  const readAllStore = (db,storeName) => new Promise(resolve=>{try{if(!db.objectStoreNames.contains(storeName)){resolve([]);return;}const tx=db.transaction(storeName,'readonly');const req=tx.objectStore(storeName).getAll();req.onsuccess=()=>resolve(Array.isArray(req.result)?req.result:[]);req.onerror=()=>resolve([]);}catch{resolve([]);}});
  const teamsDbNames = async prefix => {try{if(typeof indexedDB.databases!=='function')return [];const all=await indexedDB.databases();return all.filter(d=>d?.name?.startsWith('Teams:'+prefix+':')).map(d=>d.name).filter(Boolean).sort();}catch{return [];}};
  // Teams sends require-trusted-types-for 'script'. DOMParser.parseFromString
  // with text/html is a TrustedHTML sink in that document, so running the
  // API converter in Teams' page world throws before the message is captured.
  // Decode the small HTML subset needed by message capture without any HTML sink.
  const decodeHtmlEntities = value => String(value||'')
    .replace(/&#x([0-9a-f]+);/gi,(_m,h)=>{const n=parseInt(h,16);return Number.isFinite(n)&&n<=0x10ffff?String.fromCodePoint(n):_m;})
    .replace(/&#(\d+);/g,(_m,d)=>{const n=parseInt(d,10);return Number.isFinite(n)&&n<=0x10ffff?String.fromCodePoint(n):_m;})
    .replace(/&nbsp;|&#160;/gi,' ')
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&quot;/gi,'"').replace(/&apos;|&#39;/gi,"'")
    .replace(/&amp;/gi,'&');
  const htmlToPlainText = html => {
    const raw=clean(html); if(!raw)return '';
    if(!/[<>]/.test(raw))return decodeHtmlEntities(raw);
    let text=raw;
    text=text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ')
      .replace(/<br\b[^>]*\/?>/gi,'\n')
      .replace(/<\/(?:p|div|li|h[1-6]|tr|pre)\s*>/gi,'\n')
      .replace(/<li\b[^>]*>/gi,'• ')
      .replace(/<img\b[^>]*(?:alt|title)=["']([^"']*)["'][^>]*>/gi,(_m,label)=>' '+decodeHtmlEntities(label)+' ')
      .replace(/<[^>]+>/g,' ');
    return clean(decodeHtmlEntities(text)
      .replace(/[ \t]+/g,' ')
      .replace(/ *\n */g,'\n')
      .replace(/\n{3,}/g,'\n\n'));
  };
  const teamsConversationTitle = (conversationId, fallback='') => clean(state.conversationTitles.get(conversationId)||fallback||conversationId);
  // Teams' conversation-manager keeps 48:notes as the self-chat, while the
  // normal Chat Service /v1/users/ME/conversations/{id}/messages route is for
  // regular thread IDs.  Do not send 48:* pseudo/special IDs to that endpoint;
  // current/self-chat messages remain covered by the DOM/local collectors.
  const isTeamsChatServiceHistoryEligible = conversationId => {
    const id=clean(conversationId);
    return Boolean(id)&&!id.startsWith('48:');
  };
  const isTeamsSystemMessage = type => {
    const value=clean(type);
    return value.startsWith('ThreadActivity/')||value==='Event/Call'||value==='RichText/Media_CallRecording'||value==='RichText/Media_CallTranscript';
  };
  const isSelfSender = sender => {
    const value=clean(sender).toLowerCase(); if(!value)return false;
    for(const id of state.selfIds){
      if(!id)continue;
      if(value===id)return true;
      if(id.match(/^[a-f0-9]{8}-[a-f0-9-]{27,}$/)&&value.includes(id))return true;
      if(!id.includes(':')&&(value.endsWith(':'+id)||value.endsWith('/'+id)))return true;
    }
    return false;
  };
  const captureTeamsApiMessage = (raw,conversationId) => {
    const convId=clean(raw?.conversationid||raw?.conversationId||conversationId); if(!convId)return false;
    const type=clean(raw?.messagetype||raw?.messageType||raw?.contenttype||raw?.contentType||raw?.type);
    if(isTeamsSystemMessage(type))return false;
    const text=htmlToPlainText(raw?.content||raw?.body||raw?.text||''); if(!text)return false;
    const sentAt=timeValue(raw?.originalarrivaltime||raw?.originalArrivalTime||raw?.composetime||raw?.composeTime); if(!sentAt)return false;
    const senderId=clean(raw?.from||raw?.creator||raw?.senderId||raw?.senderid);
    const outgoing=isSelfSender(senderId);
    const messageId=clean(raw?.id||raw?.clientmessageid||raw?.clientMessageId||raw?.sequenceId||raw?.sequenceid)||'api-'+[convId,sentAt,senderId,text].join('\u001f');
    const senderName=clean(raw?.imdisplayname||raw?.imDisplayName||raw?.fromDisplayNameInToken||raw?.fromdisplaynameintoken||'');
    const accountId=[...state.selfIds][0]||state.selfUuid||'';
    const payload={accountId,conversationId:convId,conversationTitle:teamsConversationTitle(convId),messageId,senderId:outgoing?'':senderId,senderName:outgoing?'':senderName,direction:outgoing?'outgoing':'incoming',sentAt,timestampQuality:'provider',text,providerEvent:'teams-chat-service-api'};
    const fp=[convId,messageId,payload.direction,sentAt,text].join('\u001f'); const key=convId+'\u001f'+messageId;
    if(state.fingerprints.get(key)===fp)return false;
    state.fingerprints.set(key,fp); emit({kind:'message',payload}); return true;
  };
  const readTeamsConversations = async () => {
    const merged=new Map(); const names=await teamsDbNames('conversation-manager');
    for(const name of names){const db=await openDbRO(name);if(!db)continue;try{const rows=await readAllStore(db,'conversations');for(const row of rows){const id=clean(row?.id);if(!id)continue;if(id!=='48:notes'&&id.startsWith('48:'))continue;if(row?.threadProperties?.threadType==='streamofnotes'&&id!=='48:notes')continue;if(row?.threadProperties?.isDeleted===true)continue;const prev=merged.get(id);if(!prev||Number(row?.lastMessageTimeUtc||0)>Number(prev?.lastMessageTimeUtc||0))merged.set(id,row);const title=clean(row?.chatTitle?.shortTitle||row?.threadProperties?.topic||row?.lastMessage?.imdisplayname||row?.lastMessage?.fromDisplayNameInToken||'');if(title)state.conversationTitles.set(id,title);}}finally{try{db.close();}catch{}}}
    return [...merged.values()];
  };
  let msalBaseKeyCache=null;
  const getMsalBaseKey = async () => {
    try{
      const match=document.cookie.match(/msal\.cache\.encryption=([^;]+)/); if(!match)return null;
      const parsed=jsonParse(decodeURIComponent(match[1])); const raw=clean(parsed?.key); if(!raw)return null;
      if(msalBaseKeyCache?.raw===raw)return msalBaseKeyCache.key;
      const key=await crypto.subtle.importKey('raw',b64uToBytes(raw),'HKDF',false,['deriveKey']); msalBaseKeyCache={raw,key}; return key;
    }catch{return null;}
  };
  const decryptMsalEntry = async (keyName,entry) => {
    try{
      if(entry?.secret)return entry;
      if(!entry?.nonce||!entry?.data)return null;
      const base=await getMsalBaseKey(); if(!base)return null;
      const parts=String(keyName).split('|'); const context=parts[3]==='accesstoken'&&parts[4]?parts[4]:'';
      const derived=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:b64uToBytes(entry.nonce),info:new TextEncoder().encode(context)},base,{name:'AES-GCM',length:256},false,['decrypt']);
      const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)},derived,b64uToBytes(entry.data));
      return jsonParse(new TextDecoder().decode(decrypted));
    }catch{return null;}
  };
  const findMsalToken = async patterns => {
    const now=Math.floor(Date.now()/1000);
    try{for(let i=0;i<localStorage.length;i+=1){const key=localStorage.key(i);if(!key||!key.includes('accesstoken')||!patterns.some(p=>key.includes(p)))continue;const entry=jsonParse(localStorage.getItem(key)||'');const decoded=await decryptMsalEntry(key,entry);if(decoded?.secret&&(!decoded?.expiresOn||Number(decoded.expiresOn)>now)){collectIdentityFields(decodeJwtPayload(decoded.secret));const account=key.split('|')[1]||'';addSelfId(account.split('.')[0]);return decoded.secret;}}}catch{}
    return '';
  };
  let teamsFreeKeyCache=null;
  const getTeamsFreeAesKey = async () => {
    try{for(let i=0;i<localStorage.length;i+=1){const key=localStorage.key(i);if(!key||!key.endsWith('.ExportedEncryptionKey.ExportedEncryptionKey'))continue;const wrapper=jsonParse(localStorage.getItem(key)||'');const raw=clean(wrapper?.item?.exportedKey);if(!raw)continue;if(teamsFreeKeyCache?.raw===raw)return teamsFreeKeyCache.key;const cryptoKey=await crypto.subtle.importKey('raw',b64uToBytes(raw),{name:'AES-CBC'},false,['decrypt']);teamsFreeKeyCache={raw,key:cryptoKey};return cryptoKey;}}catch{}
    return null;
  };
  const decryptTeamsFreeItem = async item => {
    if(typeof item?.encryptedToken!=='string'||typeof item?.iv!=='string')return '';
    try{const key=await getTeamsFreeAesKey();if(!key)return '';const plain=await crypto.subtle.decrypt({name:'AES-CBC',iv:b64uToBytes(item.iv)},key,b64uToBytes(item.encryptedToken));return new TextDecoder().decode(plain);}catch{return '';}
  };
  const getTeamsFreeAuth = async () => {
    const now=Date.now();
    try{for(let i=0;i<localStorage.length;i+=1){const key=localStorage.key(i);if(!key||!key.endsWith('.Discover.SKYPE-TOKEN'))continue;const wrapper=jsonParse(localStorage.getItem(key)||'');const item=wrapper?.item;if(!item||typeof item!=='object'||Number(item.expiration||0)<=now)continue;const token=await decryptTeamsFreeItem(item);if(!token)continue;collectIdentityFields(item.userDetails);collectIdentityFields(decodeJwtPayload(token));let chatServiceUrl=clean(item?.regionGtms?.chatService);if(!chatServiceUrl||/msgapi\.teams\.live\.com/i.test(chatServiceUrl))chatServiceUrl='https://teams.live.com/api/chatsvc/consumer';return {token,chatServiceUrl,kind:'teams-free'};}}catch{}
    return null;
  };
  const readTeamsTmpDiscover = suffix => {
    try {
      for(let i=0;i<localStorage.length;i+=1){
        const key=localStorage.key(i);
        if(!key||!key.startsWith('tmp.auth.v1.')||!key.endsWith('.Discover.'+suffix))continue;
        const entry=jsonParse(localStorage.getItem(key)||'');
        if(entry?.item!=null)return entry.item;
      }
    } catch {}
    return null;
  };
  const teamsAuthzUrl = () => {
    const host=location.hostname.toLowerCase();
    if(host.includes('teams.microsoft.us'))return 'https://authsvc.teams.microsoft.us/v1.0/authz';
    if(host.includes('teams.live.com')){
      const cached=readTeamsTmpDiscover('SKYPE-AUTHZ-URL');
      return typeof cached==='string'&&cached?cached:'';
    }
    return 'https://authsvc.teams.microsoft.com/v1.0/authz';
  };
  const discoverTeamsWithSkypeToken = async skype => {
    const authz=teamsAuthzUrl(); if(!authz)return null;
    try{
      const response=await fetch(authz,{method:'POST',headers:{Authorization:'Bearer '+skype,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
      if(!response.ok)return null;
      const data=await response.json();
      let chatServiceUrl=clean(data?.regionGtms?.chatService);
      if(!chatServiceUrl)return null;
      const isFree=location.hostname.toLowerCase().includes('teams.live.com');
      if(isFree&&/msgapi\.teams\.live\.com/i.test(chatServiceUrl))chatServiceUrl='https://teams.live.com/api/chatsvc/consumer';
      let token=clean(data?.skypeToken?.skypetoken||data?.tokens?.skypeToken);
      if(!token&&!isFree)token=await findMsalToken(['ic3.teams.office.com','ic3.teams.office365.us','chatsvcagg']);
      if(!token)return null;
      collectIdentityFields(data?.skypeToken);
      collectIdentityFields(decodeJwtPayload(token));
      return {token,chatServiceUrl,kind:isFree?'teams-free':'work-school'};
    }catch{return null;}
  };
  const discoverTeamsAuth = async () => {
    const isFree=location.hostname.toLowerCase().includes('teams.live.com');
    if(isFree){const cached=await getTeamsFreeAuth();if(cached)return cached;}
    const skype=await findMsalToken(['spaces.skype']); if(!skype)return null;
    return discoverTeamsWithSkypeToken(skype);
  };
  const isAllowedTeamsApiUrl = value => {
    const suffixes = [
      'microsoft.com','microsoft.us','cloud.microsoft','teams.live.com','skype.com',
      'office.com','office365.com','office365.us','lync.com',
      'sharepoint.com','sharepoint.us','sharepoint-mil.us','sharepoint.cn',
    ];
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:') return false;
      const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
      return suffixes.some(suffix => host === suffix || host.endsWith('.' + suffix));
    } catch {
      return false;
    }
  };
  const teamsHeaders = (url,token) => /teams\.live\.com\/api\/chatsvc\/consumer\b/i.test(url)
    ? {'authentication':'skypetoken='+token,'behavioroverride':'redirectAs404','ms-ic3-product':'tfl','ms-ic3-additional-product':'Sfl','x-ms-request-priority':'0'}
    : {'Authorization':'Bearer '+token};
  const refreshTeamsMessagingAuth = async auth => {
    if (auth?.kind === 'teams-free') {
      const fresh = await getTeamsFreeAuth();
      if (fresh?.token) return {
        ...auth,
        token: fresh.token,
        chatServiceUrl: fresh.chatServiceUrl || auth.chatServiceUrl,
      };
      return auth;
    }
    const token = await findMsalToken(['ic3.teams.office.com','ic3.teams.office365.us','chatsvcagg']);
    return token ? { ...auth, token } : auth;
  };
  const fetchTeamsPage = async (url,auth) => {
    if(!isAllowedTeamsApiUrl(url))throw new Error('Blocked non-Microsoft Teams API URL');
    let networkRetries=0;
    let shortTimeoutNext=false;
    for(let attempt=0;attempt<=5;attempt+=1){
      const currentAuth=await refreshTeamsMessagingAuth(auth);
      const timeoutMs=shortTimeoutNext?12000:30000;
      shortTimeoutNext=false;
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      let response;
      try{
        const init={headers:teamsHeaders(url,currentAuth.token),signal:controller.signal};
        if(/teams\.live\.com\/api\/chatsvc\/consumer\b/i.test(url))init.credentials='include';
        response=await fetch(url,init);
      }catch(error){
        clearTimeout(timer);
        if(networkRetries<1&&attempt<5){
          networkRetries+=1;
          shortTimeoutNext=true;
          await new Promise(resolve=>setTimeout(resolve,2000));
          continue;
        }
        throw error;
      }
      clearTimeout(timer);

      if(response.status===429){
        if(attempt>=5)throw new Error('Teams messages API rate limited after retries');
        const retryAfter=Number(response.headers.get('Retry-After')||0)*1000;
        const backoff=Math.min(2000*Math.pow(2,attempt),30000);
        await new Promise(resolve=>setTimeout(resolve,Math.max(backoff,Number.isFinite(retryAfter)?retryAfter:0)));
        continue;
      }
      if(response.status===403||(response.status>=500&&response.status<600)){
        if(attempt>=2)throw new Error('Teams messages API '+response.status+' '+response.statusText);
        await new Promise(resolve=>setTimeout(resolve,[1000,2000,4000][attempt]||4000));
        continue;
      }
      if(!response.ok)throw new Error('Teams messages API '+response.status+' '+response.statusText);
      try{return await response.json();}catch{return {messages:[]};}
    }
    throw new Error('Teams messages API retry exhausted');
  };
  const fetchTeamsHistory = async (conversationId,auth,stopAtId='') => {
    const encoded=encodeURIComponent(conversationId);let nextUrl=auth.chatServiceUrl+'/v1/users/ME/conversations/'+encoded+'/messages?pageSize=200&startTime=1&view=msnp24Equivalent%7CsupportsMessageProperties';
    let pages=0,scanned=0,captured=0,reachedKnown=false,newestId='';let newestTs=0;const MAX_PAGES=500;
    while(nextUrl&&pages<MAX_PAGES){
      const data=await fetchTeamsPage(nextUrl,auth);pages+=1;const messages=Array.isArray(data?.messages)?data.messages:[];
      for(const raw of messages){
        const id=clean(raw?.id||raw?.clientmessageid||raw?.clientMessageId||raw?.sequenceId||raw?.sequenceid);if(stopAtId&&id===stopAtId)reachedKnown=true;
        const ts=timeValue(raw?.originalarrivaltime||raw?.originalArrivalTime||raw?.composetime||raw?.composeTime);if(ts>newestTs){newestTs=ts;newestId=id;}
        scanned+=1;if(captureTeamsApiMessage(raw,conversationId))captured+=1;
      }
      if(reachedKnown)break;
      nextUrl=clean(data?._metadata?.backwardLink);if(!nextUrl)break;
      await new Promise(resolve=>setTimeout(resolve,120));
    }
    return {pages,scanned,captured,reachedKnown,newestId,truncated:Boolean(nextUrl&&pages>=MAX_PAGES)};
  };
  const syncTeamsApiHistory = async initial => {
    if(state.apiBusy)return;state.apiBusy=true;
    let conversations=0,pages=0,scanned=0,captured=0,failed=0,truncated=false;
    try{
      const auth=await discoverTeamsAuth();if(!auth)throw new Error('Teams chat-service auth not ready');
      const rows=await readTeamsConversations();conversations=rows.length;
      for(const row of rows){
        const id=clean(row?.id);if(!id)continue;const activity=Number(row?.lastMessageTimeUtc||0);const knownActivity=Number(state.knownConversationActivity.get(id)||0);
        if(!initial&&knownActivity&&activity&&activity===knownActivity)continue;
        if(!isTeamsChatServiceHistoryEligible(id)){
          if(activity)state.knownConversationActivity.set(id,activity);
          emitStatus('teams-chat-service-special-conversation-local-only',{conversationId:id,reason:'48-prefix-not-supported-by-normal-chat-service-history-route'});
          continue;
        }
        const knownTop=initial?'':clean(state.knownTopMessageIds.get(id));
        try{const result=await fetchTeamsHistory(id,auth,knownTop);pages+=result.pages;scanned+=result.scanned;captured+=result.captured;truncated=truncated||result.truncated;if(result.newestId)state.knownTopMessageIds.set(id,result.newestId);if(activity)state.knownConversationActivity.set(id,activity);}catch(error){failed+=1;emitStatus('teams-chat-service-chat-error',{conversationId:id,message:clean(error?.message||error)});}
        await new Promise(resolve=>setTimeout(resolve,80));
      }
      state.apiInitialComplete=true;
      emitStatus(initial?'teams-chat-service-history-snapshot-complete':'teams-chat-service-history-incremental-complete',{conversations,pages,scanned,captured,failed,truncated,source:'Teams conversation-manager enumeration + Chat Service API backwardLink pagination'});
    }catch(error){emitStatus('teams-chat-service-history-error',{message:clean(error?.message||error),initial:Boolean(initial)});if(initial&&!state.apiRetryTimer){state.apiRetryTimer=setTimeout(()=>{state.apiRetryTimer=null;void syncTeamsApiHistory(true);},3000);}}
    finally{state.apiBusy=false;}
  };

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

  const normalizedTeamsTitle = value => clean(value).replace(/\s+/g,' ').toLocaleLowerCase();
  const directionOf = node => {
    for (const name of ['data-is-own','data-is-self','data-from-me','data-outgoing']) {
      if (clean(node.getAttribute?.(name)).toLowerCase() === 'true') return 'outgoing';
    }
    let cursor=node;
    for(let depth=0;cursor&&depth<6;depth+=1,cursor=cursor.parentElement){
      const marker=[cursor.className,cursor.getAttribute?.('data-tid'),cursor.getAttribute?.('data-testid'),cursor.getAttribute?.('aria-label')].map(v=>String(v||'')).join(' ');
      if(/(?:^|[\s_-])(own|outgoing|from.?me|self|sent)(?:[\s_-]|$)/i.test(marker)) return 'outgoing';
      if(/(?:^|[\s_-])(incoming|received)(?:[\s_-]|$)/i.test(marker)) return 'incoming';
    }
    const bubble=node.querySelector?.('[id^="message-body-"],[id^="content-"],[data-tid="message-content"],[data-tid="message-body"],[role="document"]')||node;
    try{
      const rect=bubble.getBoundingClientRect?.();
      const rootRect=(state.root||document.documentElement).getBoundingClientRect?.();
      if(rect&&rootRect&&rect.width>0&&rootRect.width>0){
        const delta=(rect.left+rect.width/2)-(rootRect.left+rootRect.width/2);
        if(delta>rootRect.width*0.08)return 'outgoing';
        if(delta<rootRect.width*-0.08)return 'incoming';
      }
    }catch{}
    return 'incoming';
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
    const renderedConversationTitle = clean(titleNode?.textContent);
    const providerConversationIdForTitle = activeConversationId();
    const conversationTitle = teamsConversationTitle(providerConversationIdForTitle, renderedConversationTitle);
    const deepLink = document.querySelector?.('a[href*="/l/chat/19:"],a[href*="/l/message/19:"]')?.getAttribute?.('href') || '';
    const deepMatch = String(deepLink).match(/\/l\/(?:chat|message)\/(19:[^/]+)/);
    const domChatId = clean(document.querySelector?.('[data-chat-id],[data-conversation-id]')?.getAttribute?.('data-chat-id') || document.querySelector?.('[data-chat-id],[data-conversation-id]')?.getAttribute?.('data-conversation-id'));
    // Teams can surface a deep-link id on some renders and only a DOM/title id on
    // others. Prefer one normalized title key when a title exists so the same chat
    // cannot split into multiple archive conversations across renders.
    const providerConversationId = activeConversationId();
    const conversationId = clean(providerConversationId || deepMatch?.[1] || domChatId || (conversationTitle ? 'teams-title:' + normalizedTeamsTitle(conversationTitle) : ''));
    if (!conversationId) return;
    const direction = directionOf(node);
    const outgoing = direction === 'outgoing';
    const payload = {
      conversationId,
      conversationTitle,
      messageId,
      senderId: outgoing ? '' : clean(node.getAttribute?.('data-author-id')),
      senderName: outgoing ? '' : senderName,
      direction,
      sentAt,
      timestampQuality: 'rendered-full',
      text,
      providerEvent: 'teams-web-current-dom-compat',
    };
    const fp = [conversationId,messageId || 'derived',senderName,payload.direction,sentAt,text].join('\u001f');
    const key = conversationId + '\u001f' + (messageId || fp);
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
  state.apiRetryTimer=setTimeout(()=>{state.apiRetryTimer=null;void syncTeamsApiHistory(true);},800);
  state.apiTimer=setInterval(()=>{void syncTeamsApiHistory(false);},30000);
  state.rootObserver = new MutationObserver(() => {
    if (!state.root?.isConnected) bind();
  });
  state.rootObserver.observe(document.documentElement, { childList:true, subtree:true });
  window.addEventListener('beforeunload', () => {
    state.observer?.disconnect?.();
    state.rootObserver?.disconnect?.();
    if (state.apiTimer) clearInterval(state.apiTimer);
    if (state.apiRetryTimer) clearTimeout(state.apiRetryTimer);
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
    // Do not archive the rendered-DOM copy. Signal's isolated preload cache reader
    // below provides the same real-time message with authoritative conversationId
    // and sender metadata, avoiding duplicate title-derived conversations.
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

const SIGNAL_HISTORY_PRIME_SCRIPT = String.raw`(async () => {
  const root = globalThis;
  const store = root.reduxStore;
  const controller = root.ConversationController;
  const actions = root.reduxActions?.conversations;
  if (!store?.getState || !controller?.get || !actions) {
    return { ok:false, reason:'Signal reduxStore/ConversationController/reduxActions unavailable', attempted:0, loaded:0, failed:0, pages:0, messages:[] };
  }

  const state = store.getState();
  const lookup = state?.conversations?.conversationLookup || {};
  const byServiceId = state?.conversations?.conversationsByServiceId || {};
  const byE164 = state?.conversations?.conversationsByE164 || {};
  // Signal itself treats ConversationController.getAll() as the authoritative
  // in-memory conversation collection. Redux conversationLookup can be a
  // presentation subset, so merge both and dedupe by conversation id.
  const conversationById = new Map();
  if (typeof controller.getAll === 'function') {
    for (const model of controller.getAll()) {
      const attrs = model?.attributes || model;
      const id = String(attrs?.id || model?.id || '');
      if (id) conversationById.set(id, attrs);
    }
  }
  for (const entry of Object.values(lookup)) {
    const id = String(entry?.id || '');
    if (id && !conversationById.has(id)) conversationById.set(id, entry);
  }
  const conversations = [...conversationById.values()]
    .filter(Boolean)
    .sort((a,b) => Number(b?.activeAt || b?.active_at || b?.timestamp || 0) - Number(a?.activeAt || a?.active_at || a?.timestamp || 0));

  const resolveConversation = value => {
    if (!value) return {};
    if (typeof value === 'object') return value;
    return lookup?.[value] || conversationById.get(String(value)) || {};
  };
  const resolveSenderName = msg => {
    const serviceId = String(msg?.sourceServiceId || '');
    const e164 = String(msg?.source || '');
    const serviceEntry = resolveConversation(byServiceId?.[serviceId]);
    const e164Entry = resolveConversation(byE164?.[e164]);
    const candidate = serviceEntry?.id ? serviceEntry : (e164Entry?.id ? e164Entry : {});
    return String(candidate?.title || candidate?.name || candidate?.profileName || candidate?.e164 || '').trim();
  };
  const conversationTitle = id => {
    const conversation = lookup?.[id] || conversationById.get(String(id)) || {};
    return String(conversation?.title || conversation?.name || conversation?.profileName || conversation?.e164 || id).trim();
  };
  const messageOrder = msg => {
    const received = Number(msg?.received_at_ms || msg?.received_at || 0);
    const sent = Number(msg?.sent_at || msg?.timestamp || 0);
    return received || sent || 0;
  };
  const oldestMessage = messages => {
    const valid = (Array.isArray(messages) ? messages : []).filter(msg => msg?.id);
    valid.sort((a,b) => messageOrder(a) - messageOrder(b));
    return valid[0];
  };
  const newestMessage = messages => {
    const valid = (Array.isArray(messages) ? messages : []).filter(msg => msg?.id);
    valid.sort((a,b) => messageOrder(b) - messageOrder(a));
    return valid[0];
  };
  const toPayload = (msg, fallbackConversationId) => {
    const conversationId = String(msg?.conversationId || fallbackConversationId || '');
    const messageId = String(msg?.id || '');
    const body = typeof msg?.body === 'string' ? msg.body.trim() : '';
    const direction = msg?.type === 'outgoing' ? 'outgoing' : (msg?.type === 'incoming' ? 'incoming' : '');
    const sentAt = Number(msg?.sent_at || msg?.timestamp || msg?.received_at_ms || msg?.received_at || 0);
    if (!conversationId || !messageId || !body || !direction || !sentAt) return null;
    const senderId = direction === 'outgoing' ? '' : String(msg?.sourceServiceId || msg?.source || '');
    return {
      conversationId,
      conversationTitle: conversationTitle(conversationId),
      messageId,
      senderId,
      senderName: direction === 'outgoing' ? '' : resolveSenderName(msg),
      direction,
      sentAt,
      timestampQuality: 'provider',
      text: body,
      providerEvent: 'signal-8.17.0-local-sql-history',
    };
  };

  const MAX_CONVERSATIONS = 10000;
  const MAX_PAGES_PER_CONVERSATION = 5000;
  const MAX_RETURNED_MESSAGES = 1000000;
  let attempted = 0;
  let loaded = 0;
  let failed = 0;
  let pages = 0;
  let truncated = false;
  const returnedById = new Map();
  const batches = [];

  const captureBatch = payload => {
    if (!payload || !Array.isArray(payload.messages)) return;
    const conversationId = String(payload.conversationId || '');
    if (!conversationId) return;
    batches.push({ conversationId, messages: payload.messages.slice() });
  };

  const originalAdded = actions.messagesAdded;
  const originalReset = actions.messagesReset;
  let wrappedAdded;
  let wrappedReset;
  let intercepted = false;

  if (typeof originalAdded === 'function' && typeof originalReset === 'function') {
    try {
      wrappedAdded = function(...args) {
        captureBatch(args[0]);
        return originalAdded.apply(actions, args);
      };
      wrappedReset = function(...args) {
        captureBatch(args[0]);
        return originalReset.apply(actions, args);
      };
      actions.messagesAdded = wrappedAdded;
      actions.messagesReset = wrappedReset;
      intercepted = actions.messagesAdded === wrappedAdded && actions.messagesReset === wrappedReset;
    } catch {}
  }

  const rememberMessages = (conversationId, messages) => {
    for (const msg of Array.isArray(messages) ? messages : []) {
      const payload = toPayload(msg, conversationId);
      if (!payload) continue;
      returnedById.set(payload.messageId, payload);
      if (returnedById.size >= MAX_RETURNED_MESSAGES) {
        truncated = true;
        break;
      }
    }
  };

  const interceptedSince = (cursor, conversationId) => {
    const out = [];
    for (let i = cursor; i < batches.length; i += 1) {
      const batch = batches[i];
      if (batch?.conversationId === conversationId) out.push(...(batch.messages || []));
    }
    return out;
  };

  const reduxMessages = conversationId => {
    const current = store.getState()?.conversations;
    const ids = current?.messagesByConversation?.[conversationId]?.messageIds;
    if (!Array.isArray(ids)) return [];
    return ids.map(id => current?.messagesLookup?.[id]).filter(Boolean);
  };

  try {
    for (const conversation of conversations.slice(0, MAX_CONVERSATIONS)) {
      if (returnedById.size >= MAX_RETURNED_MESSAGES) { truncated = true; break; }
      const id = String(conversation?.id || '');
      if (!id) continue;
      const model = controller.get(id);
      if (!model || typeof model.loadNewestMessages !== 'function') continue;
      attempted += 1;

      try {
        let cursor = batches.length;
        // Passing true forces a fresh local-SQL newest-page load even when this
        // conversation is the selected/preloaded one. Signal 8.17.0 otherwise
        // may consume the preload cache and skip the SQL read.
        await model.loadNewestMessages(undefined, true);

        // loadNewestMessages can route through loadAndScroll without awaiting it;
        // wait briefly for messagesReset to arrive before falling back to Redux.
        for (let wait = 0; wait < 80 && interceptedSince(cursor, id).length === 0; wait += 1) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }

        let firstPage = interceptedSince(cursor, id);
        if (!firstPage.length) firstPage = reduxMessages(id);
        rememberMessages(id, firstPage);
        loaded += 1;

        // Signal 8.17.0 loadNewestMessages() can intentionally center the
        // first page on metrics.oldestUnseen via loadAndScroll(). That page is
        // not necessarily the newest end of the conversation. Page toward the
        // newest end first, then page older, using Signal's own model methods.
        if (typeof model.loadNewerMessages === 'function') {
          let newest = newestMessage(firstPage);
          let lastNewestId = '';
          for (let page = 0; page < MAX_PAGES_PER_CONVERSATION && newest?.id; page += 1) {
            const newestId = String(newest.id || '');
            if (!newestId || newestId === lastNewestId) break;
            lastNewestId = newestId;
            cursor = batches.length;

            try {
              await model.loadNewerMessages(newestId);
            } catch {
              break;
            }
            pages += 1;

            const newer = interceptedSince(cursor, id);
            if (!newer.length) break;
            rememberMessages(id, newer);
            const nextNewest = newestMessage(newer);
            if (!nextNewest?.id || String(nextNewest.id) === newestId) break;
            newest = nextNewest;
            if (returnedById.size >= MAX_RETURNED_MESSAGES) { truncated = true; break; }
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        if (typeof model.loadOlderMessages === 'function') {
          let oldest = oldestMessage(firstPage);
          let lastOldestId = '';
          for (let page = 0; page < MAX_PAGES_PER_CONVERSATION && oldest?.id; page += 1) {
            const oldestId = String(oldest.id || '');
            if (!oldestId || oldestId === lastOldestId) break;
            lastOldestId = oldestId;
            cursor = batches.length;

            try {
              await model.loadOlderMessages(oldestId);
            } catch {
              break;
            }
            pages += 1;

            const older = interceptedSince(cursor, id);
            if (!older.length) break;
            rememberMessages(id, older);
            const nextOldest = oldestMessage(older);
            if (!nextOldest?.id || String(nextOldest.id) === oldestId) break;
            oldest = nextOldest;
            if (returnedById.size >= MAX_RETURNED_MESSAGES) { truncated = true; break; }
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      } catch (_error) {
        failed += 1;
      }

      if (returnedById.size >= MAX_RETURNED_MESSAGES) { truncated = true; break; }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    try {
      if (wrappedAdded && actions.messagesAdded === wrappedAdded) actions.messagesAdded = originalAdded;
      if (wrappedReset && actions.messagesReset === wrappedReset) actions.messagesReset = originalReset;
    } catch {}
  }

  if (conversations.length > MAX_CONVERSATIONS) truncated = true;
  const after = store.getState()?.conversations;
  return {
    ok:true,
    attempted,
    loaded,
    failed,
    pages,
    intercepted,
    messages:[...returnedById.values()],
    cachedConversations:Object.keys(after?.messagesByConversation || {}).length,
    cachedMessages:Object.keys(after?.messagesLookup || {}).length,
    truncated,
  };
})()`;

const SIGNAL_CACHE_SNAPSHOT_SCRIPT = String.raw`(() => {
  const state = globalThis.reduxStore?.getState?.();
  const conversationsState = state?.conversations;
  const lookup = conversationsState?.messagesLookup || {};
  const byConversation = conversationsState?.messagesByConversation || {};
  const conversationLookup = conversationsState?.conversationLookup || {};
  const byServiceId = conversationsState?.conversationsByServiceId || {};
  const byE164 = conversationsState?.conversationsByE164 || {};
  const result = [];
  const seen = new Set();
  const resolveConversation = value => {
    if (!value) return {};
    if (typeof value === 'object') return value;
    return conversationLookup?.[value] || {};
  };
  const resolveSenderName = msg => {
    const serviceId = String(msg?.sourceServiceId || '');
    const e164 = String(msg?.source || '');
    const serviceEntry = resolveConversation(byServiceId?.[serviceId]);
    const e164Entry = resolveConversation(byE164?.[e164]);
    const candidate = serviceEntry?.id ? serviceEntry : (e164Entry?.id ? e164Entry : {});
    return String(candidate?.title || candidate?.name || candidate?.profileName || candidate?.e164 || '').trim();
  };
  for (const [conversationId, bucket] of Object.entries(byConversation)) {
    const ids = Array.isArray(bucket?.messageIds) ? bucket.messageIds : [];
    const conversation = conversationLookup?.[conversationId] || {};
    const title = String(conversation?.title || conversation?.name || conversation?.profileName || conversation?.e164 || conversationId).trim();
    for (const id of ids) {
      const msg = lookup?.[id];
      const uniqueId = String(msg?.id || id || '');
      if (!msg || !uniqueId || seen.has(uniqueId)) continue;
      seen.add(uniqueId);
      const body = typeof msg.body === 'string' ? msg.body.trim() : '';
      const type = msg.type === 'outgoing' ? 'outgoing' : (msg.type === 'incoming' ? 'incoming' : '');
      const sentAt = Number(msg.sent_at || msg.timestamp || msg.received_at_ms || msg.received_at || 0);
      if (!body || !type || !sentAt) continue;
      const senderId = type === 'outgoing' ? '' : String(msg.sourceServiceId || msg.source || '');
      result.push({
        conversationId: String(msg.conversationId || conversationId || ''),
        conversationTitle: title,
        messageId: uniqueId,
        senderId,
        senderName: type === 'outgoing' ? '' : resolveSenderName(msg),
        direction: type,
        sentAt,
        timestampQuality: 'provider',
        text: body,
        providerEvent: 'signal-8.17.0-redux-cache-live',
      });
      if (result.length >= 1000000) break;
    }
    if (result.length >= 1000000) break;
  }
  return {
    messages: result,
    cachedConversations: Object.keys(byConversation).length,
    cachedMessages: Object.keys(lookup).length,
  };
})()`;

async function pollSignalCache(target: AttachedTarget): Promise<void> {
  if (target.service !== 'signal' || target.contents.isDestroyed() || target.signalCacheBusy) return;
  target.signalCacheBusy = true;
  try {
    if (!target.signalHistoryPrimed) {
      const primed = await target.contents.executeJavaScriptInIsolatedWorld(999, [
        { code: SIGNAL_HISTORY_PRIME_SCRIPT },
      ]) as { ok?: boolean; reason?: string; attempted?: number; loaded?: number; failed?: number; pages?: number; intercepted?: boolean; messages?: CapturedPayload[]; cachedConversations?: number; cachedMessages?: number; truncated?: boolean } | null;
      if (primed?.ok) {
        const primedMessages = Array.isArray(primed.messages) ? primed.messages : [];
        for (const message of primedMessages) recordMessage(target, message);
        target.signalHistoryPrimed = true;
        recordStatus(target, 'signal-local-history-primed', {
          attempted: Number(primed.attempted || 0),
          loaded: Number(primed.loaded || 0),
          failed: Number(primed.failed || 0),
          pages: Number(primed.pages || 0),
          returned: primedMessages.length,
          intercepted: Boolean(primed.intercepted),
          truncated: Boolean(primed.truncated),
          cachedConversations: Number(primed.cachedConversations || 0),
          cachedMessages: Number(primed.cachedMessages || 0),
          source: 'Signal 8.17.0 local SQL pages captured before Redux navigation filtering',
        });
      } else {
        recordStatus(target, 'signal-local-history-prime-waiting', {
          reason: clean(primed?.reason || 'Signal preload state not ready'),
        });
      }
    }
    const snapshot = await target.contents.executeJavaScriptInIsolatedWorld(999, [
      { code: SIGNAL_CACHE_SNAPSHOT_SCRIPT },
    ]) as { messages?: CapturedPayload[]; cachedConversations?: number; cachedMessages?: number } | null;
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    for (const message of messages) recordMessage(target, message);
    recordStatus(target, 'signal-redux-cache-snapshot', {
      returned: messages.length,
      cachedConversations: Number(snapshot?.cachedConversations || 0),
      cachedMessages: Number(snapshot?.cachedMessages || 0),
      source: 'Signal 8.17.0 Redux cache live/recent snapshot',
    });
  } catch (error) {
    recordStatus(target, 'signal-redux-cache-error', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    target.signalCacheBusy = false;
  }
}

function armSignalCachePolling(target: AttachedTarget): void {
  if (target.service !== 'signal' || target.signalCacheTimer || target.contents.isDestroyed()) return;
  void pollSignalCache(target);
  target.signalCacheTimer = setInterval(() => {
    void pollSignalCache(target);
  }, 3000);
}

function detach(contents: WebContents): void {
  const target = targets.get(contents.id);
  if (target?.retryTimer) clearTimeout(target.retryTimer);
  if (target?.signalCacheTimer) clearInterval(target.signalCacheTimer);
  stopLiveMessageTranslation(contents.id);
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
          signalCacheTimer: null,
          signalCacheBusy: false,
          signalHistoryPrimed: false,
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
        signalCacheTimer: null,
        signalCacheBusy: false,
        signalHistoryPrimed: false,
      };
      targets.set(contents.id, target);
      recordStatus(target, 'target-attached', {
        reason,
        webContentsType: contents.getType(),
      });
    } else {
      target.url = url;
    }
    flushPendingConsoleEnvelopes(target);
    armLiveMessageTranslation(target.service, target.contents);
    if (target.service === 'signal') armSignalCachePolling(target);
    if (shouldInject) void inject(target, reason);
  };

  (contents as any).on(
    'console-message',
    (_event: unknown, ...arguments_: unknown[]) => {
      const message = extractConsoleEnvelope(arguments_);
      if (!message) return;

      let target = targets.get(contents.id);
      if (!target) {
        // A guest can emit its first bridge payload in the same turn in which
        // the service navigation becomes visible. Resolve the target now instead
        // of dropping the first real message/status line.
        tryAttach('console-message', false);
        target = targets.get(contents.id);
      }
      if (target) parseConsoleMessage(target, message);
      else queuePendingConsoleEnvelope(contents.id, message);
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
        if (target.service === 'signal') target.signalHistoryPrimed = false;
      }
    },
  );
  contents.on('dom-ready', () => tryAttach('dom-ready', true));
  contents.on('did-finish-load', () => tryAttach('did-finish-load', true));
  contents.on('did-navigate', () => tryAttach('did-navigate', false));
  contents.on('did-navigate-in-page', () => tryAttach('did-navigate-in-page', false));
  contents.once('destroyed', () => {
    if (instanceRetryTimer) clearTimeout(instanceRetryTimer);
    pendingConsoleEnvelopes.delete(contents.id);
    hookedContents.delete(contents.id);
    detach(contents);
  });
  tryAttach('existing', true);
}

export default function registerUnifiedMessageRecognition(): void {
  if (started) return;
  started = true;
  app.on('web-contents-created', (_event, contents) => attach(contents));
  const beginRecognitionRun = () => {
    writeCurrentRunMarker();
    for (const contents of webContents.getAllWebContents()) attach(contents);
  };
  if (app.isReady()) beginRecognitionRun();
  else app.once('ready', beginRecognitionRun);
  debug('RP01 source-backed real-message recognition v6 registered (Signal/WhatsApp/Telegram/Teams)');
}
