import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadFixture } from '@ne-psd/contracts/testing';
import type { InspectionReport, JobEvent, JobSpec } from '@ne-psd/contracts';
import { RootRegistry } from '../../apps/desktop/src/main/paths.js';
import { packagedRendererUrl } from '../../apps/desktop/src/main/window.js';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>());
const quit = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => handlers.set(channel, handler),
  removeHandler: (channel: string) => handlers.delete(channel),
}, app: { quit, isPackaged: false } }));
import { registerIpc } from '../../apps/desktop/src/main/ipc.js';

const dirs: string[] = [];
afterEach(() => { handlers.clear(); quit.mockClear(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('IPC handlers', () => {
  it('requests application quit only after a successful safe close', async () => {
    const frame = { url: packagedRendererUrl() };
    const sender = { mainFrame: frame, isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
    const event = { sender, senderFrame: frame };
    const safeClose = vi.fn().mockRejectedValueOnce(new Error('ambiguous Photoshop state')).mockResolvedValue(undefined);
    const dispose = registerIpc({ jobs: {}, setup: {} } as never, 'production', () => sender as never,
      new RootRegistry(), undefined, { safeClose } as never);
    await expect(handlers.get('app.safeClose')!(event, {})).rejects.toThrow();
    expect(quit).not.toHaveBeenCalled();
    await expect(handlers.get('app.safeClose')!(event, {})).resolves.toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(quit).toHaveBeenCalledTimes(1);
    await handlers.get('app.safeClose')!(event, {});
    expect(safeClose).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('does not register the fake failure driver in production', () => {
    const dispose = registerIpc({ jobs: {}, setup: {}, developmentFake: true } as never, 'production');
    expect(handlers.has('dev.failFakeJob')).toBe(false);
    dispose();
  });
  it('checks window/frame identity and canonical handles before invoking setup', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ne-psd-ipc-')); dirs.push(parent);
    const root = join(parent, 'template'); const outside = join(parent, 'outside');
    mkdirSync(root); mkdirSync(outside); writeFileSync(join(root, 'master.psd'), 'x'); writeFileSync(join(outside, 'secret.psd'), 'x');
    symlinkSync(outside, join(root, 'linked'));
    const roots = new RootRegistry(); const templateHandle = roots.register('template', root);
    const frame = { url: packagedRendererUrl() };
    const sender = { mainFrame: frame, isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
    const inspectTemplate = vi.fn(async () => loadFixture<InspectionReport>('inspection.live.json'));
    const jobs = { start: vi.fn(), validate: vi.fn(), subscribe: vi.fn(() => () => undefined) };
    const dispose = registerIpc({ jobs, setup: { inspectTemplate } } as never, 'production', () => sender as never, roots);
    const invoke = (payload: unknown, override?: unknown) => handlers.get('setup.inspect')!((override ?? { sender, senderFrame: frame }) as never, payload);
    await expect(invoke({ templateHandle, relativePath: 'master.psd' }, { sender: { mainFrame: frame }, senderFrame: frame })).rejects.toThrow();
    await expect(invoke({ templateHandle, relativePath: 'master.psd' }, { sender, senderFrame: { url: frame.url } })).rejects.toThrow();
    for (const payload of [
      { templatePath: join(root, 'master.psd') },
      { templateHandle, relativePath: '/etc/passwd' },
      { templateHandle, relativePath: '../outside/secret.psd' },
      { templateHandle, relativePath: 'linked/secret.psd' },
      { templateHandle: '00000000-0000-4000-8000-000000000000', relativePath: 'master.psd' },
    ]) await expect(invoke(payload)).rejects.toThrow();
    expect(inspectTemplate).not.toHaveBeenCalled();
    await expect(invoke({ templateHandle, relativePath: 'master.psd' })).resolves.toHaveProperty('inspectionId');
    expect(inspectTemplate).toHaveBeenCalledTimes(1);
    roots.revoke(templateHandle);
    await expect(invoke({ templateHandle, relativePath: 'master.psd' })).rejects.toThrow();
    expect(inspectTemplate).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('refuses unregistered JobSpec roots before touching JobService', async () => {
    const frame = { url: packagedRendererUrl() };
    const sender = { mainFrame: frame, isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
    const start = vi.fn(async () => ({ jobId: 'job-1' }));
    const dispose = registerIpc({ jobs: { start }, setup: {} } as never, 'production', () => sender as never);
    const spec = loadFixture<JobSpec>('job.interactive.json');
    await expect(handlers.get('job.start')!({ sender, senderFrame: frame }, { spec })).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    dispose();
  });

  it('forwards validated events only to the subscribed window and disposes listeners', async () => {
    const frame = { url: packagedRendererUrl() };
    const sender = { mainFrame: frame, isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
    let listener: ((event: JobEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_jobId, callback) => { listener = callback; return unsubscribe; });
    const dispose = registerIpc({ jobs: { subscribe }, setup: {} } as never, 'production', () => sender as never);
    const event = { sender, senderFrame: frame };
    const result = await handlers.get('job.subscribe')!(event, { jobId: 'job-1' }) as { subscriptionId: string };
    expect(subscribe).toHaveBeenCalledWith('job-1', expect.any(Function));
    listener!(loadFixture<JobEvent>('job-event.blocked.json'));
    expect(sender.send).toHaveBeenCalledWith('desktop:event', { subscriptionId: result.subscriptionId, event: expect.objectContaining({ jobId: expect.any(String) }) });
    listener!({ unexpected: true } as never);
    expect(sender.send).toHaveBeenCalledTimes(1);
    await expect(handlers.get('job.unsubscribe')!({ sender: { mainFrame: frame }, senderFrame: frame }, { subscriptionId: result.subscriptionId })).rejects.toThrow();
    await handlers.get('job.unsubscribe')!(event, { subscriptionId: result.subscriptionId });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    dispose();
  });
});
