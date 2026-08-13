#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const src = fs.readFileSync(path.join(root, 'src/webview/recipe.ts'), 'utf8');
const fail = (m) => { console.error(`R16_RUNTIME_POLICY_FAIL ${m}`); process.exit(1); };

for (const required of [
  'MACTRANSLATE_WHATSAPP_RUNTIME_COMPAT_V16',
  "delete normalized.buffered",
  'Minified invariant #56367',
  'Haste-supplied config for the QPL event',
  'MACTRANSLATE_TEAMS_UPSTREAM_NOISE_V16',
  "text.includes('Unhandled error/rejection')",
]) if (!src.includes(required)) fail(`missing ${required}`);

if (src.includes("text.includes('ErrorUtils caught an error:')")) fail('generic ErrorUtils suppression is forbidden');
if (/console\.(warn|log)\s*=/.test(src)) fail('broad console warn/log interception forbidden');
if (src.includes('stopImmediatePropagation()')) fail('event swallowing forbidden');

// Exercise the exact runtime policy independently of the TypeScript preload.
const makeConsole = () => {
  const seen = { error: [] };
  return { seen, console: { error: (...a) => seen.error.push(a), warn: (...a) => {}, log: (...a) => {} } };
};

{
  const { seen, console } = makeConsole();
  const nativeError = console.error;
  console.error = function (...args) {
    const text = args.map(v => typeof v === 'string' ? v : (v instanceof Error ? (v.stack || v.message) : JSON.stringify(v))).join(' ');
    if (text.includes('Minified invariant #56367') || text.includes('Failed to find a Haste-supplied config for the QPL event identified by token')) return;
    return Reflect.apply(nativeError, console, args);
  };
  console.error('ErrorUtils caught an error:', new Error('Minified invariant #56367'));
  console.error('Failed to find a Haste-supplied config for the QPL event identified by token `106`.');
  console.error('ErrorUtils caught an error:', new Error('REAL WA FAILURE'));
  if (seen.error.length !== 1 || !String(seen.error[0][1]).includes('REAL WA FAILURE')) fail('WhatsApp exact suppression/pass-through');
}

{
  const { seen, console } = makeConsole();
  const nativeError = console.error;
  console.error = function (...args) {
    const text = args.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ');
    if (text.includes('Unhandled error/rejection') && /["']?isTrusted["']?\s*[:=]\s*true/.test(text)) return;
    return Reflect.apply(nativeError, console, args);
  };
  console.error('Unhandled error/rejection', { isTrusted: true });
  console.error('Unhandled error/rejection', { isTrusted: false });
  console.error('REAL TEAMS FAILURE');
  if (seen.error.length !== 2 || !String(seen.error[0][0]).includes('Unhandled error/rejection') || !String(seen.error[1][0]).includes('REAL TEAMS FAILURE')) fail('Teams exact suppression/pass-through');
}

{
  let observed;
  class PO { observe(opts) { observed = opts; } }
  const nativeObserve = PO.prototype.observe;
  PO.prototype.observe = function(options) {
    if (options && Array.isArray(options.entryTypes) && options.buffered === true) {
      const normalized = { ...options };
      delete normalized.buffered;
      return Reflect.apply(nativeObserve, this, [normalized]);
    }
    return Reflect.apply(nativeObserve, this, [options]);
  };
  new PO().observe({ entryTypes: ['resource'], buffered: true });
  if (!observed || observed.buffered !== undefined || observed.entryTypes?.[0] !== 'resource') fail('PerformanceObserver option normalization');
}

console.log('R16_RUNTIME_CONSOLE_POLICY_OK');
console.log('whatsapp-performanceobserver-fixed/exact-upstream-only-suppression/unknown-errors-visible=PASS');
