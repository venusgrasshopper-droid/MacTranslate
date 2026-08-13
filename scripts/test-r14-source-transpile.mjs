#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const root=path.resolve(process.argv[2]||path.join(import.meta.dirname,'..'));
let ts;
try {
  ts = require(require.resolve('typescript', { paths: [root] }));
} catch {
  console.log('TS_TRANSPILE_ALL_DEFERRED_TO_BUILD local-typescript-not-installed');
  process.exit(0);
}
const files=[];
for(const base of ['src']){
  const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(/\.tsx?$/.test(e.name))files.push(p)}};
  walk(path.join(root,base));
}
let failures=[];
for(const file of files){
 const text=fs.readFileSync(file,'utf8');
 const r=ts.transpileModule(text,{fileName:file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,experimentalDecorators:true,useDefineForClassFields:false}});
 for(const d of r.diagnostics||[]){if(d.category===ts.DiagnosticCategory.Error)failures.push(`${path.relative(root,file)} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`)}
}
if(failures.length){console.error('TS_TRANSPILE_ALL_FAILED');failures.slice(0,50).forEach(x=>console.error(x));process.exit(1)}
console.log(`TS_TRANSPILE_ALL_OK files=${files.length}`);
