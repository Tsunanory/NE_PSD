import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron';
import { ZodError } from 'zod';
import type { JobSpec } from '@ne-psd/contracts';
import { validateEvent, validateRequest, validateResponse, type IpcChannel } from './ipc-schema.js';
import { RootRegistry } from './paths.js';
import type { DesktopServices } from './services.js';
import { packagedRendererUrl } from './window.js';

type Mode = 'development' | 'production';
type Frame = { url: string };

export function assertSender(frame: Frame | null, mode: Mode, sender?: WebContents, trusted?: WebContents): void {
  if (!frame || (trusted && sender !== trusted) || (sender && frame !== sender.mainFrame)) throw new Error('untrusted IPC sender');
  const allowed = mode === 'development' ? /^http:\/\/localhost:5173\/$/.test(frame.url) || frame.url === packagedRendererUrl() : frame.url === packagedRendererUrl();
  if (!allowed) throw new Error('untrusted IPC sender');
}

function safeError(error: unknown): Error {
  if (error instanceof Error && error.message === 'untrusted IPC sender') return new Error('IPC_UNTRUSTED_SENDER: Request rejected.');
  if (error instanceof ZodError) return new Error('IPC_INVALID_DATA: Request or service response did not match its schema.');
  return new Error('IPC_SERVICE_FAILED: Desktop operation failed.');
}

export function registerIpc(
  services: DesktopServices,
  mode: Mode = 'production',
  trustedWindow: () => WebContents | null = () => null,
  roots = new RootRegistry(),
): () => void {
  const channels: IpcChannel[] = [];
  const subscriptions = new Map<string, { sender: WebContents; dispose: () => void }>();
  const register = (channel: IpcChannel, run: (request: never, event: IpcMainInvokeEvent) => Promise<unknown> | unknown): void => {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      try {
        const trusted = trustedWindow();
        if (!trusted) throw new Error('untrusted IPC sender');
        assertSender(event.senderFrame, mode, event.sender, trusted);
        const request = validateRequest(channel, payload);
        return validateResponse(channel, await run(request as never, event));
      } catch (error) { throw safeError(error); }
    });
    channels.push(channel);
  };
  const checkedSpec = (spec: JobSpec): JobSpec => { roots.assertJobSpec(spec); return spec; };
  register('job.validate', ({ spec }: { spec: JobSpec }) => services.jobs.validate(checkedSpec(spec)));
  register('job.start', ({ spec }: { spec: JobSpec }) => services.jobs.start(checkedSpec(spec)));
  register('job.pause', ({ jobId }: { jobId: string }) => services.jobs.pause(jobId));
  register('job.resume', ({ jobId }: { jobId: string }) => services.jobs.resume(jobId));
  register('job.cancel', ({ jobId }: { jobId: string }) => services.jobs.cancel(jobId));
  register('job.snapshot', ({ jobId }: { jobId: string }) => services.jobs.snapshot(jobId));
  register('job.retryFailed', ({ jobId }: { jobId: string }) => services.jobs.retryFailed(jobId));
  register('job.visualReview', ({ jobId, assetId }: { jobId: string; assetId: string }) => services.jobs.visualReview(jobId, assetId));
  register('job.submitVisualAttestation', ({ requestId, decision, notes }: { requestId: string; decision: 'approve' | 'reject'; notes: string }) => services.jobs.submitVisualAttestation(requestId, decision, notes));
  register('job.subscribe', ({ jobId }: { jobId: string }, event) => {
    const subscriptionId = randomUUID();
    const dispose = services.jobs.subscribe(jobId, (value) => {
      if (event.sender.isDestroyed()) return;
      try { event.sender.send('desktop:event', { subscriptionId, event: validateEvent(value) }); }
      catch { /* invalid service event must never reach renderer */ }
    });
    subscriptions.set(subscriptionId, { sender: event.sender, dispose });
    event.sender.once('destroyed', () => {
      if (subscriptions.delete(subscriptionId)) dispose();
    });
    return { subscriptionId };
  });
  register('job.unsubscribe', ({ subscriptionId }: { subscriptionId: string }, event) => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription || subscription.sender !== event.sender) throw new Error('unknown subscription');
    subscription.dispose(); subscriptions.delete(subscriptionId);
  });
  register('setup.inspect', ({ templateHandle, relativePath }: { templateHandle: string; relativePath: string }) =>
    services.setup.inspectTemplate(roots.resolve(templateHandle, relativePath, 'template'), new AbortController().signal));
  register('setup.propose', (request: Parameters<DesktopServices['setup']['proposeConfiguration']>[0]) =>
    services.setup.proposeConfiguration(request, new AbortController().signal));
  register('setup.qualify', ({ inspectionId, proposal, workingTemplateHandle, relativePath }: {
    inspectionId: string; proposal: Parameters<DesktopServices['setup']['qualifyTemplate']>[0]['proposal'];
    workingTemplateHandle: string; relativePath: string;
  }) => services.setup.qualifyTemplate({ inspectionId, proposal, workingTemplatePath: roots.resolve(workingTemplateHandle, relativePath, 'working') }, new AbortController().signal));
  register('setup.inspectModel', ({ profile }: { profile: Parameters<DesktopServices['setup']['inspectModelProfile']>[0] }) =>
    services.setup.inspectModelProfile(profile, new AbortController().signal));
  register('setup.qualifyModel', ({ profile }: { profile: Parameters<DesktopServices['setup']['qualifyModelProfile']>[0] }) =>
    services.setup.qualifyModelProfile(profile, new AbortController().signal));
  register('app.diagnostic', () => ({ available: false }));
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    for (const subscription of subscriptions.values()) subscription.dispose();
    subscriptions.clear();
  };
}
