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
}, process.env.NODE_ENV === 'development' && process.env.NE_PSD_DEV_FAKE === '1');
contextBridge.exposeInMainWorld('desktop', desktopApi);
