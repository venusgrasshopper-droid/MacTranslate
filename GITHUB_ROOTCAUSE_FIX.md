# GitHub root-cause fixes

- WhatsApp: Electron v38.1.0 maps Blink DURABLE_STORAGE to `persistent-storage`; MacTranslate previously denied it. The fix grants that permission only to `web.whatsapp.com` in both request and check handlers.
- Telegram Web A: uses IndexedDB `tt-data` / store `store` / key `tt-shared-state`; official settings `shouldAllowHttpTransport` and `shouldForceHttpTransport` are read before `initApi`. The fix persists those official flags from preload before Telegram bootstrap, instead of mutating Workers or waiting for `dom-ready`.
- Teams: teams-for-linux documents the same unrelated `Unhandled error/rejection {"isTrusted": true}` from Teams own global handler. The fix installs an early Main World handler before page scripts and consumes only a bare trusted DOM Event rejection; console methods are not patched.
- Trusted Types: style injection uses `textContent`, not `innerHTML`.
- Signal and Electron 38.1.0 remain frozen.
