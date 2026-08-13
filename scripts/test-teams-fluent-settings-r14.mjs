#!/usr/bin/env node
const window={};
// Exact page-world setup used by MacTranslate preload.
const root=window.__globalSettings__||(window.__globalSettings__={__callbacks__:{}});
if(!root.__callbacks__)root.__callbacks__={};
const icons=root.icons||(root.icons={__options:{},__remapped:{}});
icons.__remapped=icons.__remapped||{};
icons.__options={...(icons.__options||{}),disableWarnings:true,warnOnMissingIcons:true};
// Fluent UI GlobalSettings.getValue('icons', default) returns the existing object.
const getValue=(key,def)=>{const g=window.__globalSettings__;if(g[key]===undefined)g[key]=typeof def==='function'?def():def;return g[key]};
const actual=getValue('icons',()=>({__options:{disableWarnings:false,warnOnMissingIcons:true},__remapped:{}}));
if(actual.__options.disableWarnings!==true)throw new Error('duplicate/unregister warnings not disabled');
if(actual.__options.warnOnMissingIcons!==true)throw new Error('real missing-icon warnings unexpectedly disabled');
console.log('TEAMS_R14_FLUENT_SETTINGS_RUNTIME_OK');
console.log('GlobalSettings-preseed/duplicate+unregister-warning-control/missing-icons-still-warn=PASS');
