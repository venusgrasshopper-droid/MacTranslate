import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const VERSION = '4.4.2';
const PACKAGE = '@wppconnect/wa-js';
const EXPECTED_BYTES = 503710;
const EXPECTED_SHA256 = '967209a61b8d2e218965e0a7ec168d8b96cf38eb31749ce0cd7ec9e91e806514';
const sourceRoot = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const vendorPath = path.join(sourceRoot, 'vendor', 'message-recognition', 'wppconnect-wa-4.4.2.js');
const outputDir = path.join(sourceRoot, 'src', 'electron', 'message-recognition');
const outputTs = path.join(outputDir, 'WajsBundle.ts');
const notice = path.join(outputDir, 'WAJS_NOTICE.txt');
const sha256 = data => createHash('sha256').update(data).digest('hex');

const bundle = readFileSync(vendorPath);
const digest = sha256(bundle);
if (bundle.length !== EXPECTED_BYTES || digest !== EXPECTED_SHA256) {
  throw new Error(`Vendored WA-JS 4.4.2 integrity mismatch: bytes=${bundle.length} sha256=${digest}`);
}
mkdirSync(outputDir, { recursive: true });
const base64 = bundle.toString('base64');
writeFileSync(outputTs, [
  "import { Buffer } from 'node:buffer';",
  `const WAJS_BUNDLE = Buffer.from('${base64}', 'base64').toString('utf8');`,
  'export default WAJS_BUNDLE;',
  '',
].join('\n'));
writeFileSync(notice, [
  `package=${PACKAGE}`,
  `version=${VERSION}`,
  `repository=https://github.com/wppconnect-team/wa-js`,
  `release=https://github.com/wppconnect-team/wa-js/releases/tag/v4.4.2`,
  `license=Apache-2.0`,
  `bundleBytes=${bundle.length}`,
  `bundleSha256=${digest}`,
  `vendorSource=exact WA-JS 4.4.2 bundle already embedded in RP01 TranGPT runtime`,
  '',
].join('\n'));
console.log(`WAJS_VENDORED_BRIDGE_OK version=${VERSION} bytes=${bundle.length} sha256=${digest}`);
