import { app, BrowserWindow, dialog } from 'electron';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureWebPreferences } from './window-config.js';
import { installWindowPolicy } from './window.js';
import { registerIpc } from './ipc.js';
import { composeServices, resolveDesktopLaunch, type DesktopServices } from './services.js';
import { RootRegistry } from './paths.js';
import { SetupController, type PickerKind } from './setup-controller.js';
import { JobSessionController } from './job-session-controller.js';
import { verifyPackagedResources } from './packaged-runtime.js';

let window: BrowserWindow | null = null;
export function createMainWindow(mode: 'development' | 'production' = 'production', explicitFake = false): BrowserWindow {
  const created = new BrowserWindow({ webPreferences: { ...secureWebPreferences, preload: resolve(dirname(fileURLToPath(import.meta.url)), '../preload/index.cjs'),
    additionalArguments: explicitFake ? ['--ne-psd-dev-fake=1'] : [] } });
  installWindowPolicy(created.webContents, mode);
  if (mode === 'development' && process.env.NE_PSD_DEV_FILE !== '1') void created.loadURL('http://localhost:5173/');
  else void created.loadFile(resolve(dirname(fileURLToPath(import.meta.url)), '../renderer/index.html'));
  created.on('closed', () => { window = null; });
  window = created;
  return created;
}
async function nativeSelect(kind: PickerKind): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: kind === 'template' ? 'Выберите PSD-шаблон' : kind === 'assets' ? 'Выберите папку изображений' : 'Выберите папку результатов',
    properties: kind === 'template' ? ['openFile'] : ['openDirectory'],
    ...(kind === 'template' ? { filters: [{ name: 'PSD', extensions: ['psd'] }] } : {}),
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
}
export function startDesktop(mode: 'development' | 'production' = 'production', injected?: DesktopServices, explicitFake = false): void {
  const launch = resolveDesktopLaunch(mode, app.isPackaged, explicitFake);
  const services = composeServices(launch.mode, injected, launch.fake);
  const lock = app.requestSingleInstanceLock();
  if (!lock) { app.quit(); return; }
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  let disposeIpc: () => void = () => undefined;
  let sessions: JobSessionController | null = null;
  let closingApproved = false;
  let closingPending = false;
  void app.whenReady().then(async () => {
    if (app.isPackaged) await verifyPackagedResources(process.resourcesPath);
    if (!services.models || !services.reviewPolicySha256) throw new Error('setup metadata adapter unavailable');
    const roots = new RootRegistry();
    sessions = new JobSessionController({
      jobs: services.jobs, userDataDirectory: join(app.getPath('userData'), 'jobs'),
      developmentFake: launch.fake && services.developmentFake === true,
      ...(services.evidenceAdapter ? { evidenceAdapter: services.evidenceAdapter } : {}),
    });
    const setup = new SetupController({
      setup: services.setup, jobs: services.jobs, roots,
      pickers: { select: nativeSelect }, userDataDirectory: join(app.getPath('userData'), 'setup'),
      models: services.models, reviewPolicySha256: services.reviewPolicySha256,
      developmentFake: launch.fake && services.developmentFake === true,
      ...(services.previews ? { previews: services.previews } : {}),
      ...(services.prepareLinkedCopy ? { prepareLinkedCopy: services.prepareLinkedCopy } : {}),
    });
    disposeIpc = registerIpc(services, launch.mode, () => window?.webContents ?? null, roots, setup, sessions);
    createMainWindow(launch.mode, launch.fake && services.developmentFake === true);
  }).catch(() => { console.error('DESKTOP_BOOTSTRAP_BLOCKED'); app.quit(); });
  app.on('before-quit', (event) => {
    if (!sessions || closingApproved) { disposeIpc(); return; }
    event.preventDefault();
    if (closingPending) return;
    closingPending = true;
    void sessions.safeClose().then(() => {
      closingApproved = true;
      disposeIpc();
      app.quit();
    }).catch(() => {
      closingPending = false;
      window?.show();
      console.error('DESKTOP_CLOSE_BLOCKED');
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
if (process.env.NODE_ENV !== 'test') {
  const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';
  startDesktop(mode, undefined, mode === 'development' && process.env.NE_PSD_DEV_FAKE === '1');
}
