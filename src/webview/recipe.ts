/* eslint-disable global-require */
/* eslint-disable import/no-dynamic-require */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  disable as disableDarkMode,
  enable as enableDarkMode,
} from 'darkreader';
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { pathExistsSync, readFileSync } from 'fs-extra';
import { debounce, noop } from 'lodash';
import { autorun, computed, makeObservable, observable } from 'mobx';

import customDarkModeCss from './darkmode/custom';
import ignoreList from './darkmode/ignore';

import RecipeWebview from './lib/RecipeWebview';
import Userscript from './lib/Userscript';

import BadgeHandler from './badge';
import contextMenu from './contextMenu';
import {
  darkModeStyleExists,
  injectDarkModeStyle,
  isDarkModeStyleInjected,
  removeDarkModeStyle,
} from './darkmode';
import DialogTitleHandler from './dialogTitle';
import FindInPage from './find';
import {
  NotificationsHandler,
  notificationsClassDefinition,
} from './notifications';
import { getDisplayMediaSelector, screenShareJs } from './screenshare';
import SessionHandler from './sessionHandler';
import {
  getSpellcheckerLocaleByFuzzyIdentifier,
  switchDict,
} from './spellchecker';

import type { AppStore } from '../@types/stores.types';
import { DEFAULT_APP_SETTINGS } from '../config';
import { cleanseJSObject, ifUndefined, safeParseInt } from '../jsUtils';
import type Service from '../models/Service';

// For some services darkreader tries to use the chrome extension message API
// This will cause the service to fail loading
// As the message API is not actually needed, we'll add this shim sendMessage
// function in order for darkreader to continue working
// @ts-expect-error Fix this
window.chrome.runtime.sendMessage = noop;

const debug = require('../preload-safe-debug')('Ferdium:Plugin');

const prepareTelegramHttpTransportBeforeBootstrap = () => {
  if (
    window.location.hostname.toLowerCase() !== 'web.telegram.org' ||
    !window.location.pathname.startsWith('/a')
  ) {
    return;
  }

  const marker = '__mactranslateTelegramOfficialHttpTransportV1';
  let markerValue: string | null = null;
  try {
    markerValue = window.sessionStorage.getItem(marker);
  } catch {
    return;
  }

  // On the second load the official Telegram cached setting is already in IDB,
  // so let Telegram bootstrap normally and consume it in loadCachedSharedState().
  if (markerValue === 'ready' || markerValue === 'failed') {
    return;
  }

  // Preload runs before page scripts. Stop this first load so Telegram cannot
  // construct MTProtoSender with the default WebSocket transport before the
  // official shared-state flags have been persisted.
  window.stop();

  const DB_NAME = 'tt-data';
  const STORE_NAME = 'store';
  const STATE_KEY = 'tt-shared-state';
  let finished = false;

  const reload = (state: 'ready' | 'failed') => {
    if (finished) return;
    finished = true;
    try {
      window.sessionStorage.setItem(marker, state);
    } catch {
      // Continue with the reload even if sessionStorage is unavailable.
    }
    window.location.reload();
  };

  // Never leave the service on a stopped/blank document if storage is blocked.
  const timeout = window.setTimeout(() => reload('failed'), 5000);

  try {
    // idb-keyval's createStore('tt-data', 'store') opens this DB without a
    // caller-specified version. Do the same so we never force an IDB upgrade.
    const request = window.indexedDB.open(DB_NAME);

    request.onerror = () => {
      window.clearTimeout(timeout);
      reload('failed');
    };

    request.onupgradeneeded = () => {
      // A fresh Telegram profile has no cached shared state yet. Do not create
      // a partial Telegram state object; let Telegram initialize it itself.
      try {
        request.transaction?.abort();
      } catch {
        // noop
      }
      window.clearTimeout(timeout);
      reload('failed');
    };

    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        window.clearTimeout(timeout);
        reload('failed');
        return;
      }

      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const getRequest = store.get(STATE_KEY);
      let wroteSettings = false;

      getRequest.onsuccess = () => {
        const sharedState = getRequest.result;
        if (!sharedState || typeof sharedState !== 'object') {
          return;
        }

        const current = sharedState as Record<string, any>;
        const settings =
          current.settings && typeof current.settings === 'object'
            ? current.settings
            : {};

        store.put(
          {
            ...current,
            settings: {
              ...settings,
              // These are Telegram Web A's own experimental transport flags.
              shouldAllowHttpTransport: true,
              shouldForceHttpTransport: true,
            },
          },
          STATE_KEY,
        );
        wroteSettings = true;
      };

      getRequest.onerror = () => {
        // transaction completion below will select the safe failure path.
      };

      transaction.oncomplete = () => {
        db.close();
        window.clearTimeout(timeout);
        reload(wroteSettings ? 'ready' : 'failed');
      };

      transaction.onerror = () => {
        db.close();
        window.clearTimeout(timeout);
        reload('failed');
      };

      transaction.onabort = () => {
        db.close();
        window.clearTimeout(timeout);
        reload('failed');
      };
    };
  } catch {
    window.clearTimeout(timeout);
    reload('failed');
  }
};

prepareTelegramHttpTransportBeforeBootstrap();

const installTeamsBareTrustedEventRejectionGuard = () => {
  const host = window.location.hostname.toLowerCase();
  if (
    host !== 'teams.live.com' &&
    host !== 'teams.microsoft.com' &&
    host !== 'teams.cloud.microsoft'
  ) {
    return;
  }

  // teams-for-linux documents the same unrelated Teams global-handler event:
  // `Unhandled error/rejection {"isTrusted": true}`. Install before Teams page
  // scripts and consume only that bare DOM Event rejection. Errors, strings,
  // and objects carrying a message/name/stack are deliberately left untouched.
  const code = `
    (() => {
      if (window.__mactranslateTeamsBareEventGuardInstalled) return;
      window.__mactranslateTeamsBareEventGuardInstalled = true;

      const isBareTrustedEvent = value => {
        if (!value || typeof value !== 'object') return false;
        if (value instanceof Error) return false;
        if (value.isTrusted !== true) return false;
        if (typeof value.message === 'string' && value.message.length > 0) return false;
        if (typeof value.name === 'string' && value.name.length > 0) return false;
        if (typeof value.stack === 'string' && value.stack.length > 0) return false;
        return true;
      };

      window.addEventListener('unhandledrejection', event => {
        if (!isBareTrustedEvent(event.reason)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);

      window.addEventListener('error', event => {
        if (!isBareTrustedEvent(event.error)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    })();
  `;

  void webFrame
    .executeJavaScriptInIsolatedWorld(0, [{ code }])
    .catch(() => undefined);
};

installTeamsBareTrustedEventRejectionGuard();

const badgeHandler = new BadgeHandler();

const dialogTitleHandler = new DialogTitleHandler();

const sessionHandler = new SessionHandler();

const notificationsHandler = new NotificationsHandler();

// Patching window.open
const originalWindowOpen = window.open;

window.open = (url, frameName, features): WindowProxy | null => {
  debug('window.open', url, frameName, features);
  if (!url) {
    // The service hasn't yet supplied a URL (as used in Skype).
    // Return a new dummy window object and wait for the service to change the properties
    const newWindow = {
      location: {
        href: '',
      },
    };

    const checkInterval = setInterval(() => {
      // Has the service changed the URL yet?
      if (newWindow.location.href !== '') {
        if (features) {
          originalWindowOpen(newWindow.location.href, frameName, features);
        } else {
          // Open the new URL
          ipcRenderer.sendToHost('new-window', newWindow.location.href);
        }
        clearInterval(checkInterval);
      }
    }, 0);

    setTimeout(() => {
      // Stop checking for location changes after 1 second
      clearInterval(checkInterval);
    }, 1000);

    return newWindow as Window;
  }

  // We need to differentiate if the link should be opened in a popup or in the systems default browser
  if (!frameName && !features && typeof features !== 'string') {
    ipcRenderer.sendToHost('new-window', url);
    return null;
  }

  if (url) {
    return originalWindowOpen(url, frameName, features);
  }
  return null;
};

// We can't override APIs here, so we first expose functions via 'window.ferdium',
// then overwrite the corresponding field of the window object by injected JS.
contextBridge.exposeInMainWorld('ferdium', {
  open: window.open,
  setBadge: (
    direct: string | number | null | undefined,
    indirect: string | number | null | undefined,
  ) => badgeHandler.setBadge(direct, indirect),
  safeParseInt: (text: string | number | null | undefined) =>
    safeParseInt(text),
  setDialogTitle: (title: string | null | undefined) =>
    dialogTitleHandler.setDialogTitle(title),
  displayNotification: (title: string, options: any) => {
    return notificationsHandler.displayNotification(
      title,
      // The following line is needed so that a proper clone of the "options" object is made.
      // This line was causing issues with some services.
      cleanseJSObject(options),
    );
  },
  getDisplayMediaSelector,
});

ipcRenderer.sendToHost(
  'inject-js-unsafe',
  'window.open = window.ferdium.open;',
  notificationsClassDefinition,
  screenShareJs,
);

class RecipeController {
  @observable settings: {
    overrideSpellcheckerLanguage: boolean;
    app: AppStore;
    service: Service;
  } = {
    overrideSpellcheckerLanguage: false,
    // @ts-expect-error Fix this
    app: DEFAULT_APP_SETTINGS,
    // @ts-expect-error Fix this
    service: {
      isDarkModeEnabled: false,
      spellcheckerLanguage: '',
    },
  };

  ipcEvents = {
    'initialize-recipe': 'loadRecipeModule',
    'settings-update': 'updateAppSettings',
    'service-settings-update': 'updateServiceSettings',
    'get-service-id': 'serviceIdEcho',
    'find-in-page': 'openFindInPage',
    'toggle-to-talk': 'toggleToTalk',
  };

  universalDarkModeInjected = false;

  recipe: RecipeWebview | null = null;

  userscript: Userscript | null = null;

  hasUpdatedBeforeRecipeLoaded = false;

  domReadyUpdateScheduled = false;

  constructor() {
    makeObservable(this);

    this.initialize();
  }

  @computed get spellcheckerLanguage() {
    return ifUndefined<string>(
      this.settings.service.spellcheckerLanguage,
      this.settings.app.spellcheckerLanguage,
    );
  }

  findInPage: FindInPage | null = null;

  async initialize() {
    for (const channel of Object.keys(this.ipcEvents)) {
      ipcRenderer.on(channel, (...args) => {
        debug('Received IPC event for channel', channel, 'with', ...args);
        this[this.ipcEvents[channel]](...args);
      });
    }

    debug('Send "hello" to host');
    setTimeout(() => ipcRenderer.sendToHost('hello'), 100);

    contextMenu(
      () => this.settings.app.enableSpellchecking,
      () => this.settings.app.spellcheckerLanguage,
      () => this.spellcheckerLanguage,
      () => this.settings.app.searchEngine,
      () => this.settings.app.clipboardNotifications,
      () => this.settings.app.enableTranslator,
      () => this.settings.app.translatorEngine,
      () => this.settings.app.translatorLanguage,
    );

    autorun(() => this.update());

    document.addEventListener('DOMContentLoaded', () => {
      this.findInPage = new FindInPage({
        inputFocusColor: '#CE9FFC',
        textColor: '#212121',
      });
    });

    // Add ability to go forward or back with mouse buttons (inside the recipe)
    window.addEventListener('mouseup', e => {
      if (e.button === 3) {
        e.preventDefault();
        e.stopPropagation();
        window.history.back();
      } else if (e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
        window.history.forward();
      }
    });
  }

  loadRecipeModule(_event, config, recipe) {
    debug('loadRecipeModule');
    const modulePath = join(recipe.path, 'webview.js');
    debug('module path', modulePath);
    // Delete module from cache
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete require.cache[require.resolve(modulePath)];
    try {
      this.recipe = new RecipeWebview(
        badgeHandler,
        dialogTitleHandler,
        notificationsHandler,
        sessionHandler,
      );
      if (existsSync(modulePath)) {
        require(modulePath)(this.recipe, { ...config, recipe });
        debug('Initialize Recipe', config, recipe);
      }

      this.settings.service = Object.assign(config, { recipe });

      // Make sure to update the WebView, otherwise the custom darkmode handler may not be used
      this.update();
    } catch (error) {
      console.error('Recipe initialization failed', error);
    }

    this.loadUserFiles(recipe, config);
  }

  async loadUserFiles(recipe, config) {
    const styles = document.createElement('style');

    const userCss = join(recipe.path, 'user.css');
    if (pathExistsSync(userCss)) {
      const data = readFileSync(userCss);
      styles.innerHTML += data.toString();
      debug('Loaded user.css from: ', userCss);
    }
    document.querySelector('head')?.append(styles);

    const userJs = join(recipe.path, 'user.js');
    if (pathExistsSync(userJs)) {
      const loadUserJs = () => {
        const userJsModule = require(userJs);

        if (typeof userJsModule === 'function') {
          this.userscript = new Userscript(this.recipe, this, config);
          userJsModule(config, this.userscript);
        }
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          loadUserJs();
        });
      } else {
        loadUserJs();
      }
    }
  }

  openFindInPage() {
    this.findInPage?.openFindWindow();
  }

  update() {
    // MobX autorun can fire from the preload before <head>/<body> exist.
    // DarkReader and some recipe dark-mode handlers assume a live DOM and used
    // to throw null.removeAttribute/null.classList during service startup.
    if (!document.documentElement || !document.head || !document.body) {
      if (!this.domReadyUpdateScheduled) {
        this.domReadyUpdateScheduled = true;
        document.addEventListener(
          'DOMContentLoaded',
          () => {
            this.domReadyUpdateScheduled = false;
            this.update();
          },
          { once: true },
        );
      }
      return;
    }

    debug('enableSpellchecking', this.settings.app.enableSpellchecking);
    debug('isDarkModeEnabled', this.settings.service.isDarkModeEnabled);
    debug(
      'System spellcheckerLanguage',
      this.settings.app.spellcheckerLanguage,
    );
    debug(
      'Service spellcheckerLanguage',
      this.settings.service.spellcheckerLanguage,
    );
    debug('darkReaderSettigs', this.settings.service.darkReaderSettings);
    debug('searchEngine', this.settings.app.searchEngine);
    debug('enableTranslator', this.settings.app.enableTranslator);
    debug('translatorEngine', this.settings.app.translatorEngine);
    debug('translatorLanguage', this.settings.app.translatorLanguage);

    if (this.userscript?.internal_setSettings) {
      this.userscript.internal_setSettings(this.settings);
    }

    if (this.settings.app.enableSpellchecking) {
      let { spellcheckerLanguage } = this;
      debug(`Setting spellchecker language to ${spellcheckerLanguage}`);
      if (spellcheckerLanguage.includes('automatic')) {
        this.automaticLanguageDetection();
        debug(
          'Found `automatic` locale, falling back to user locale until detected',
          this.settings.app.locale,
        );
        spellcheckerLanguage = this.settings.app.locale;
      }
      switchDict(spellcheckerLanguage, this.settings.service.id);
    } else {
      debug('Disable spellchecker');
    }

    if (!this.recipe) {
      this.hasUpdatedBeforeRecipeLoaded = true;
    }

    debug(
      'Darkmode enabled?',
      this.settings.service.isDarkModeEnabled,
      'Dark theme active?',
      // @ts-expect-error Fix this
      this.settings.app.isDarkThemeActive,
    );

    const handlerConfig = {
      removeDarkModeStyle,
      disableDarkMode,
      enableDarkMode,
      injectDarkModeStyle: () =>
        injectDarkModeStyle(this.settings.service.recipe.path),
      isDarkModeStyleInjected,
    };

    if (this.settings.service.isDarkModeEnabled) {
      debug('Enable dark mode');

      // Check if recipe has a custom dark mode handler
      if (this.recipe?.darkModeHandler) {
        debug('Using custom dark mode handler');

        // Remove other dark mode styles if they were already loaded
        if (this.hasUpdatedBeforeRecipeLoaded) {
          this.hasUpdatedBeforeRecipeLoaded = false;
          removeDarkModeStyle();
          disableDarkMode();
        }

        this.recipe.darkModeHandler(true, handlerConfig);
      } else if (darkModeStyleExists(this.settings.service.recipe.path)) {
        debug('Injecting darkmode from recipe');
        injectDarkModeStyle(this.settings.service.recipe.path);

        // Make sure universal dark mode is disabled
        disableDarkMode();
        this.universalDarkModeInjected = false;
      } else if (
        this.settings.app.universalDarkMode &&
        !ignoreList.includes(window.location.host)
      ) {
        debug('Injecting Dark Reader');

        // Use Dark Reader instead
        const { brightness, contrast, sepia } =
          this.settings.service.darkReaderSettings;
        enableDarkMode(
          { brightness, contrast, sepia },
          {
            css: customDarkModeCss[window.location.host] || '',
            invert: [],
            ignoreImageAnalysis: [],
            ignoreInlineStyle: [],
            disableStyleSheetsProxy: false,
          },
        );
        this.universalDarkModeInjected = true;
      }
    } else {
      debug('Remove dark mode');
      debug('DarkMode disabled - removing remaining styles');

      if (this.recipe?.darkModeHandler) {
        // Remove other dark mode styles if they were already loaded
        if (this.hasUpdatedBeforeRecipeLoaded) {
          this.hasUpdatedBeforeRecipeLoaded = false;
          removeDarkModeStyle();
          disableDarkMode();
        }

        this.recipe.darkModeHandler(false, handlerConfig);
      } else if (isDarkModeStyleInjected()) {
        debug('Removing injected darkmode from recipe');
        removeDarkModeStyle();
      } else {
        debug('Removing Dark Reader');

        disableDarkMode();
        this.universalDarkModeInjected = false;
      }
    }

    // Remove dark reader if (universal) dark mode was just disabled
    if (
      this.universalDarkModeInjected &&
      (!this.settings.app.darkMode ||
        !this.settings.service.isDarkModeEnabled ||
        !this.settings.app.universalDarkMode)
    ) {
      disableDarkMode();
      this.universalDarkModeInjected = false;
    }
  }

  updateAppSettings(_event, data) {
    this.settings.app = Object.assign(this.settings.app, data);
  }

  updateServiceSettings(_event, data) {
    this.settings.service = Object.assign(this.settings.service, data);
  }

  serviceIdEcho(event) {
    debug('Received a service echo ping');
    event.sender.send('service-id', this.settings.service.id);
  }

  async automaticLanguageDetection() {
    window.addEventListener(
      'keyup',
      debounce(async e => {
        const element = e.target;

        if (!element) return;

        let value = '';
        if (element.isContentEditable) {
          value = element.textContent;
        } else if (element.value) {
          value = element.value;
        }

        // Force a minimum length to get better detection results
        if (value.length < 25) return;

        debug('Detecting language for', value);
        const locale = await ipcRenderer.invoke('detect-language', {
          sample: value,
        });
        if (!locale) {
          return;
        }

        const spellcheckerLocale =
          getSpellcheckerLocaleByFuzzyIdentifier(locale);
        debug(
          'Language detected reliably, setting spellchecker language to',
          spellcheckerLocale,
        );
        if (spellcheckerLocale) {
          switchDict(spellcheckerLocale, this.settings.service.id);
        }
      }, 225),
    );
  }

  toggleToTalk() {
    this.recipe?.toggleToTalkFunc?.();
  }
}

/* eslint-disable no-new */
new RecipeController();
