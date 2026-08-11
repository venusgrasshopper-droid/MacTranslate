#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [, , asarPath, destination] = process.argv;
if (!asarPath || !destination) {
  console.error('Usage: node scripts/extract-asar.mjs <app.asar> <destination>');
  process.exit(1);
}

const source = fs.openSync(asarPath, 'r');
const prefix = Buffer.alloc(16);
fs.readSync(source, prefix, 0, prefix.length, 0);
const headerSize = prefix.readUInt32LE(4);
const jsonSize = prefix.readUInt32LE(12);
const headerBuffer = Buffer.alloc(jsonSize);
fs.readSync(source, headerBuffer, 0, jsonSize, 16);
const header = JSON.parse(headerBuffer.toString('utf8'));
const dataOffset = 8 + headerSize;

const copyFile = (entry, relativePath) => {
  if (entry.unpacked) {
    return;
  }

  const target = path.join(destination, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (entry.link) {
    try {
      fs.symlinkSync(entry.link, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return;
  }

  const size = Number(entry.size ?? 0);
  const offset = dataOffset + Number(entry.offset ?? 0);
  const output = fs.openSync(target, 'w');
  try {
    const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(size, 1)));
    let copied = 0;
    while (copied < size) {
      const length = Math.min(chunk.length, size - copied);
      const read = fs.readSync(source, chunk, 0, length, offset + copied);
      if (read !== length) {
        throw new Error(`Unexpected EOF while extracting ${relativePath}`);
      }
      fs.writeSync(output, chunk, 0, read);
      copied += read;
    }
  } finally {
    fs.closeSync(output);
  }

  if (entry.executable) {
    fs.chmodSync(target, 0o755);
  }
};

const walk = (node, prefixPath = '') => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const relativePath = prefixPath ? `${prefixPath}/${name}` : name;
    if (entry.files) {
      walk(entry, relativePath);
    } else {
      copyFile(entry, relativePath);
    }
  }
};

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
try {
  walk(header);
} finally {
  fs.closeSync(source);
}

console.log(`Extracted ${asarPath} to ${destination}`);
