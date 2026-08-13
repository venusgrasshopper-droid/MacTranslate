#!/usr/bin/env node
// Legacy entry point retained for compatibility. The old v6 verifier checked
// obsolete WPP/unread-preview/body-fallback architecture and produced false FAILs.
// Current architecture authority is verify-message-recognition-v72.mjs.
await import('./verify-message-recognition-v72.mjs');
console.log('MESSAGE_RECOGNITION_V6_COMPAT_CHECK_OK -> current v72 architecture verifier');
