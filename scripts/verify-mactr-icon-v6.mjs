#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const failures = [];
const iconPath = path.join(root, 'build-helpers/images/icon.icns');
const iconPngPath = path.join(root, 'branding/MacTranslate-MacTr-native-macOS-icon-fix/MacTranslate-MacTr-1024.png');
if (!fs.existsSync(iconPath) || fs.statSync(iconPath).size < 100000) failures.push('MacTr build icon.icns missing/invalid');
if (!fs.existsSync(iconPngPath) || fs.statSync(iconPngPath).size < 100000) failures.push('MacTr 1024 PNG missing');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expectedPng = 'd01b08f5ed4f4b02fb614e5b8eb0cb8af3a6a480ba376b4ecd5fd16a622667d4';
if (fs.existsSync(iconPngPath) && sha(iconPngPath) !== expectedPng) failures.push('MacTr PNG hash mismatch');
if (failures.length) { console.error('MACTR_ICON_CHECK_FAILED'); failures.forEach(x=>console.error(`- ${x}`)); process.exit(1); }
console.log('MACTR_ICON_CHECK_OK');
console.log(`MacTr PNG SHA256=${sha(iconPngPath)}`);
console.log(`MacTr ICNS SHA256=${sha(iconPath)}`);
