import { randomUUID } from 'node:crypto';
import { app, ipcMain, shell, type WebContents, type IpcMainInvokeEvent } from 'electron';
import { ZodError } from 'zod';
import type { JobSpec } from '@ne-psd/contracts';
import { validateEvent, validateRequest, validateResponse, type IpcChannel } from './ipc-schema.js';
import { RootRegistry } from './paths.js';
import type { DesktopServices } from './services.js';
import { SetupController } from './setup-controller.js';
import { JobSessionController } from './job-session-controller.js';
import { readAssetDetail } from './job-detail.js';
import { FakeJobService, createFakeCorpusSpec } from './fake-job-service.js';
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
  setupController?: SetupController,
  sessions?: JobSessionController,
): () => void {
  const channels: IpcChannel[] = [];
  const subscriptions = new Map<string, { sender: WebContents; dispose: () => void }>();
  const controller = (): SetupController => {
    if (!setupController) throw new Error('native setup controller unavailable');
    return setupController;
  };
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
  const checkedSpec = async (spec: JobSpec): Promise<JobSpec> => {
    roots.assertJobSpec(spec);
    if (setupController) await setupController.assertCurrentSpec(spec);
    return spec;
  };
  register('job.validate', async ({ spec }: { spec: JobSpec }) => services.jobs.validate(await checkedSpec(spec)));
  register('job.start', async ({ spec }: { spec: JobSpec }) => {
    const started = await services.jobs.start(await checkedSpec(spec));
    await sessions?.recordStarted(started.jobId);
    return started;
  });
  register('job.pause', ({ jobId }: { jobId: string }) => services.jobs.pause(jobId));
  register('job.resume', ({ jobId }: { jobId: string }) => services.jobs.resume(jobId));
  register('job.cancel', ({ jobId }: { jobId: string }) => services.jobs.cancel(jobId));
  register('job.snapshot', ({ jobId }: { jobId: string }) => services.jobs.snapshot(jobId));
  register('job.retryFailed', ({ jobId }: { jobId: string }) => services.jobs.retryFailed(jobId));
  register('job.visualReview', ({ jobId, assetId }: { jobId: string; assetId: string }) => services.jobs.visualReview(jobId, assetId));
  register('job.reviewImages', ({ jobId, assetId }: { jobId: string; assetId: string }) => {
    if (!sessions) throw new Error('job session unavailable');
    return sessions.readReviewImages(jobId, assetId);
  });
  register('job.assetDetail', ({ jobId, assetId }: { jobId: string; assetId: string }) =>
    readAssetDetail(services.jobs, services.detailAdapter, jobId, assetId,
      mode === 'development' && services.developmentFake === true && !app.isPackaged));
  register('job.openCommittedOutput', async ({ jobId, assetId }: { jobId: string; assetId: string }) => {
    if (!sessions) throw new Error('job session unavailable');
    const error = await shell.openPath(await sessions.committedOutput(jobId, assetId));
    if (error) throw new Error('committed output could not be opened');
  });
  register('job.recent', () => sessions?.recentJobs() ?? []);
  register('job.submitVisualAttestation', ({ requestId, decision, notes }: { requestId: string; decision: 'approve' | 'reject'; notes: string }) => services.jobs.submitVisualAttestation(requestId, decision, notes));
  register('job.subscribe', ({ jobId }: { jobId: string }, event) => {
    const subscriptionId = randomUUID();
    const dispose = services.jobs.subscribe(jobId, (value) => {
      if (event.sender.isDestroyed()) return;
      try { event.sender.send('desktop:event', { subscriptionId, event: validateEvent(value) }); }
      catch { /* malformed service events never reach renderer */ }
    });
    subscriptions.set(subscriptionId, { sender: event.sender, dispose });
    event.sender.once('destroyed', () => { if (subscriptions.delete(subscriptionId)) dispose(); });
    return { subscriptionId };
  });
  register('job.unsubscribe', ({ subscriptionId }: { subscriptionId: string }, event) => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription || subscription.sender !== event.sender) throw new Error('unknown subscription');
    subscription.dispose(); subscriptions.delete(subscriptionId);
  });
  register('setup.chooseTemplate', () => controller().chooseTemplate());
  register('setup.chooseAssets', () => controller().chooseAssets());
  register('setup.chooseOutput', () => controller().chooseOutput());
  register('setup.catalog', () => controller().catalog());
  register('setup.inspect', ({ templateHandle, relativePath }: { templateHandle: string; relativePath: string }) => {
    if (setupController) {
      const selected = setupController.currentTemplate();
      if (!selected || selected.handle !== templateHandle || selected.relativePath !== relativePath) throw new Error('template selection changed');
      return setupController.inspect();
    }
    return services.setup.inspectTemplate(roots.resolve(templateHandle, relativePath, 'template'), new AbortController().signal);
  });
  register('setup.propose', ({ instruction, inspectionId, modelProfileId }: { instruction: string; inspectionId: string; modelProfileId: string }) => {
    if (setupController) {
      if (setupController.currentInspection()?.inspectionId !== inspectionId) throw new Error('inspection changed');
      return setupController.propose(instruction, modelProfileId);
    }
    return services.setup.proposeConfiguration({ instruction, inspectionId, modelProfileId }, new AbortController().signal);
  });
  register('setup.qualify', ({ proposal }: { proposal: Parameters<SetupController['qualify']>[0] }) => controller().qualify(proposal));
  register('setup.confirmPreviews', ({ profileSha256 }: { profileSha256: string }) => controller().confirmPreviews(profileSha256));
  register('setup.saveCandidate', ({ proposal }: { proposal: Parameters<SetupController['saveCandidate']>[0] }) => controller().saveCandidate(proposal));
  register('setup.loadCandidate', () => controller().loadCandidate());
  register('setup.saveProfile', () => controller().saveProfile());
  register('setup.loadProfile', () => controller().loadProfile());
  register('setup.selectModels', ({ plannerProfileId, reviewerProfileId }: { plannerProfileId: string; reviewerProfileId: string }) => controller().selectModels(plannerProfileId, reviewerProfileId));
  register('setup.inspectModel', ({ profile }: { profile: Parameters<SetupController['inspectModel']>[0] }) => controller().inspectModel(profile));
  register('setup.qualifyModel', ({ profile }: { profile: Parameters<SetupController['qualifyModel']>[0] }) => controller().qualifyModel(profile));
  register('setup.start', async () => {
    const started = await controller().startJob();
    await sessions?.recordStarted(started.jobId);
    return started;
  });
  if (mode === 'development' && services.developmentFake === true && app.isPackaged === false && services.jobs instanceof FakeJobService) {
    register('dev.startFakeCorpus', async ({ count }: { count: number }) => {
      const started = await services.jobs.start(createFakeCorpusSpec(count, `fake-corpus-${randomUUID()}`));
      await sessions?.recordStarted(started.jobId);
      return started;
    });
    register('dev.completeFakeJob', async ({ jobId }: { jobId: string }) => { await (services.jobs as FakeJobService).completeFakeJob(jobId); });
    register('dev.fakeJobMetrics', async ({ jobId }: { jobId: string }) => {
      const fake = services.jobs as FakeJobService;
      const snapshot = await fake.snapshot(jobId);
      return { ...fake.metrics(jobId), state: snapshot.state, complete: snapshot.complete, total: snapshot.total };
    });
  }
  register('app.diagnostic', () => ({ available: false }));
  register('app.safeClose', () => {
    if (!sessions) throw new Error('job session unavailable');
    return sessions.safeClose();
  });
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    for (const subscription of subscriptions.values()) subscription.dispose();
    subscriptions.clear();
  };
}
