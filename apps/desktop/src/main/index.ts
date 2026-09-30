import { app, BrowserWindow } from 'electron';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureWebPreferences } from './window-config.js';
import { installWindowPolicy } from './window.js';
import { registerIpc } from './ipc.js';
import { composeServices, type DesktopServices } from './services.js';

let window: BrowserWindow | null = null;
export function createMainWindow(mode: 'development' | 'production' = 'production'): BrowserWindow {
  const created = new BrowserWindow({ webPreferences: { ...secureWebPreferences, preload: resolve(dirname(fileURLToPath(import.meta.url)), '../preload/index.cjs') } });
  installWindowPolicy(created.webContents, mode);
  if (mode === 'development' && process.env.NE_PSD_DEV_FILE !== '1') void created.loadURL('http://localhost:5173/');
  else void created.loadFile(resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/index.html'));
  created.on('closed', () => { window = null; });
  window = created;
  return created;
}
export function startDesktop(mode: 'development' | 'production' = 'production', injected?: DesktopServices, explicitFake = false): void {
  const services = composeServices(mode, injected, explicitFake);
  const lock = app.requestSingleInstanceLock();
  if (!lock) { app.quit(); return; }
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  const disposeIpc = registerIpc(services, mode, () => window?.webContents ?? null);
  void app.whenReady().then(() => createMainWindow(mode));
  app.on('before-quit', disposeIpc);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
if (process.env.NODE_ENV !== 'test') {
  const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';
  startDesktop(mode, undefined, mode === 'development' && process.env.NE_PSD_DEV_FAKE === '1');
}
