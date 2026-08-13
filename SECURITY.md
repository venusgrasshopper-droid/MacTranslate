# Security Policy

## Supported versions

The actively maintained public line is MacTranslate **v12.4.x**. Security fixes are applied to the current public baseline rather than to historical development snapshots.

## Reporting a vulnerability

Please **do not** publish exploit details, credentials, private chat data, session material, access tokens, or proof-of-concept payloads in a public issue.

Preferred reporting path:

1. Use GitHub's **Private vulnerability reporting** for `venusgrasshopper-droid/MacTranslate` when it is available.
2. If private vulnerability reporting is unavailable, open a minimal public issue titled **Security contact request** without technical exploit details or sensitive data. The maintainer will move the discussion to a private channel before requesting reproduction material.

Primary maintainer: `@venusgrasshopper-droid`.

## High-risk areas

Reports are especially useful when they involve:

- Electron preload or IPC trust boundaries;
- remote webview content escaping into local capabilities;
- filesystem/archive access outside the intended data directory;
- credential or session-data exposure;
- unauthorized network requests or WebSocket manipulation;
- command execution or unsafe shell/build-script behavior;
- service recipe injection;
- dependency, vendored-runtime or native-module supply-chain issues.

A good report should include the affected commit/version, entry point, expected trust boundary, reproduction steps, observed impact and a minimal non-sensitive proof of concept when possible.

## Upstream vulnerabilities

MacTranslate contains and integrates upstream components including Ferdium/Electron, `@wppconnect/wa-js`, Signal-related runtime components and service-specific web applications. If a vulnerability is confirmed to originate entirely in an upstream project, the report may also need coordinated disclosure to that upstream maintainer. Please report it to MacTranslate first when the issue depends on MacTranslate's integration or local trust boundaries.
