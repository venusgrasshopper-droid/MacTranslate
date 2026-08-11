import { app, ipcMain, Notification, type BrowserWindow } from 'electron';
import { getSignalAccountIdForWebContents } from './EmbeddedSignalEngine';

let installed = false;

export default function installTranGPTPreloadIpc(
  mainWindow: BrowserWindow,
): void {
  if (installed) {
    return;
  }
  installed = true;

  // servicePreloadSignal generates `${feature}:${method}` channels and wraps
  // all method arguments in a single array.
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getSettings', () => '{}');
  ipcMain.handle('appService:getSelfSession', () => null);

  ipcMain.handle('notification:send', (event, args: unknown) => {
    const values = Array.isArray(args) ? args : [];
    const [title, body, requestedAccountId, silent] = values;
    const accountId = getSignalAccountIdForWebContents(event.sender);

    if (
      !accountId ||
      requestedAccountId !== accountId ||
      !Notification.isSupported()
    ) {
      return false;
    }

    const notification = new Notification({
      title: typeof title === 'string' && title.trim() ? title : 'Signal',
      body: typeof body === 'string' ? body : '',
      silent: silent === true,
    });
    notification.on('click', () => {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    });
    notification.show();
    return true;
  });
}
