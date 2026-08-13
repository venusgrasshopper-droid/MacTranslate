#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const defaultDir = path.join(os.homedir(), 'Library', 'Application Support', 'MacTranslate', 'MessageRecognitionV6');
const dataDir = path.resolve(process.argv[2] || defaultDir);
const runFile = path.join(dataDir, 'current-run.json');
const logFile = path.join(dataDir, 'messages.jsonl');

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readJsonl = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } };

const run = readJson(runFile);
if (!run?.recognitionRunId) {
  console.error('CURRENT_BUILD_NOT_RUNNING: current-run.json missing or invalid');
  process.exit(2);
}
if (process.argv[3] !== '--skip-pid-check') {
  try { process.kill(Number(run.pid), 0); }
  catch {
    console.error(`CURRENT_BUILD_NOT_RUNNING: PID ${run.pid ?? '<missing>'} is not alive`);
    process.exit(2);
  }
}

const rows = readJsonl(logFile).filter(row => row.recognitionRunId === run.recognitionRunId);
console.log(`RUN_ID   ${run.recognitionRunId}`);
console.log(`STARTED  ${new Date(run.startedAt).toISOString()}`);
console.log(`VERSION  ${run.appVersion || 'unknown'}`);
let all = true;
for (const service of ['whatsapp', 'telegram', 'signal', 'teams']) {
  const serviceRows = rows.filter(row => row.service === service);
  const count = serviceRows.length;
  if (!count) all = false;
  const last = serviceRows.at(-1);
  console.log(`${service.padEnd(8)} ${count > 0 ? 'CURRENT BUILD PASS' : 'NOT PASSED'}  ${count}${last ? `  last=${new Date(last.observedAt).toISOString()}` : ''}`);
}
console.log(`TOTAL    ${rows.length} current-run real messages`);
process.exit(all ? 0 : 1);
