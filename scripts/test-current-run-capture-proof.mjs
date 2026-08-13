#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mactranslate-current-run-'));
const data = path.join(tmp, 'MessageRecognitionV6');
fs.mkdirSync(data, { recursive: true });
const runId = 'current-run-harness';
const now = Date.now();

const runFile = path.join(data, 'current-run.json');
const logFile = path.join(data, 'messages.jsonl');
fs.writeFileSync(runFile, JSON.stringify({ recognitionRunId: runId, startedAt: now, pid: process.pid, appVersion: 'test' }) + '\n');

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readJsonl = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };
const evaluate = () => {
  const run = readJson(runFile);
  if (!run?.recognitionRunId) return { status: 2, output: 'CURRENT_BUILD_NOT_RUNNING' };
  const rows = readJsonl(logFile).filter(row => row.recognitionRunId === run.recognitionRunId);
  const lines = [];
  let all = true;
  for (const service of ['whatsapp', 'telegram', 'signal', 'teams']) {
    const count = rows.filter(row => row.service === service).length;
    if (!count) all = false;
    lines.push(`${service.padEnd(8)} ${count > 0 ? 'CURRENT BUILD PASS' : 'NOT PASSED'}  ${count}`);
  }
  lines.push(`TOTAL    ${rows.length} current-run real messages`);
  return { status: all ? 0 : 1, output: lines.join('\n') };
};

try {
  const oldRows = ['whatsapp','telegram','signal','teams'].map(service => JSON.stringify({ recognitionRunId:'old-run', service, observedAt:now }));
  fs.writeFileSync(logFile, oldRows.join('\n') + '\n');
  const oldOnly = evaluate();
  if (oldOnly.status !== 1 || !oldOnly.output.includes('whatsapp NOT PASSED') || oldOnly.output.includes('CURRENT BUILD PASS')) {
    throw new Error('historical rows incorrectly counted as current build PASS');
  }

  const currentRows = ['whatsapp','telegram','signal','teams'].map(service => JSON.stringify({ recognitionRunId:runId, service, observedAt:now }));
  fs.appendFileSync(logFile, currentRows.join('\n') + '\n');
  const current = evaluate();
  if (current.status !== 0) throw new Error('current-run rows did not pass');
  for (const service of ['whatsapp','telegram','signal','teams']) {
    if (!current.output.includes(`${service.padEnd(8)} CURRENT BUILD PASS`)) throw new Error(`${service} missing CURRENT BUILD PASS`);
  }
  if (!current.output.includes('TOTAL    4 current-run real messages')) throw new Error('current-run count mismatch');
  console.log('CURRENT_RUN_CAPTURE_PROOF_HARNESS_OK');
  console.log('historical-rows-ignored/current-run-only/in-process=PASS');
} finally {
  fs.rmSync(tmp, { recursive:true, force:true });
}
