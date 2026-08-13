#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const targets = [path.join(root, 'RUN_ALL.command'), path.join(root, 'scripts')];
const forbidden = [
  /\/opt\/nvm\/versions\/node\/v\d+\.\d+\.\d+\/lib\/node_modules/g,
  /\/home\/oai\//g,
  /\/mnt\/data\//g,
];
const failures = [];
const walk = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    return;
  }
  if (!/\.(?:mjs|cjs|js|command|sh)$/.test(p) && path.basename(p) !== 'RUN_ALL.command') return;
  const text = fs.readFileSync(p, 'utf8');
  for (const re of forbidden) {
    re.lastIndex = 0;
    if (re.test(text)) failures.push(`${path.relative(root,p)} contains ${re}`);
  }
};
for (const p of targets) walk(p);
if (failures.length) {
  console.error('PORTABLE_BUILD_PATHS_FAILED');
  failures.forEach((x) => console.error(`- ${x}`));
  process.exit(1);
}
console.log('PORTABLE_BUILD_PATHS_OK');
