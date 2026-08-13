import fs from 'node:fs';

const menu = fs.readFileSync('src/lib/Menu.ts', 'utf8');
const main = fs.readFileSync('src/index.ts', 'utf8');
const recognition = fs.readFileSync('src/electron/message-recognition/UnifiedMessageRecognition.ts', 'utf8');

const checks = [
  ['view menu', menu.includes("message-recognition:view-messages")],
  ['export menu', menu.includes("message-recognition:export-messages")],
  ['view handler', main.includes("ipcMain.handle('message-recognition:view-messages'")],
  ['built-in viewer window', main.includes('MacTranslate 消息记录') && main.includes('new BrowserWindow({')],
  ['viewer reads archive itself', main.includes("readFileSync(file, 'utf8')")],
  ['viewer does not shell-open jsonl', !main.includes('shell.openPath(file)')],
  ['viewer conversation sidebar', main.includes('class="sidebar"') && main.includes("className='conversation'" )],
  ['viewer chat bubbles', main.includes("className='bubble'") && main.includes("row.className='row '+m.direction")],
  ['viewer search', main.includes('搜索发送者、会话或消息')],
  ['viewer service and direction filters', main.includes('id="service"') && main.includes('id="direction"')],
  ['viewer display dedupe', main.includes('const seen = new Set()') && main.includes('去重显示')],
  ['export handler', main.includes("ipcMain.handle('message-recognition:export-messages'")],
  ['canonical recognition dir exported', recognition.includes('export function recognitionDirectory()')],
  ['export copies real archive', main.includes('copyFileSync(source, result.filePath)')],
];
for (const [name, ok] of checks) {
  if (!ok) throw new Error(`MESSAGE_MENU_VERIFY_FAIL ${name}`);
}
console.log('MESSAGE_MENU_VERIFY_OK');
