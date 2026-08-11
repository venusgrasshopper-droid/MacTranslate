import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import SignalRuntimeHost from '../signal/SignalRuntimeHost';
import installTranGPTPreloadIpc from '../signal/TranGPTPreloadIpc';

export default (params: { mainWindow: BrowserWindow }): void => {
  const host = new SignalRuntimeHost(params.mainWindow);

  ipcMain.handle('signal-host:runtime-status', () => host.runtimeStatus());


  installTranGPTPreloadIpc(params.mainWindow);

  ipcMain.handle('signal-host:ensure', (_event, serviceId: string) =>
    host.ensure(serviceId),
  );

  ipcMain.handle(
    'signal-host:activate',
    (_event, payload: { serviceId: string; bounds: unknown }) =>
      host.activate(payload?.serviceId, payload?.bounds),
  );

  ipcMain.handle('signal-host:deactivate', (_event, serviceId: string) =>
    host.deactivate(serviceId),
  );

  ipcMain.handle(
    'signal-host:set-bounds',
    (_event, payload: { serviceId: string; bounds: unknown }) =>
      host.setBounds(payload?.serviceId, payload?.bounds),
  );

  ipcMain.handle('signal-host:status', (_event, serviceId: string) =>
    host.status(serviceId),
  );

  ipcMain.handle('signal-host:destroy', (_event, serviceId: string) =>
    host.destroy(serviceId),
  );
};
