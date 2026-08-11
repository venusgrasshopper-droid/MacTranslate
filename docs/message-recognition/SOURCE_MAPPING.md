# MacTranslate real-message recognition v6 — source mapping

Runtime success is only a real row in `MessageRecognitionV6/messages.jsonl`. Listener/ready states are diagnostics only.

## WhatsApp — WA-JS 4.4.2
- Upstream: https://github.com/wppconnect-team/wa-js
- Pinned bundle SHA256: `967209a61b8d2e218965e0a7ec168d8b96cf38eb31749ce0cd7ec9e91e806514`
- The exact 4.4.2 bundle forwards internal `chat.new_message` into the public event bus and exports root `WPP.on`; public docs also expose `WPP.chat.on`.
- V6 waits for `WPP.loader.onReady()`, installs `chat.new_message` on root `WPP.on` when available and falls back to `WPP.chat.on`. A transient `WPP.conn.isAuthenticated() === false` is diagnostic only and no longer permanently aborts installation.

## Telegram Web A
- Upstream: https://github.com/Ajaxy/telegram-tt
- `Message.tsx`: rendered rows are `Message message-list-item`, outgoing adds `own`, and provider message ID is `data-message-id`.
- `MessageMeta.tsx`: displayed time derives from `message.date * 1000`; full date `title` is created after hover/focus activation.
- `Chat.tsx` + `useChatListEntry.tsx`: chat row is `Chat chat-item-clickable`, subtitle contains `.last-message-summary` and optional `.sender-name`; `ChatBadge` is rendered in the subtitle.
- V6 preserves the already-working `.Message.message-list-item[data-message-id]` + `.text-content` extraction and `own` direction mapping. It rejects fractional optimistic IDs such as `81.000001`, activates the full message date before archiving historical rows, and separately captures unread-chat preview text. Preview timestamps are explicitly tagged `observed-preview`; they are not mislabeled as provider message time.

## Signal Desktop 8.17.0 — exact frozen runtime
The RP01 vendored `vendor/signal-runtime/bundles/preload/main.js` proves:
- timeline wrappers: `data-message-id=<message.id>` with `role=listitem`;
- message body: `.module-message__text`;
- direction: `.module-message--incoming` / `.module-message--outgoing`;
- `Message.render()` passes `timestamp` into `.module-message[data-testid]`;
- selected conversation title: `.module-ConversationHeader__header__info__title`;
- timeline root: `.module-timeline__messages__container` / `.module-timeline__messages`.
V6 reads only these rendered structures. It does not depend on inaccessible `window.MessageCache`/`ConversationController`. Signal preload/host/session/partition are untouched.

## Microsoft Teams — current DOM compatibility
Microsoft does not publish the complete Teams Web client source, so V6 does not claim an official internal message API. Current public GitHub Teams exporters use `data-tid="chat-pane-message"`/`data-mid`, `#author-<mid>`, `#timestamp-<mid>[datetime]`, `[id^="content-"]`, plus newer `message-list-item`/`message-group-container`/role=listitem variants. V6 follows those structures, observes the detected message root with a safe `document.body` fallback, and refuses to invent a historical time when no parseable Teams time is rendered.

## Acceptance
PASS requires at least one real normalized row per service. Static/source checks do not count as real-account success.
