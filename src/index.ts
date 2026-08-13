/* eslint-disable import/first */

import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BrowserWindow,
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  session,
  shell,
} from 'electron';

import { initialize } from 'electron-react-titlebar/main';
import windowStateKeeper from 'electron-window-state';
import { emptyDirSync, ensureFileSync } from 'fs-extra';
import minimist from 'minimist';
import ms from 'ms';
import { enableWebContents, initializeRemote } from './electron-util';
import enforceMacOSAppLocation from './enforce-macos-app-location';

initializeRemote();

import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_SHORTCUTS,
  DEFAULT_WINDOW_OPTIONS,
} from './config';

import { altKey, isLinux, isMac, isWindows } from './environment';
import {
  isDevMode,
  protocolClient,
  userDataPath,
  userDataRecipesPath,
} from './environment-remote';
import { ifUndefined } from './jsUtils';

import Settings from './electron/Settings';
import handleDeepLink from './electron/deepLinking';
import './electron/exception';
import { prepareEmbeddedSignalBeforeReady } from './electron/signal/EmbeddedSignalEngine';
import runEmbeddedSignalSmokeTest from './electron/signal/runEmbeddedSignalSmokeTest';
// eslint-disable-next-line import/no-cycle
import ipcApi from './electron/ipc-api';
import registerUnifiedMessageRecognition, {
  recognitionDirectory,
} from './electron/message-recognition/UnifiedMessageRecognition';
import isPositionValid from './electron/windowUtils';
import { mainIpcHandler as basicAuthHandler } from './features/basicAuth';
import DBus from './lib/DBus';
import TrayIcon from './lib/Tray';
// @ts-expect-error Cannot find module './package.json' or its corresponding type declarations.
import { appId } from './package.json';

import { asarPath } from './helpers/asar-helpers';
import { checkIfCertIsPresent } from './helpers/certs-helpers';
import { translateTo } from './helpers/translation-helpers';
import { openExternalUrl } from './helpers/url-helpers';
import userAgent from './helpers/userAgent-helpers';
import generatedTranslations from './i18n/translations';
import { darkThemeGrayDarkest } from './themes/legacy';

const debug = require('./preload-safe-debug')('Ferdium:App');
const isSignalSmokeTest = process.argv.includes('--signal-smoke-test');

// Signal registers custom protocols and its embedded main-process services
// before Electron emits app.ready. This must stay above every ready handler.
prepareEmbeddedSignalBeforeReady();

// Globally set useragent to fix user agent override in service workers
debug('Set userAgent to ', userAgent());
app.userAgentFallback = userAgent();

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow: BrowserWindow | undefined;
let willQuitApp = false;
let overrideAppQuitForUpdate = false;

// eslint-disable-next-line unicorn/prefer-event-target
export const appEvents = new EventEmitter();

// Register methods to be called once the window has been loaded.
let onDidLoadFns: any[] | null = [];

const onDidLoad = (fn: {
  (window: BrowserWindow): void;
  (window: BrowserWindow): void;
  (window: BrowserWindow): void;
  (arg0: BrowserWindow): void;
}): void => {
  if (onDidLoadFns) {
    onDidLoadFns.push(fn);
  } else if (mainWindow) {
    fn(mainWindow);
  }
};

// Ensure that the recipe directory exists
emptyDirSync(userDataRecipesPath('temp'));
ensureFileSync(userDataPath('window-state.json'));

// Set App ID for Windows
if (isWindows) {
  app.setAppUserModelId(appId);
}

// Initialize Settings
const settings = new Settings('app', DEFAULT_APP_SETTINGS);
const proxySettings = new Settings('proxy');
const shortcutSettings = new Settings('shortcuts', DEFAULT_SHORTCUTS);

const retrieveSettingValue = (key: string, defaultValue: boolean | string) =>
  ifUndefined<boolean | string>(settings.get(key), defaultValue);

// TODO: Commenting out sentry to fix https://github.com/ferdium/ferdium-app/issues/814
// if (retrieveSettingValue('sentry', DEFAULT_APP_SETTINGS.sentry)) {
//   // eslint-disable-next-line global-require
//   require('./sentry');
// }

const liftSingleInstanceLock = retrieveSettingValue(
  'liftSingleInstanceLock',
  DEFAULT_APP_SETTINGS.liftSingleInstanceLock,
);

// Force single window
const gotTheLock =
  isSignalSmokeTest || liftSingleInstanceLock
    ? true
    : app.requestSingleInstanceLock();
if (gotTheLock) {
  app.on('second-instance', (_event, argv) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();

      if (isWindows) {
        onDidLoad((window: BrowserWindow) => {
          // Keep only command line / deep linked arguments
          const url = argv.slice(1);
          handleDeepLink(window, url.toString());

          if (argv.includes('--reset-window')) {
            // Needs to be delayed to not interfere with mainWindow.restore();
            setTimeout(() => {
              debug('Resetting windows via Task');
              window.setPosition(
                DEFAULT_WINDOW_OPTIONS.x + 100,
                DEFAULT_WINDOW_OPTIONS.y + 100,
              );
              window.setSize(
                DEFAULT_WINDOW_OPTIONS.width,
                DEFAULT_WINDOW_OPTIONS.height,
              );
            }, 1);
          } else if (argv.includes('--quit')) {
            // Needs to be delayed to not interfere with mainWindow.restore();
            setTimeout(() => {
              debug('Quitting Ferdium via Task');
              app.quit();
            }, 1);
          }
        });
      }
    }
  });
} else {
  app.quit();
}

// Disable GPU acceleration
if (
  !retrieveSettingValue(
    'enableGPUAcceleration',
    DEFAULT_APP_SETTINGS.enableGPUAcceleration,
  )
) {
  debug('Disable GPU Acceleration');
  app.disableHardwareAcceleration();
}

const webRTCIPHandlingPolicy = retrieveSettingValue(
  'webRTCIPHandlingPolicy',
  DEFAULT_APP_SETTINGS.webRTCIPHandlingPolicy,
) as
  | 'disable_non_proxied_udp'
  | 'default'
  | 'default_public_interface_only'
  | 'default_public_and_private_interfaces';

const createWindow = () => {
  // Remember window size
  const mainWindowState = windowStateKeeper({
    defaultWidth: DEFAULT_WINDOW_OPTIONS.width,
    defaultHeight: DEFAULT_WINDOW_OPTIONS.height,
    maximize: true, // Automatically maximizes the window, if it was last closed maximized
    fullScreen: true, // Automatically restores the window to full screen, if it was last closed full screen
  });

  let posX = mainWindowState.x || DEFAULT_WINDOW_OPTIONS.x;
  let posY = mainWindowState.y || DEFAULT_WINDOW_OPTIONS.y;

  if (!isPositionValid({ x: posX, y: posY })) {
    debug('Window is out of screen bounds, resetting window');
    posX = DEFAULT_WINDOW_OPTIONS.x;
    posY = DEFAULT_WINDOW_OPTIONS.y;
  }

  // Create the browser window.
  const backgroundColor = retrieveSettingValue(
    'darkMode',
    DEFAULT_APP_SETTINGS.darkMode,
  )
    ? darkThemeGrayDarkest
    : (retrieveSettingValue(
        'accentColor',
        DEFAULT_APP_SETTINGS.accentColor,
      ) as string);

  const linuxMainWindowConf = {
    icon: asarPath(
      join(
        isDevMode ? `${__dirname}../src/` : __dirname,
        'assets/images/icons/256x256.png',
      ),
    ),
  };

  mainWindow = new BrowserWindow({
    x: posX,
    y: posY,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 600,
    minHeight: 500,
    show: false,
    titleBarStyle: isMac ? 'hidden' : 'default',
    frame: isLinux,
    backgroundColor,
    webPreferences: {
      spellcheck: retrieveSettingValue(
        'enableSpellchecking',
        DEFAULT_APP_SETTINGS.enableSpellchecking,
      ) as boolean,
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
    ...(isLinux ? linuxMainWindowConf : {}),
  });

  enableWebContents(mainWindow.webContents);
  mainWindow.webContents.setWebRTCIPHandlingPolicy(webRTCIPHandlingPolicy);

  app.on('browser-window-created', (_, window) => {
    enableWebContents(window.webContents);
  });

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      enableWebContents(contents);

      // Set permission handlers on service webview sessions.
      // This explicitly allows safe permissions and denies unknown ones,
      // and enables HID/USB/Serial for hardware FIDO2 security key detection.
      const ses = contents.session;
      if (!(ses as any)._permissionHandlersSet) {
        (ses as any)._permissionHandlersSet = true;

        const isWhatsAppOrigin = (value: string): boolean => {
          try {
            return new URL(value).origin === 'https://web.whatsapp.com';
          } catch {
            return false;
          }
        };

        ses.setPermissionRequestHandler(
          (webContents, permission, callback, details) => {
            const allowedPermissions = [
              'media',
              'notifications',
              'fullscreen',
              'pointerLock',
              'display-capture',
              'idle-detection',
              'clipboard-read',
              'clipboard-sanitized-write',
              'speaker-selection',
            ];
            const permissionName = String(permission);
            const requestingUrl =
              (details as { requestingUrl?: string })?.requestingUrl ||
              webContents?.getURL() ||
              '';

            // Chromium maps durable storage to Electron's
            // `persistent-storage` permission. WhatsApp calls
            // navigator.storage.persist() during its own bootstrap; deny it
            // and WhatsApp reports acquire-persistent-storage-denied.
            if (
              permissionName === 'persistent-storage' &&
              isWhatsAppOrigin(requestingUrl)
            ) {
              callback(true);
              return;
            }

            if (allowedPermissions.includes(permissionName)) {
              callback(true);
              return;
            }

            debug(
              `Denied permission request: ${permissionName} from ${requestingUrl}`,
            );
            callback(false);
          },
        );

        // WhatsApp's closed web bundle uploads internal non-fatal crash logs to
        // crashlogs.whatsapp.net. Some of those telemetry uploads currently
        // return HTTP 400 even while the app continues normally, which Chromium
        // surfaces as a red Failed to load resource entry. Electron supports
        // overriding the response status line in onHeadersReceived. Normalize
        // only that telemetry endpoint's 400 response; never touch WhatsApp API,
        // media, websocket, or MacTranslate traffic.
        ses.webRequest.onHeadersReceived(
          { urls: [
            'https://crashlogs.whatsapp.net/*',
            'https://teams.live.com/v2/manifest.json',
          ] },
          (details, callback) => {
            const requestUrl = details.url || '';
            if (
              requestUrl.startsWith('https://crashlogs.whatsapp.net/') &&
              details.statusCode === 400
            ) {
              callback({
                responseHeaders: details.responseHeaders || {},
                statusLine: 'HTTP/1.1 200 OK',
              });
              return;
            }
            if (
              requestUrl === 'https://teams.live.com/v2/manifest.json' &&
              details.statusCode === 404
            ) {
              callback({
                responseHeaders: {},
                statusLine: 'HTTP/1.1 204 No Content',
              });
              return;
            }
            callback({});
          },
        );

        ses.setPermissionCheckHandler(
          (_webContents, permission, requestingOrigin) => {
            const allowedChecks = [
              'media',
              'notifications',
              'fullscreen',
              'pointerLock',
              'display-capture',
              'idle-detection',
              'clipboard-read',
              'clipboard-sanitized-write',
              'hid',
              'serial',
              'usb',
              'speaker-selection',
            ];
            const permissionName = String(permission);

            if (
              permissionName === 'persistent-storage' &&
              isWhatsAppOrigin(requestingOrigin || '')
            ) {
              return true;
            }

            return allowedChecks.includes(permissionName);
          },
        );
      }

      contents.setWindowOpenHandler(({ url, disposition }) => {
        // OAuth popups (Google, Microsoft, etc.) are opened via window.open()
        // and need window.opener preserved so the parent can receive the
        // postMessage callback that completes the flow. Allow them as a child
        // BrowserWindow that inherits the service partition.
        if (disposition === 'new-window') {
          return {
            action: 'allow',
            outlivesOpener: false,
            overrideBrowserWindowOptions: {
              parent: mainWindow,
              fullscreenable: false,
              webPreferences: { session: contents.session },
            },
          };
        }

        // Regular link clicks → open in the user's default browser.
        openExternalUrl(url);
        return { action: 'deny' };
      });

      contents.on('did-create-window', child => {
        enableWebContents(child.webContents);
        child.webContents.setWebRTCIPHandlingPolicy(webRTCIPHandlingPolicy);
      });

      // Handle will download event from main process (prevent download dialog)
      contents.session.on('will-download', (_e, item) => {
        const downloadFolderPath = retrieveSettingValue(
          'downloadFolderPath',
          DEFAULT_APP_SETTINGS.downloadFolderPath,
        ) as string;

        if (downloadFolderPath !== '') {
          item.setSavePath(join(downloadFolderPath, item.getFilename()));
        }
      });
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const fns = onDidLoadFns;
    onDidLoadFns = null;

    if (!fns) return;

    for (const fn of fns) {
      fn(mainWindow);
    }
  });

  // Initialize System Tray
  const trayIcon: TrayIcon = new TrayIcon();

  // Initialize DBus interface
  const dbus = new DBus(trayIcon);

  // Initialize ipcApi
  ipcApi({
    mainWindow,
    settings: {
      app: settings,
      proxy: proxySettings,
      shortcuts: shortcutSettings,
    },
    trayIcon,
  });

  registerUnifiedMessageRecognition();

  // Connect to the DBus after ipcApi took care of the System Tray
  dbus.start();

  // Manage Window State
  mainWindowState.manage(mainWindow);

  // and load the index.html of the app.
  mainWindow.loadURL(`file://${__dirname}/index.html`);

  // Open the DevTools.
  if (isDevMode || process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools();
  }

  // Windows deep linking handling on app launch
  if (isWindows) {
    onDidLoad((window: BrowserWindow) => {
      const url = process.argv.slice(1);
      handleDeepLink(window, url.toString());
    });
  }

  // Emitted when the window is closed.
  mainWindow.on('close', e => {
    debug('Window: close window');
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    if (
      !willQuitApp &&
      retrieveSettingValue(
        'runInBackground',
        DEFAULT_APP_SETTINGS.runInBackground,
      )
    ) {
      e.preventDefault();
      if (isWindows) {
        debug('Window: minimize');
        mainWindow?.minimize();

        if (
          retrieveSettingValue(
            'closeToSystemTray',
            DEFAULT_APP_SETTINGS.closeToSystemTray,
          )
        ) {
          debug('Skip taskbar: true');
          mainWindow?.setSkipTaskbar(true);
        }
      } else if (isMac && mainWindow?.isFullScreen()) {
        debug('Window: leaveFullScreen and hide');
        mainWindow.once('show', () => mainWindow?.setFullScreen(true));
        mainWindow.once('leave-full-screen', () => mainWindow?.hide());
        mainWindow.setFullScreen(false);
      } else {
        debug('Window: hide');
        mainWindow?.hide();
      }
    } else if (!overrideAppQuitForUpdate) {
      debug('Quitting the app');
      dbus.stop();
      app.quit();
    }
  });

  // For Windows we need to store a flag to properly restore the window
  // if the window was maximized before minimizing it so system tray
  mainWindow.on('minimize', () => {
    // @ts-expect-error Property 'wasMaximized' does not exist on type 'App'.
    app.wasMaximized = app.isMaximized;

    if (
      retrieveSettingValue(
        'minimizeToSystemTray',
        DEFAULT_APP_SETTINGS.minimizeToSystemTray,
      )
    ) {
      debug('Skip taskbar: true');
      mainWindow?.setSkipTaskbar(true);
      trayIcon.show();
    }
  });

  mainWindow.on('maximize', () => {
    debug('Window: maximize');
    // @ts-expect-error Property 'isMaximized' does not exist on type 'App'.
    app.isMaximized = true;
    mainWindow?.setSkipTaskbar(false);
  });

  mainWindow.on('unmaximize', () => {
    debug('Window: unmaximize');
    // @ts-expect-error Property 'isMaximized' does not exist on type 'App'.
    app.isMaximized = false;
  });

  mainWindow.on('restore', () => {
    debug('Window: restore');
    mainWindow?.setSkipTaskbar(false);

    // @ts-expect-error Property 'wasMaximized' does not exist on type 'App'.
    if (app.wasMaximized) {
      debug('Window: was maximized before, maximize window');
      mainWindow?.maximize();
    }

    if (
      !retrieveSettingValue(
        'enableSystemTray',
        DEFAULT_APP_SETTINGS.enableSystemTray,
      )
    ) {
      debug('Tray: hiding tray icon');
      trayIcon.hide();
    }
  });

  if (isMac) {
    // Note: Do not remove the extension. See https://github.com/ferdium/ferdium-app/issues/1755 for explanation
    import('./electron/macOSPermissions.js').then(macOSPermissions => {
      const { askFormacOSPermissions } = macOSPermissions;

      setTimeout(() => askFormacOSPermissions(mainWindow!), ms('30s'));
    });
  }

  mainWindow.on('show', () => {
    debug('Skip taskbar: true');
    mainWindow?.setSkipTaskbar(false);
  });

  // @ts-expect-error Property 'isMaximized' does not exist on type 'App'.
  app.isMaximized = mainWindow.isMaximized();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });

  if (
    retrieveSettingValue('startMinimized', DEFAULT_APP_SETTINGS.startMinimized)
  ) {
    mainWindow.hide();
  } else {
    mainWindow.show();
  }

  app.whenReady().then(() => {
    if (
      retrieveSettingValue(
        'enableGlobalHideShortcut',
        DEFAULT_APP_SETTINGS.enableGlobalHideShortcut,
      )
    ) {
      // Toggle the window on 'Alt+X'
      globalShortcut.register(`${altKey()}+X`, () => {
        trayIcon._toggleWindow();
      });
    }
  });
};

// Allow passing command line parameters/switches to electron
// https://electronjs.org/docs/api/chrome-command-line-switches
// used for Kerberos support
// Usage e.g. MACOS
// $ Ferdium.app/Contents/MacOS/Ferdium --auth-server-whitelist *.mydomain.com --auth-negotiate-delegate-whitelist *.mydomain.com
const argv = minimist(process.argv.slice(1));

if (argv['auth-server-whitelist']) {
  app.commandLine.appendSwitch(
    'auth-server-whitelist',
    argv['auth-server-whitelist'],
  );
}
if (argv['auth-negotiate-delegate-whitelist']) {
  app.commandLine.appendSwitch(
    'auth-negotiate-delegate-whitelist',
    argv['auth-negotiate-delegate-whitelist'],
  );
}

// Apply workaround for https://github.com/electron/electron/pull/26432
app.commandLine.appendSwitch('disable-features', 'CrossOriginOpenerPolicy');

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  if (isSignalSmokeTest) {
    void runEmbeddedSignalSmokeTest();
    return;
  }

  // force app to live in /Applications
  enforceMacOSAppLocation();

  // Register App URL
  if (!app.isDefaultProtocolClient(protocolClient, process.execPath)) {
    app.setAsDefaultProtocolClient(protocolClient, process.execPath);
  }

  if (isWindows) {
    const extraArgs = isDevMode ? `${__dirname} ` : '';
    const iconPath = asarPath(
      join(
        isDevMode ? `${__dirname}../src/` : __dirname,
        'assets/images/taskbar/win32/display.ico',
      ),
    );
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: `${extraArgs}--reset-window`,
        iconPath,
        iconIndex: 0,
        title: 'Move Ferdium to Current Display',
        description: 'Restore the position and size of Ferdium',
      },
      {
        program: process.execPath,
        arguments: `${extraArgs}--quit`,
        iconPath,
        iconIndex: 0,
        title: 'Quit Ferdium',
        description: '',
      },
    ]);
  }

  initialize();

  createWindow();
});

// This is the worst possible implementation as the webview.webContents based callback doesn't work 🖕
// TODO: rewrite to handle multiple login calls
const noop = () => null;
let authCallback = noop;

app.on('login', (event, _webContents, _request, authInfo, callback) => {
  // @ts-expect-error Type '(username?: string | undefined, password?: string | undefined) => void' is not assignable to type '() => null'.
  authCallback = callback;
  debug('browser login event', authInfo);
  event.preventDefault();

  if (!authInfo.isProxy && authInfo.scheme === 'basic') {
    debug('basic auth handler', authInfo);
    basicAuthHandler(mainWindow!, authInfo);
  }
});

const recognitionMessageFile = () =>
  join(recognitionDirectory(), 'messages.jsonl');

let messageViewerWindow: BrowserWindow | undefined;

const readRecognizedMessagesForViewer = (): Array<Record<string, unknown>> => {
  const file = recognitionMessageFile();
  ensureFileSync(file);
  const raw = readFileSync(file, 'utf8');
  const rows: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // Keep a malformed line from breaking the whole viewer.
    }
  }
  return rows;
};

const buildMessageViewerHtml = (): string => {
  const rows = readRecognizedMessagesForViewer();
  const serializedRows = JSON.stringify(rows)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MacTranslate 消息记录</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;--bg:#f5f5f7;--panel:#fff;--line:rgba(60,60,67,.16);--muted:#6e6e73;--accent:#0a84ff;--incoming:#e9e9eb;--outgoing:#0a84ff;--outgoingText:#fff;--hover:rgba(0,0,0,.05)}
@media(prefers-color-scheme:dark){:root{--bg:#111;--panel:#1c1c1e;--line:rgba(235,235,245,.16);--muted:#98989d;--incoming:#2c2c2e;--hover:rgba(255,255,255,.06)}}
*{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--bg);color:CanvasText;overflow:hidden}
.app{height:100%;min-height:0;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr)}.topbar{display:flex;gap:10px;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
.titleblock{min-width:210px}.title{font-size:18px;font-weight:700}.summary{font-size:11px;color:var(--muted);margin-top:2px;white-space:nowrap}.controls{display:flex;gap:8px;flex:1;justify-content:flex-end}
input,select{height:34px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:inherit;padding:0 10px;font:inherit;font-size:13px;outline:none}input{width:min(360px,38vw)}input:focus,select:focus{border-color:var(--accent)}
.main{min-height:0;overflow:hidden;display:grid;grid-template-columns:300px minmax(0,1fr)}.sidebar{min-width:0;min-height:0;border-right:1px solid var(--line);background:var(--panel);overflow-y:auto;overflow-x:hidden}.conversation{padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer}.conversation:hover{background:var(--hover)}.conversation.active{background:color-mix(in srgb,var(--accent) 12%,var(--panel))}
.convTop{display:flex;align-items:center;gap:8px}.service{font-size:10px;text-transform:uppercase;font-weight:700;letter-spacing:.4px;color:var(--accent);flex:0 0 auto}.convTitle{font-size:13px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.count{font-size:11px;color:var(--muted)}.preview{font-size:12px;color:var(--muted);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.convTime{font-size:10px;color:var(--muted);margin-top:4px}
.content{min-width:0;min-height:0;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--bg)}.contentHead{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel);display:flex;align-items:center;gap:10px}.contentTitle{font-size:14px;font-weight:700}.contentMeta{font-size:11px;color:var(--muted)}
.messages{min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:18px 22px 30px}.day{display:flex;justify-content:center;margin:12px 0}.day span{font-size:10px;color:var(--muted);background:var(--panel);border:1px solid var(--line);padding:3px 8px;border-radius:999px}
.row{display:flex;margin:7px 0}.row.outgoing{justify-content:flex-end}.msgWrap{max-width:min(720px,78%)}.sender{font-size:10px;color:var(--muted);margin:0 8px 3px}.row.outgoing .sender{text-align:right}.bubble{font-size:13px;line-height:1.42;white-space:pre-wrap;word-break:break-word;border-radius:15px;padding:8px 11px;background:var(--incoming)}.row.outgoing .bubble{background:var(--outgoing);color:var(--outgoingText)}.time{font-size:9px;color:var(--muted);margin:3px 8px 0}.row.outgoing .time{text-align:right}
.empty{height:100%;display:grid;place-items:center;color:var(--muted);font-size:13px;padding:30px;text-align:center}.mark{background:#ffd60a;color:#000;border-radius:2px;padding:0 1px}
@media(max-width:760px){.main{grid-template-columns:220px 1fr}.titleblock{display:none}.controls{justify-content:stretch}input{width:100%;min-width:0}.msgWrap{max-width:90%}}
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="titleblock"><div class="title">消息记录</div><div class="summary" id="summary"></div></div>
    <div class="controls">
      <input id="search" type="search" placeholder="搜索发送者、会话或消息…" autocomplete="off">
      <select id="service"><option value="all">全部平台</option></select>
      <select id="direction"><option value="all">全部方向</option><option value="incoming">收到</option><option value="outgoing">发出</option></select>
    </div>
  </div>
  <div class="main">
    <aside class="sidebar" id="sidebar"></aside>
    <section class="content">
      <div class="contentHead"><div class="contentTitle" id="contentTitle">选择会话</div><div class="contentMeta" id="contentMeta"></div></div>
      <div class="messages" id="messages"><div class="empty">暂无真实消息</div></div>
    </section>
  </div>
</div>
<script id="message-data" type="application/json">${serializedRows}</script>
<script>
(function(){
  const raw = JSON.parse(document.getElementById('message-data').textContent || '[]');
  const text = v => String(v == null ? '' : v);
  const normalized = raw.map((r,i) => ({
    _i:i,
    service:text(r.service || 'unknown').toLowerCase(),
    direction:r.direction === 'outgoing' ? 'outgoing' : 'incoming',
    ts:Number(r.sentAt ?? r.observedAt ?? 0) || 0,
    sender:text(r.senderName || r.senderId || (r.direction === 'outgoing' ? '我' : '未知发送者')),
    senderId:text(r.senderId || ''),
    conversation:text(r.conversationTitle || r.conversationId || '未命名会话'),
    conversationId:text(r.conversationId || r.conversationTitle || 'unknown'),
    messageId:text(r.providerMessageId || r.messageId || ''),
    observedAt:Number(r.observedAt || 0) || 0,
    timestampQuality:text(r.timestampQuality || ''),
    providerEvent:text(r.providerEvent || ''),
    body:text(r.text || '')
  })).filter(m => !(m.service === 'signal' && m.providerEvent === 'signal-8.17.0-rendered-dom-readonly'));

  const normalizedTitle = v => text(v).normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF\uFE0F]/g,'').replace(/\s+/g,' ').trim().replace(/[.·•]+$/g,'').trim().toLocaleLowerCase();
  const archiveConversationKey = m => m.service === 'teams' && normalizedTitle(m.conversation)
    ? 'teams-title:' + normalizedTitle(m.conversation)
    : m.conversationId;

  // Provider IDs are authoritative. When a newer build re-captures the same
  // message with corrected direction/sender metadata, show the newest record
  // instead of preserving the old bad row forever.
  const latestByIdentity = new Map();
  const providerIdsGlobalPerAccount = new Set(['signal','whatsapp']);
  for (const m of normalized) {
    // Signal UUID message ids and WhatsApp serialized stanza ids are provider-global
    // inside the active account. Older builds sometimes attached the correct provider
    // id to a wrong/derived conversation id; let the newest canonical recapture replace
    // that stale row instead of creating a duplicate conversation in the viewer.
    const idKey = m.messageId
      ? JSON.stringify(providerIdsGlobalPerAccount.has(m.service)
          ? [m.service,m.messageId]
          : [m.service,archiveConversationKey(m),m.messageId])
      : JSON.stringify([m.service,archiveConversationKey(m),m.ts,m.body]);
    const previous = latestByIdentity.get(idKey);
    if (!previous || (m.observedAt || m._i) >= (previous.observedAt || previous._i)) latestByIdentity.set(idKey,m);
  }
  // Old builds sometimes assigned a derived provider id and wrong Teams direction.
  // Reconcile the same timestamp+body inside one canonical conversation by newest
  // observation too, so a corrected recapture replaces the stale bad row in view.
  const latestBySemantic = new Map();
  for (const m of latestByIdentity.values()) {
    const semanticKey = JSON.stringify([m.service,archiveConversationKey(m),m.ts,m.body]);
    const previous = latestBySemantic.get(semanticKey);
    if (!previous || (m.observedAt || m._i) >= (previous.observedAt || previous._i)) latestBySemantic.set(semanticKey,m);
  }
  const seen = new Set();
  const rows = [];
  for (const m of latestBySemantic.values()) {
    const key = JSON.stringify([m.service,m.direction,m.ts,m.senderId || m.sender,archiveConversationKey(m),m.body]);
    if (seen.has(key)) continue;
    seen.add(key); rows.push(m);
  }
  // If an unread Telegram preview was later captured as a real provider message,
  // hide the preview duplicate in the viewer but keep the raw archive untouched.
  const realSemantic = new Set(rows.filter(m=>m.timestampQuality!=='observed-preview').map(m=>JSON.stringify([m.service,archiveConversationKey(m),m.direction,m.body])));
  const displayRows = rows.filter(m=>m.timestampQuality!=='observed-preview' || !realSemantic.has(JSON.stringify([m.service,archiveConversationKey(m),m.direction,m.body])));
  displayRows.sort((a,b) => a.ts - b.ts || a._i - b._i);

  const summary = document.getElementById('summary');
  summary.textContent = '原始 ' + raw.length + ' 条 · 去重显示 ' + displayRows.length + ' 条 · 再次点击 MacTranslate → 查看消息 可刷新';

  const serviceSelect = document.getElementById('service');
  [...new Set(displayRows.map(x => x.service))].sort().forEach(s => {
    const o=document.createElement('option'); o.value=s; o.textContent=s; serviceSelect.appendChild(o);
  });
  const search=document.getElementById('search');
  const direction=document.getElementById('direction');
  const sidebar=document.getElementById('sidebar');
  const messages=document.getElementById('messages');
  const contentTitle=document.getElementById('contentTitle');
  const contentMeta=document.getElementById('contentMeta');
  let selectedKey='';

  const convKey = m => m.service + '\\u001f' + archiveConversationKey(m);
  const fmtSidebarTime = ts => ts ? new Date(ts).toLocaleString([], {month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : '';
  const fmtDay = ts => ts ? new Date(ts).toLocaleDateString([], {year:'numeric',month:'long',day:'numeric'}) : '未知日期';

  function matches(m){
    const svc=serviceSelect.value, dir=direction.value, q=search.value.trim().toLowerCase();
    if(svc!=='all' && m.service!==svc) return false;
    if(dir!=='all' && m.direction!==dir) return false;
    if(q && !(m.body+' '+m.sender+' '+m.conversation+' '+m.service).toLowerCase().includes(q)) return false;
    return true;
  }
  function getGroups(){
    const map=new Map();
    for(const m of displayRows){
      if(!matches(m)) continue;
      const k=convKey(m); if(!map.has(k)) map.set(k,[]); map.get(k).push(m);
    }
    return [...map.entries()].sort((a,b)=>(b[1].at(-1)?.ts||0)-(a[1].at(-1)?.ts||0));
  }
  function clear(el){ while(el.firstChild) el.removeChild(el.firstChild); }
  function renderSidebar(){
    const groups=getGroups(); clear(sidebar);
    if(!groups.length){ const e=document.createElement('div'); e.className='empty'; e.textContent='没有符合条件的消息'; sidebar.appendChild(e); selectedKey=''; renderMessages(); return; }
    if(!groups.some(([k])=>k===selectedKey)) selectedKey=groups[0][0];
    for(const [k,list] of groups){
      const last=list[list.length-1]; const item=document.createElement('div'); item.className='conversation'+(k===selectedKey?' active':'');
      const top=document.createElement('div'); top.className='convTop';
      const svc=document.createElement('div'); svc.className='service'; svc.textContent=last.service;
      const title=document.createElement('div'); title.className='convTitle'; title.textContent=last.conversation;
      const count=document.createElement('div'); count.className='count'; count.textContent=String(list.length);
      top.append(svc,title,count);
      const preview=document.createElement('div'); preview.className='preview'; preview.textContent=(last.direction==='outgoing'?'我: ':last.sender+': ')+last.body;
      const t=document.createElement('div'); t.className='convTime'; t.textContent=fmtSidebarTime(last.ts);
      item.append(top,preview,t); item.addEventListener('click',()=>{selectedKey=k; renderSidebar(); renderMessages();}); sidebar.appendChild(item);
    }
    renderMessages();
  }
  function renderMessages(){
    clear(messages);
    if(!selectedKey){ contentTitle.textContent='选择会话'; contentMeta.textContent=''; const e=document.createElement('div'); e.className='empty'; e.textContent='暂无消息'; messages.appendChild(e); return; }
    const list=displayRows.filter(m=>convKey(m)===selectedKey && matches(m));
    if(!list.length){ const e=document.createElement('div'); e.className='empty'; e.textContent='这个会话没有符合条件的消息'; messages.appendChild(e); return; }
    contentTitle.textContent=list[0].conversation;
    contentMeta.textContent=list[0].service+' · '+list.length+' 条';
    let lastDay='';
    for(const m of list){
      const day=fmtDay(m.ts); if(day!==lastDay){ const d=document.createElement('div'); d.className='day'; const span=document.createElement('span'); span.textContent=day; d.appendChild(span); messages.appendChild(d); lastDay=day; }
      const row=document.createElement('div'); row.className='row '+m.direction;
      const wrap=document.createElement('div'); wrap.className='msgWrap';
      const sender=document.createElement('div'); sender.className='sender'; sender.textContent=m.direction==='outgoing'?'我':m.sender;
      const bubble=document.createElement('div'); bubble.className='bubble'; bubble.textContent=m.body || '[空消息]';
      const tm=document.createElement('div'); tm.className='time'; tm.textContent=fmtTime(m.ts);
      wrap.append(sender,bubble,tm); row.appendChild(wrap); messages.appendChild(row);
    }
    messages.scrollTop=messages.scrollHeight;
  }
  search.addEventListener('input',renderSidebar); serviceSelect.addEventListener('change',renderSidebar); direction.addEventListener('change',renderSidebar);
  renderSidebar();
})();
</script>
</body>
</html>`;
};

const showMessageViewer = async (): Promise<void> => {
  if (!messageViewerWindow || messageViewerWindow.isDestroyed()) {
    messageViewerWindow = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 760,
      minHeight: 480,
      title: 'MacTranslate 消息记录',
      parent: mainWindow,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    messageViewerWindow.on('closed', () => {
      messageViewerWindow = undefined;
    });
  }
  const html = buildMessageViewerHtml();
  await messageViewerWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
  messageViewerWindow.show();
  messageViewerWindow.focus();
};

ipcMain.handle('message-recognition:view-messages', async () => {
  await showMessageViewer();
  return { ok: true, file: recognitionMessageFile() };
});

ipcMain.handle('message-recognition:export-messages', async () => {
  const source = recognitionMessageFile();
  if (!existsSync(source) || statSync(source).size === 0) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'MacTranslate',
      message: '暂无可导出的消息',
    });
    return { ok: false, canceled: true };
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const defaultPath = join(
    app.getPath('downloads'),
    `MacTranslate-messages-${stamp}.jsonl`,
  );
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, {
        title: '导出消息',
        defaultPath,
        filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
      })
    : await dialog.showSaveDialog({
        title: '导出消息',
        defaultPath,
        filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
      });

  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  copyFileSync(source, result.filePath);
  shell.showItemInFolder(result.filePath);
  return { ok: true, file: result.filePath };
});

ipcMain.handle(
  'translate',
  async (_e, { text, translateToLanguage, translatorEngine }) => {
    const response = await translateTo(
      text,
      translateToLanguage,
      translatorEngine,
    );
    return response;
  },
);

// Handle translation requests from webview
ipcMain.handle(
  'get-translation',
  async (_e, key: string, params?: { [key: string]: string }) => {
    try {
      const locale = settings.get('locale') || 'en-US';
      const translations = generatedTranslations();
      let text: string = translations[locale]?.[key] || key;

      if (params) {
        Object.entries(params).forEach(([param, value]) => {
          text = text.replaceAll(`{${param}}`, value);
        });
      }

      return text;
    } catch {
      return key;
    }
  },
);

// Send translation cache to webview when requested
ipcMain.on('request-translation-cache', event => {
  try {
    const locale = settings.get('locale') || 'en-US';
    const translations = generatedTranslations();
    const contextMenuTranslations = {};

    // Extract only context menu related translations
    Object.keys(translations[locale] || {}).forEach(key => {
      if (key.startsWith('contextMenu.')) {
        contextMenuTranslations[key] = translations[locale][key];
      }
    });

    event.reply('translation-cache', contextMenuTranslations);
  } catch (error) {
    debug('Error sending translation cache:', error);
    event.reply('translation-cache', {});
  }
});

// TODO: evaluate if we need to store the authCallback for every service
ipcMain.on('feature-basic-auth-credentials', (_e, { user, password }) => {
  debug('Received basic auth credentials', user, '********');

  // @ts-expect-error Expected 0 arguments, but got 2.
  authCallback(user, password);
  authCallback = noop;
});

ipcMain.on('open-browser-window', (_e, { url, serviceId }) => {
  const serviceSession = session.fromPartition(`persist:service-${serviceId}`);
  const child = new BrowserWindow({
    parent: mainWindow,
    fullscreenable: false,
    webPreferences: {
      session: serviceSession,
    },
  });
  enableWebContents(child.webContents);
  child.webContents.setWebRTCIPHandlingPolicy(webRTCIPHandlingPolicy);
  child.show();
  child.loadURL(url);
  debug('Received open-browser-window', url);
});

ipcMain.on(
  'modifyRequestHeaders',
  (_e, { modifiedRequestHeaders, serviceId }) => {
    debug(
      `Received modifyRequestHeaders ${modifiedRequestHeaders} for serviceId ${serviceId}`,
    );
    for (const headerFilterSet of modifiedRequestHeaders) {
      const { headers, requestFilters } = headerFilterSet;
      session
        .fromPartition(`persist:service-${serviceId}`)
        .webRequest.onBeforeSendHeaders(requestFilters, (details, callback) => {
          for (const key in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, key)) {
              const value = headers[key];
              // eslint-disable-next-line no-param-reassign
              details.requestHeaders[key] = value;
            }
          }
          callback({ requestHeaders: details.requestHeaders });
        });
    }
  },
);


ipcMain.on('knownCertificateHosts', (_e, { knownHosts, serviceId }) => {
  debug(
    `Received knownCertificateHosts ${knownHosts} for serviceId ${serviceId}`,
  );
  session
    .fromPartition(`persist:service-${serviceId}`)
    .setCertificateVerifyProc((request, callback) => {
      // To know more about these callbacks: https://www.electronjs.org/docs/api/session#sessetcertificateverifyprocproc
      const { hostname } = request;
      if (
        knownHosts.find((item: string | string[]) => item.includes(hostname))
          .length > 0
      ) {
        callback(0);
      } else {
        callback(-2);
      }
    });
});

ipcMain.on('feature-basic-auth-cancel', () => {
  debug('Cancel basic auth');

  // @ts-expect-error Expected 0 arguments, but got 2.
  authCallback(null);
  authCallback = noop;
});

ipcMain.on('load-available-displays', (_e, data) => {
  debug('MAIN PROCESS: Received load-desktop-capturer-sources');
  mainWindow?.webContents.send(`select-capture-device:${data.serviceId}`, data);
});

// Handle synchronous messages from service webviews.

ipcMain.on('find-in-page', (e, text, options) => {
  const { sender: webContents } = e;
  if (webContents !== mainWindow?.webContents && typeof text === 'string') {
    const sanitizedOptions = {};
    for (const option of ['forward', 'findNext', 'matchCase']) {
      if (option in options) {
        sanitizedOptions[option] = !!options[option];
      }
    }
    const requestId = webContents.findInPage(text, sanitizedOptions);
    debug('Find in page', text, options, requestId);
    e.returnValue = requestId;
  } else {
    e.returnValue = null;
  }
});

ipcMain.on('stop-find-in-page', (e, action) => {
  const { sender: webContents } = e;
  if (webContents !== mainWindow?.webContents) {
    const validActions = [
      'clearSelection',
      'keepSelection',
      'activateSelection',
    ];
    if (validActions.includes(action)) {
      webContents.stopFindInPage(action);
    }
  }
  e.returnValue = null;
});

ipcMain.on('set-spellchecker-locales', (_e, { locale, serviceId }) => {
  if (serviceId === undefined) {
    return;
  }

  const serviceSession = session.fromPartition(`persist:service-${serviceId}`);
  const [defaultLocale] = serviceSession.getSpellCheckerLanguages();
  debug(`Spellchecker default locale is: ${defaultLocale}`);

  const locales = [locale, defaultLocale, DEFAULT_APP_SETTINGS.fallbackLocale];
  debug(`Setting spellchecker locales to: ${locales}`);
  serviceSession.setSpellCheckerLanguages(locales);
});

ipcMain.handle('get-desktop-capturer-sources', () =>
  desktopCapturer.getSources({
    types: ['screen', 'window'],
  }),
);

ipcMain.on('window.toolbar-double-clicked', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.on('stop-download', (_e, data) => {
  debug(`stopping download from main process ${data}`);
  mainWindow?.webContents.send('stop-download', data);
});

ipcMain.on('toggle-pause-download', (_e, data) => {
  debug(`stopping download from main process ${data}`);
  mainWindow?.webContents.send('toggle-pause-download', data);
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macos it is common for applications and their menu bar to stay active until the user quits explicitly with Cmd + Q
  if (
    retrieveSettingValue(
      'runInBackground',
      DEFAULT_APP_SETTINGS.runInBackground,
    )
  ) {
    debug('Window: all windows closed, quit app');
    if (!overrideAppQuitForUpdate) {
      // TODO: based on https://github.com/electron-userland/electron-builder/issues/6058#issuecomment-1130344017 (not yet tested since we don't have signed builds yet for macos)
      app.quit();
    }
  } else {
    debug("Window: don't quit app");
  }
});

appEvents.on('install-update', () => {
  willQuitApp = true;
  overrideAppQuitForUpdate = true;
});

app.on('before-quit', event => {
  const yesButtonIndex = 0;
  let selection = yesButtonIndex;
  if (
    retrieveSettingValue('confirmOnQuit', DEFAULT_APP_SETTINGS.confirmOnQuit)
  ) {
    selection = dialog.showMessageBoxSync(mainWindow!, {
      type: 'question',
      message: 'Quit',
      detail: 'Do you really want to quit Ferdium?',
      buttons: ['Yes', 'No'],
    });
  }
  if (selection === yesButtonIndex) {
    willQuitApp = true;
  } else {
    event.preventDefault();
  }
});

app.on('activate', () => {
  // On macos it's common to re-create a window in the app when the dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

app.on('web-contents-created', (_createdEvent, contents) => {
  contents.setWindowOpenHandler(({ disposition }) =>
    disposition === 'foreground-tab' ? { action: 'deny' } : { action: 'allow' },
  );
});

app.on('will-finish-launching', () => {
  // Protocol handler for macOS
  app.on('open-url', (event, url) => {
    event.preventDefault();

    onDidLoad((window: BrowserWindow) => {
      debug('open-url event', url);
      handleDeepLink(window, url);
    });
  });
});

app.on(
  'certificate-error',
  (event, _webContents, _url, _error, certificate, callback) => {
    // On certificate error we disable default behaviour (stop loading the page)
    // and we then say "it is all fine - true" to the callback
    event.preventDefault();

    const useSelfSignedCertificates =
      retrieveSettingValue(
        'useSelfSignedCertificates',
        DEFAULT_APP_SETTINGS.useSelfSignedCertificates,
      ) === true;

    // Check if the certificate is trusted
    if (!useSelfSignedCertificates) {
      callback(false);
      return;
    }

    callback(checkIfCertIsPresent(certificate));
  },
);

ipcMain.on('relaunch-app', async (_, options) => {
  // Ask user to confirm
  const result = await dialog.showMessageBox(mainWindow!, options);

  if (result.response === options.cancelId) {
    return;
  }

  app.relaunch();
  app.quit();
});
