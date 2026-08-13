# MacTranslate

MacTranslate is an open-source macOS desktop client for multi-account communication workflows. It is built on the Ferdium/Electron codebase and adds project-specific integrations for Telegram, Signal, WhatsApp and Microsoft Teams, with a focus on translation, real-message recognition and local text-message archiving.

## Current public baseline

- MacTranslate: **v12.4.3**
- Maintenance snapshot: **STABLE-UPSTREAM-CAPTURE-R16** (2026-08-13)
- Ferdium base: **v7.1.3-nightly.3**
- Electron: **38.1.0**
- Primary platform: **macOS / Apple Silicon**

R16 advances the capture/diagnostic line beyond the initial public snapshot. It includes live Telegram transport-state handling around the `tt-global` BroadcastChannel, runtime/HTTP status verification, persistence checks, and expanded service-specific regression tests.

## Project-specific work

MacTranslate extends the desktop host with:

- multi-account service isolation and switching;
- Telegram client workflow plus translation display controls and shortcut support;
- a unified message-recognition layer for Telegram, WhatsApp, Signal and Microsoft Teams;
- local archival of real text messages with service, account, conversation, direction, sender, original text, timestamp and source/message IDs when available;
- media-only message filtering so non-text media is not archived as text;
- an embedded Signal runtime host with isolated Electron sessions/partitions and account synchronization;
- WhatsApp integration based on pinned `@wppconnect/wa-js` APIs, with history/live-message handling and an Electron IPC archive bridge;
- diagnostic and verification tooling for service-specific transport, runtime and capture failures.

## Validation approach

Real-account runtime behavior is the acceptance criterion for message capture. Listener installation, synthetic events, and mock-only tests are not treated as proof that archival works.

The repository also contains deterministic regression tests and verification scripts so changes to Electron IPC, webview transport, service recipes, archive persistence and vendored runtimes can be reviewed before real-account validation.

## Security model

MacTranslate has a larger attack surface than a normal desktop UI because it loads remote messaging applications inside Electron and connects them to local application capabilities. Security-sensitive boundaries include:

- remote page content and webviews;
- preload scripts and Electron IPC;
- filesystem-backed local archives;
- network and WebSocket transport;
- third-party service recipes;
- vendored and pinned runtime dependencies;
- native modules and build scripts;
- third-party contributions.

A compromised service page, dependency, recipe or contribution could attempt credential exfiltration, unauthorized network access, unsafe IPC calls, local file access, command execution or supply-chain modification. Security review therefore focuses on boundary validation, dependency provenance, least privilege and reproducible verification.

No personal account database, chat archive, local log, authentication state, API key or user credential is intentionally committed to this repository.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Upstream and third-party attribution

MacTranslate is derived from Ferdium and retains the Apache-2.0 license and upstream attribution for Ferdium-derived source. The current base corresponds to Ferdium `v7.1.3-nightly.3`. The original upstream README is retained as [README_UPSTREAM_FERDIUM.md](README_UPSTREAM_FERDIUM.md).

WhatsApp integration uses `@wppconnect/wa-js` and retains its upstream license/provenance. Embedded Signal-related components have separate source/provenance requirements; see `SIGNAL_AGPL_NOTICE.md` and related verification documentation where applicable.

MacTranslate is not affiliated with Telegram, Signal, WhatsApp/Meta, Microsoft or Ferdium.

## Contributing

Bug reports and narrowly scoped pull requests are welcome. For security-sensitive changes—especially Electron preload/IPC, service recipes, archive handling, network code, dependency updates or scripts that execute commands—include the threat model and validation steps in the pull request.

Do not submit real credentials, private chat data, session databases or account exports in issues or pull requests.

## License

Ferdium-derived code is distributed under Apache-2.0 subject to its original notices. Third-party components remain under their respective licenses; see repository notices for details.
