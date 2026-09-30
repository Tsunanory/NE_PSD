import { contextBridge, ipcRenderer } from 'electron';
import { createBridgeApi, type BridgeApi, type IpcChannel } from '../main/ipc-schema.js';

declare global { interface Window { desktop: BridgeApi } }

export const desktopApi = createBridgeApi({
  invoke: (channel: IpcChannel, payload: unknown) => ipcRenderer.invoke(channel, payload),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on('desktop:event', handler);
    return () => ipcRenderer.removeListener('desktop:event', handler);
  },
});
contextBridge.exposeInMainWorld('desktop', desktopApi);
