#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2]||process.cwd();
const preload=fs.readFileSync(path.join(root,'src/webview/recipe.ts'),'utf8');
const fail=m=>{console.error('TEAMS_R14_VERIFY_FAIL '+m);process.exit(1)};
if(!preload.includes("window.__globalSettings__"))fail('Fluent UI GlobalSettings hook missing');
if(!preload.includes("disableWarnings: true"))fail('Fluent UI disableWarnings option missing');
if(!preload.includes("warnOnMissingIcons: true"))fail('missing-icon warnings should remain enabled');
for(const host of ['teams.live.com','teams.microsoft.com','teams.cloud.microsoft']) if(!preload.includes(host)) fail('Teams host missing: '+host);
if(/console\.warn\s*=|console\.error\s*=|window\.console\.(warn|error)\s*=/.test(preload))fail('console interception found');
console.log('TEAMS_R14_FLUENT_WARNINGS_VERIFY_OK');
console.log('fluentui-GlobalSettings-icons-disableWarnings/no-console-interception=PASS');
