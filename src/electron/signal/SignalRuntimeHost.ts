/* eslint-disable @typescript-eslint/no-explicit-any */

import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { ipcMain, Menu, shell, WebContentsView, type BrowserWindow } from 'electron';
import { signalContextMenuTemplate } from './signalContextMenu';
import {
  bindSignalWebContents,
  embeddedSignalPreparationError,
  getEmbeddedSignalRuntimePaths,
  getSignalAccountIdForWebContents,
  unbindSignalWebContents,
  waitForEmbeddedSignalEngine,
} from './EmbeddedSignalEngine';

const debug = require('../../preload-safe-debug')('MacTranslate:SignalHost');

export type SignalHostState = 'stopped' | 'starting' | 'running' | 'error';

export interface SignalHostStatus {
  serviceId: string;
  state: SignalHostState;
  error: string | null;
  version: string | null;
}

interface SignalRoute {
  key: string;
  args?: Record<string, any>;
}

interface HostBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizeServiceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Signal service ID is invalid.');
  }
  return value;
}

function normalizeBounds(value: unknown): HostBounds {
  const bounds = value as Partial<HostBounds>;
  const result = {
    x: Math.round(Number(bounds?.x)),
    y: Math.round(Number(bounds?.y)),
    width: Math.round(Number(bounds?.width)),
    height: Math.round(Number(bounds?.height)),
  };

  if (
    !Number.isFinite(result.x) ||
    !Number.isFinite(result.y) ||
    !Number.isFinite(result.width) ||
    !Number.isFinite(result.height) ||
    result.width < 100 ||
    result.height < 100
  ) {
    throw new Error('Signal view bounds are invalid.');
  }

  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

class SignalAccountView {
  private readonly serviceId: string;

  private readonly parentWindow: BrowserWindow;

  private readonly notify: (status: SignalHostStatus) => void;

  private readonly paths = getEmbeddedSignalRuntimePaths();

  private view: WebContentsView | null = null;

  private state: SignalHostState = 'stopped';

  private error: string | null = null;

  private bounds: HostBounds | null = null;

  private active = false;

  private startPromise: Promise<SignalHostStatus> | null = null;

  private partition = '';

  constructor(
    serviceId: string,
    parentWindow: BrowserWindow,
    notify: (status: SignalHostStatus) => void,
  ) {
    this.serviceId = serviceId;
    this.parentWindow = parentWindow;
    this.notify = notify;
  }

  status(): SignalHostStatus {
    return {
      serviceId: this.serviceId,
      state: this.state,
      error: this.error,
      version: this.paths.version,
    };
  }

  private setState(state: SignalHostState, error: string | null = null): void {
    this.state = state;
    this.error = error;
    this.notify(this.status());
  }

  private attachView(view: WebContentsView): void {
    this.parentWindow.contentView.addChildView(view);
    view.setVisible(this.active);
    this.applyBounds();
  }

  private applyBounds(): void {
    if (!this.view || !this.bounds) {
      return;
    }
    this.view.setBounds(this.bounds);
  }

  private routeSignalUrl(url: string): boolean {
    if (!/^(?:sgnl|signal|signalcaptcha):/i.test(url)) {
      return false;
    }

    void waitForEmbeddedSignalEngine()
      .then(api => {
        const route = api.parseSignalRoute?.(url) as SignalRoute | null;
        const contents = this.view?.webContents;
        if (!route || !contents || contents.isDestroyed()) {
          return;
        }

        const args = route.args ?? {};
        switch (route.key) {
          case 'captcha':
            api.handleCaptcha?.(String(args.captchaId ?? ''), contents);
            break;
          case 'artAddStickers':
            contents.send('show-sticker-pack', {
              packId: args.packId,
              packKey: Buffer.from(String(args.packKey ?? ''), 'hex').toString(
                'base64',
              ),
            });
            break;
          case 'groupInvites':
            contents.send('show-group-via-link', { value: args.inviteCode });
            break;
          case 'contactByPhoneNumber':
            contents.send('show-conversation-via-signal.me', {
              kind: 'phoneNumber',
              value: args.phoneNumber,
            });
            break;
          case 'contactByEncryptedUsername':
            contents.send('show-conversation-via-signal.me', {
              kind: 'encryptedUsername',
              value: args.encryptedUsername,
            });
            break;
          case 'showConversation':
            contents.send('show-conversation-via-token', args.token);
            break;
          case 'startCallLobby':
            contents.send('start-call-lobby', { token: args.token });
            break;
          case 'linkCall':
            contents.send('start-call-link', { key: args.key });
            break;
          case 'showWindow':
            this.parentWindow.show();
            this.parentWindow.focus();
            break;
          case 'cancelPresenting':
            contents.send('cancel-presenting');
            break;
          case 'donationValidationComplete':
            contents.send('donation-validation-complete', args);
            break;
          case 'donationPaypalApproved':
            contents.send('donation-paypal-approved', args);
            break;
          case 'donationPaypalCanceled':
            contents.send('donation-paypal-canceled', args);
            break;
          default:
            contents.send('unknown-sgnl-link');
            break;
        }
      })
      .catch(error => this.setState('error', errorText(error)));
    return true;
  }

  private wireLifecycle(view: WebContentsView): void {
    const contents = view.webContents;

    contents.setWindowOpenHandler(({ url }) => {
      if (this.routeSignalUrl(url)) {
        return { action: 'deny' };
      }
      if (/^https?:/i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    contents.on('context-menu', (_event, params) => {
      const template = signalContextMenuTemplate(contents, params);
      if (template.length > 0) {
        Menu.buildFromTemplate(template).popup({ window: this.parentWindow });
      }
    });

    contents.on('will-navigate', (event, url) => {
      if (this.routeSignalUrl(url)) {
        event.preventDefault();
      }
    });

    contents.on('will-redirect', (event, url) => {
      if (this.routeSignalUrl(url)) {
        event.preventDefault();
      }
    });

    contents.on('did-finish-load', () => {
      // TranGPT's embedded Signal renderer starts only after this message.
      // The preload also reads the same account synchronously through get-user-id.
      contents.send('set-user-id', this.serviceId);
      contents.send('set-window-focus', this.isLookedAt());
      this.setState('running');
    });

    contents.on('console-message', (...args: any[]) => {
      const details = args.length === 2 && typeof args[1] === 'object' ? args[1] : null;
      const message = String(details?.message ?? args[2] ?? '');
      if (
        /ReferenceError:\s*(?:Buffer|process) is not defined/i.test(message)
      ) {
        this.setState(
          'error',
          `Signal preload environment failed: ${message}`,
        );
      }
    });

    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
          return;
        }
        this.setState(
          'error',
          `Signal failed to load (${errorCode}): ${errorDescription}\n${validatedURL}`,
        );
      },
    );

    contents.on('render-process-gone', (_event, details) => {
      this.setState(
        'error',
        `Signal renderer exited: ${details.reason}${
          typeof details.exitCode === 'number' ? ` (${details.exitCode})` : ''
        }`,
      );
    });

    contents.on('unresponsive', () => {
      this.setState('error', 'Signal renderer is not responding.');
    });

    contents.on('responsive', () => {
      if (!contents.isDestroyed()) {
        this.setState('running');
      }
    });

    contents.once('destroyed', () => {
      unbindSignalWebContents(contents);
      if (this.view === view) {
        this.view = null;
      }
      if (this.state !== 'error') {
        this.setState('stopped');
      }
    });
  }

  async start(): Promise<SignalHostStatus> {
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.status();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<SignalHostStatus> {
    this.setState('starting');

    try {
      const preparationError = embeddedSignalPreparationError();
      if (preparationError) {
        throw preparationError;
      }
      for (const required of [
        this.paths.preloadEntry,
        this.paths.backgroundEntry,
      ]) {
        if (!existsSync(required)) {
          throw new Error(`Signal runtime file is missing: ${required}`);
        }
      }

      const engine = await waitForEmbeddedSignalEngine();
      const partition = `persist:mactranslate-signal-${this.serviceId}`;
      this.partition = partition;
      const view = new WebContentsView({
        webPreferences: {
          partition,
          preload: this.paths.preloadEntry,
          // Signal Desktop 8.x and TranGPT run the official preload in an
          // isolated, non-sandboxed preload world. Running this preload with
          // contextIsolation disabled leaves renderer code without the Node
          // globals used by Signal's preload bundle (Buffer/process).
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          contextIsolation: true,
          sandbox: false,
          spellcheck: true,
          backgroundThrottling: true,
          enableBlinkFeatures: 'CSSPseudoDir,CSSLogical',
          enablePreferredSizeMode: true,
          disableBlinkFeatures:
            'Accelerated2dCanvas,AcceleratedSmallCanvases',
        },
      });

      this.view = view;
      bindSignalWebContents(view.webContents, this.serviceId);
      this.wireLifecycle(view);
      this.attachView(view);

      await engine.registerProtocolFor?.(
        view.webContents.session,
        this.serviceId,
      );
      await engine.initSql?.(this.serviceId);
      await view.webContents.loadFile(this.paths.backgroundEntry);
    } catch (error) {
      debug('Signal account failed to start', this.serviceId, error);
      this.disposeView();
      this.setState('error', errorText(error));
    }

    return this.status();
  }

  async activate(bounds?: HostBounds): Promise<SignalHostStatus> {
    this.active = true;
    if (bounds) {
      this.bounds = bounds;
    }
    if (!this.view || this.view.webContents.isDestroyed()) {
      await this.start();
    }
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.applyBounds();
      this.view.setVisible(true);
      this.view.webContents.send('set-window-focus', this.isLookedAt());
      this.view.webContents.focus();
    }
    return this.status();
  }

  // Signal suppresses notifications while it believes it is focused, so it is
  // only "focused" when it is the shown service AND MacTranslate is in front.
  private isLookedAt(): boolean {
    return (
      this.active &&
      !this.parentWindow.isDestroyed() &&
      this.parentWindow.isFocused() &&
      this.parentWindow.isVisible() &&
      !this.parentWindow.isMinimized()
    );
  }

  updateFocus(): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('set-window-focus', this.isLookedAt());
    }
  }

  deactivate(): SignalHostStatus {
    this.active = false;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.send('set-window-focus', false);
      this.view.setVisible(false);
    }
    return this.status();
  }

  setBounds(bounds: HostBounds): SignalHostStatus {
    this.bounds = bounds;
    this.applyBounds();
    return this.status();
  }

  async inspect(): Promise<{
    readyState: string;
    title: string;
    bodyLength: number;
    bodyText: string;
    hasSignalContext: boolean;
    userId: string | null;
    installerStep: string | null;
    provisioningUrl: string | null;
    hasQrCandidate: boolean;
    webContentsId: number;
    partition: string;
  }> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      throw new Error('Signal account view is not available.');
    }

    const contents = this.view.webContents;
    const domState = await contents.executeJavaScript(`(() => ({
      readyState: document.readyState,
      title: document.title,
      bodyLength: document.body?.innerText?.trim().length ?? 0,
      bodyText: document.body?.innerText?.trim().slice(0, 1200) ?? '',
    }))()`);

    // Electron reserves isolated world 999 for contextIsolation. Signal's
    // preload owns SignalContext, userId and reduxStore in that world; probing
    // the page's main world would incorrectly report them as missing.
    const preloadState = await contents.executeJavaScriptInIsolatedWorld(999, [
      {
        code: `(() => {
          const state = globalThis.reduxStore?.getState?.();
          const installerStep = state?.installer?.step ?? null;
          const provisioningUrl = state?.installer?.provisioningUrl?.value ?? null;
          return {
            hasSignalContext: Boolean(globalThis.SignalContext),
            userId: typeof globalThis.userId === 'string' ? globalThis.userId : null,
            installerStep,
            provisioningUrl:
              typeof provisioningUrl === 'string' ? provisioningUrl : null,
            hasQrCandidate:
              installerStep === 'QrCodeNotScanned' &&
              typeof provisioningUrl === 'string' &&
              provisioningUrl.length > 20,
          };
        })()`,
      },
    ]);

    return {
      ...domState,
      ...(preloadState ?? {
        hasSignalContext: false,
        userId: null,
        installerStep: null,
        provisioningUrl: null,
        hasQrCandidate: false,
      }),
      webContentsId: contents.id,
      partition: this.partition,
    };
  }

  private disposeView(): void {
    const view = this.view;
    this.view = null;
    if (!view) {
      return;
    }

    try {
      this.parentWindow.contentView.removeChildView(view);
    } catch {
      // Parent window may already be tearing down.
    }

    try {
      if (!view.webContents.isDestroyed()) {
        unbindSignalWebContents(view.webContents);
        view.webContents.close({ waitForBeforeUnload: false });
      }
    } catch (error) {
      debug('Failed to close Signal view', this.serviceId, error);
    }
  }

  destroy(): SignalHostStatus {
    this.active = false;
    this.disposeView();
    this.setState('stopped');
    return this.status();
  }
}

export default class SignalRuntimeHost {
  private readonly parentWindow: BrowserWindow;

  private readonly accounts = new Map<string, SignalAccountView>();

  private activeServiceId: string | null = null;

  constructor(parentWindow: BrowserWindow) {
    this.parentWindow = parentWindow;

    parentWindow.on('hide', () => this.hideAll());
    parentWindow.on('minimize', () => this.hideAll());
    parentWindow.on('show', () => this.showActive());
    parentWindow.once('closed', () => this.destroyAll());
    for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const) {
      parentWindow.on(event as any, () => this.updateFocus());
    }

    // Signal reports its unread count by sending 'set-badge' to its main
    // process; forward it so the account's sidebar icon shows it.
    ipcMain.on('set-badge', (event, value: number | string) => {
      const serviceId = getSignalAccountIdForWebContents(event.sender);
      if (!serviceId || parentWindow.isDestroyed()) return;
      parentWindow.webContents.send('signal-host:badge', serviceId, value);
    });
  }

  private updateFocus(): void {
    for (const account of this.accounts.values()) account.updateFocus();
  }

  runtimeStatus(): {
    installed: boolean;
    root: string;
    version: string | null;
    electronVersion: string | null;
    error: string | null;
  } {
    const paths = getEmbeddedSignalRuntimePaths();
    const preparationError = embeddedSignalPreparationError();
    const required = [
      paths.mainEntry,
      paths.preloadEntry,
      paths.backgroundEntry,
    ];
    const missing = required.filter(path => !existsSync(path));

    return {
      installed: missing.length === 0 && !preparationError,
      root: paths.root,
      version: paths.version,
      electronVersion: paths.electronVersion,
      error: preparationError
        ? errorText(preparationError)
        : missing.length > 0
          ? `Missing Signal runtime files: ${missing.join(', ')}`
          : null,
    };
  }

  private account(serviceId: string): SignalAccountView {
    const id = normalizeServiceId(serviceId);
    let account = this.accounts.get(id);
    if (!account) {
      account = new SignalAccountView(id, this.parentWindow, status => {
        if (!this.parentWindow.isDestroyed()) {
          this.parentWindow.webContents.send('signal-host:state', status);
        }
      });
      this.accounts.set(id, account);
    }
    return account;
  }

  async ensure(serviceId: string): Promise<SignalHostStatus> {
    return this.account(serviceId).start();
  }

  async activate(serviceId: string, bounds: unknown): Promise<SignalHostStatus> {
    const id = normalizeServiceId(serviceId);
    if (this.activeServiceId && this.activeServiceId !== id) {
      this.accounts.get(this.activeServiceId)?.deactivate();
    }
    this.activeServiceId = id;
    return this.account(id).activate(normalizeBounds(bounds));
  }

  deactivate(serviceId: string): SignalHostStatus {
    const id = normalizeServiceId(serviceId);
    if (this.activeServiceId === id) {
      this.activeServiceId = null;
    }
    return this.accounts.get(id)?.deactivate() ?? this.stoppedStatus(id);
  }

  setBounds(serviceId: string, bounds: unknown): SignalHostStatus {
    const id = normalizeServiceId(serviceId);
    return (
      this.accounts.get(id)?.setBounds(normalizeBounds(bounds)) ??
      this.stoppedStatus(id)
    );
  }

  status(serviceId: string): SignalHostStatus {
    const id = normalizeServiceId(serviceId);
    return this.accounts.get(id)?.status() ?? this.stoppedStatus(id);
  }

  async inspect(serviceId: string): Promise<{
    readyState: string;
    title: string;
    bodyLength: number;
    hasSignalContext: boolean;
    userId: string | null;
    installerStep: string | null;
    provisioningUrl: string | null;
    hasQrCandidate: boolean;
    webContentsId: number;
    partition: string;
  }> {
    const id = normalizeServiceId(serviceId);
    const account = this.accounts.get(id);
    if (!account) {
      throw new Error(`Signal account is not running: ${id}`);
    }
    return account.inspect();
  }

  destroy(serviceId: string): SignalHostStatus {
    const id = normalizeServiceId(serviceId);
    if (this.activeServiceId === id) {
      this.activeServiceId = null;
    }
    const account = this.accounts.get(id);
    if (!account) {
      return this.stoppedStatus(id);
    }
    const status = account.destroy();
    this.accounts.delete(id);
    return status;
  }

  private stoppedStatus(serviceId: string): SignalHostStatus {
    return {
      serviceId,
      state: 'stopped',
      error: null,
      version: getEmbeddedSignalRuntimePaths().version,
    };
  }

  private hideAll(): void {
    for (const account of this.accounts.values()) {
      account.deactivate();
    }
  }

  private showActive(): void {
    if (this.activeServiceId) {
      void this.accounts.get(this.activeServiceId)?.activate();
    }
  }

  private destroyAll(): void {
    for (const account of this.accounts.values()) {
      account.destroy();
    }
    this.accounts.clear();
    this.activeServiceId = null;
  }
}
