import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, type WebContents } from 'electron';
import SignalRuntimeHost from './SignalRuntimeHost';
import installTranGPTPreloadIpc from './TranGPTPreloadIpc';

const delay = (milliseconds: number) =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

async function runHomepageWebviewSmokeTest(): Promise<void> {
  const probeWindow = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  let guest: WebContents | null = null;
  try {
    const attached = new Promise<WebContents>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            'MacTranslate homepage service webview was blocked before did-attach-webview.',
          ),
        );
      }, 15_000);

      probeWindow.webContents.once('did-attach-webview', (_event, contents) => {
        clearTimeout(timeout);
        resolve(contents);
      });
    });

    const html = `<!doctype html><html><body><webview id="probe" src="data:text/html,%3Ctitle%3EMacTranslate%20Homepage%20Webview%20OK%3C%2Ftitle%3E" style="width:100%;height:100%"></webview></body></html>`;
    await probeWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    guest = await attached;

    await new Promise<void>((resolve, reject) => {
      if (guest?.isLoading() === false) {
        resolve();
        return;
      }
      const timeout = setTimeout(
        () => reject(new Error('Homepage service webview attached but never finished loading.')),
        15_000,
      );
      guest!.once('did-stop-loading', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    console.log(
      `HOMEPAGE_WEBVIEW_SMOKE_OK ${JSON.stringify({
        webContentsId: guest.id,
        url: guest.getURL(),
      })}`,
    );
  } finally {
    if (guest && !guest.isDestroyed()) {
      guest.close();
    }
    if (!probeWindow.isDestroyed()) {
      probeWindow.destroy();
    }
  }
}

async function waitForQr(
  host: SignalRuntimeHost,
  accountId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let lastInspection: Awaited<ReturnType<SignalRuntimeHost['inspect']>> | null =
    null;

  while (Date.now() < deadline) {
    const status = host.status(accountId);
    if (status.state === 'error') {
      throw new Error(status.error ?? `Signal ${accountId} renderer failed.`);
    }

    if (status.state === 'running') {
      // SignalContext/reduxStore are verified in Electron isolated world 999,
      // matching the official Signal Desktop contextIsolation configuration.
      const inspection = await host.inspect(accountId);
      lastInspection = inspection;
      if (
        inspection.readyState === 'complete' &&
        inspection.hasSignalContext &&
        inspection.userId === accountId &&
        inspection.installerStep === 'QrCodeNotScanned' &&
        inspection.hasQrCandidate
      ) {
        return inspection;
      }
    }
    await delay(250);
  }

  throw new Error(
    `Signal ${accountId} QR startup timed out. Last inspection: ${JSON.stringify(
      lastInspection,
    )}`,
  );
}

export default async function runEmbeddedSignalSmokeTest(): Promise<void> {
  // Keep one host window alive while the homepage probe window is destroyed.
  // Otherwise Ferdium's window-all-closed handler calls app.quit() before the
  // Signal portion of the same smoke test can start.
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  try {
    await runHomepageWebviewSmokeTest();
  } catch (error) {
    console.error(
      'HOMEPAGE_WEBVIEW_SMOKE_FAILED',
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    if (!window.isDestroyed()) {
      window.destroy();
    }
    app.exit(1);
    return;
  }
  installTranGPTPreloadIpc(window);
  const host = new SignalRuntimeHost(window);
  const firstAccount = 'build-smoke-a';
  const secondAccount = 'build-smoke-b';
  const bounds = { x: 0, y: 0, width: 1200, height: 800 };

  try {
    const firstStarted = await host.activate(firstAccount, bounds);
    if (firstStarted.state === 'error') {
      throw new Error(firstStarted.error ?? 'First Signal account failed.');
    }
    const first = await waitForQr(host, firstAccount, 90_000);

    const secondStarted = await host.activate(secondAccount, bounds);
    if (secondStarted.state === 'error') {
      throw new Error(secondStarted.error ?? 'Second Signal account failed.');
    }
    const second = await waitForQr(host, secondAccount, 90_000);

    if (first.webContentsId === second.webContentsId) {
      throw new Error('Signal accounts reused the same WebContents.');
    }
    if (!first.partition || !second.partition || first.partition === second.partition) {
      throw new Error('Signal accounts did not receive isolated partitions.');
    }
    if (first.provisioningUrl === second.provisioningUrl) {
      throw new Error('Signal accounts unexpectedly received the same QR URL.');
    }

    const firstDatabase = join(
      app.getPath('userData'),
      'signals',
      firstAccount,
      'sql',
      'db.sqlite',
    );
    const secondDatabase = join(
      app.getPath('userData'),
      'signals',
      secondAccount,
      'sql',
      'db.sqlite',
    );
    if (!existsSync(firstDatabase) || !existsSync(secondDatabase)) {
      throw new Error(
        `Signal account databases were not created: ${JSON.stringify({
          firstDatabase,
          firstExists: existsSync(firstDatabase),
          secondDatabase,
          secondExists: existsSync(secondDatabase),
        })}`,
      );
    }
    if (firstDatabase === secondDatabase) {
      throw new Error('Signal accounts reused the same database path.');
    }

    host.destroy(firstAccount);
    if (host.status(firstAccount).state !== 'stopped') {
      throw new Error('Destroyed Signal account did not stop.');
    }
    if (host.status(secondAccount).state !== 'running') {
      throw new Error('Destroying one Signal account stopped the other account.');
    }

    host.destroy(secondAccount);
    console.log(
      `SIGNAL_SMOKE_OK ${JSON.stringify({
        version: firstStarted.version,
        accounts: [
          {
            id: firstAccount,
            webContentsId: first.webContentsId,
            partition: first.partition,
            database: firstDatabase,
          },
          {
            id: secondAccount,
            webContentsId: second.webContentsId,
            partition: second.partition,
            database: secondDatabase,
          },
        ],
      })}`,
    );
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(
      'SIGNAL_SMOKE_FAILED',
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    try {
      host.destroy(firstAccount);
      host.destroy(secondAccount);
    } catch {
      // Ignore teardown errors in a failing smoke test.
    }
    if (!window.isDestroyed()) {
      window.destroy();
    }
    app.exit(1);
  }
}
