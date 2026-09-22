import { ipcMain } from 'electron';
import { validateRequest, type IpcChannel } from './ipc-schema.js';
export function registerIpc(services: { jobs: { start(spec: unknown): Promise<unknown> } }): void {
  ipcMain.handle('job.validate', (_event, payload) => validateRequest('job.validate', payload));
  ipcMain.handle('job.start', async (_event, payload) => { const spec = validateRequest('job.start', payload); return services.jobs.start(spec); });
}
export function assertSender(senderFrame: { url: string }, mode: 'development' | 'production'): void {
  if (!(mode === 'development' ? senderFrame.url.startsWith('http://localhost:') : senderFrame.url.startsWith('file:///app/'))) throw new Error('untrusted IPC sender');
}
export type { IpcChannel };
