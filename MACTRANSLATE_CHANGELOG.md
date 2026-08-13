# MacTranslate maintenance changelog

This file tracks MacTranslate-specific public maintenance milestones. Upstream Ferdium history remains in `CHANGELOG.md` and `README_UPSTREAM_FERDIUM.md`.

## 2026-08-13 — STABLE-UPSTREAM-CAPTURE-R16

- Advanced the public source baseline from the initial root-cause-fix snapshot to the R16 capture/diagnostic line.
- Added Telegram live-state handling around the `tt-global` BroadcastChannel and associated runtime verification.
- Added R16 wrapper-only HTTP-status and runtime console-policy regression tests.
- Expanded capture persistence/current-run proof checks.
- Expanded WhatsApp history/provider/resident-history regression coverage, including LID-related history checks.
- Added/updated Teams warning verification and portable build-path verification.
- Kept Ferdium, Electron and WA-JS dependency pins unchanged to avoid an unrelated major dependency migration during this maintenance update.

## 2026-08-11 — Initial public release

- Published the first sanitized MacTranslate source snapshot.
- Added project-specific README, upstream attribution and security-boundary documentation.
