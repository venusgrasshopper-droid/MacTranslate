import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('macTranslateViewer', {
  translateBatch: (items: Array<{ id: string; text: string }>) =>
    ipcRenderer.invoke('message-recognition:translate-batch', { items }),
  openArchive: () => ipcRenderer.invoke('message-recognition:open-message-file'),
});
