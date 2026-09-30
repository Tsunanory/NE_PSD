import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { JobSnapshotSchema, VisualReviewRequestSchema, type EvidenceBundleManifest, type JobService, type JobSnapshot, type VisualReviewRequest } from '@ne-psd/contracts';
import { readReviewImages as verifyReviewImages, resolveCommittedOutput, type CommittedOutputRecord, type VerifiedReviewImages } from './evidence.js';

const RecentSchema = z.object({ schemaVersion: z.literal(1), jobIds: z.array(z.string().min(1).max(200)).max(20) }).strict();
const MAX_RECENT = 20;
const SAFE_CLOSE_TIMEOUT_MS = 30_000;

export type JobEvidenceAdapter = {
  reviewImages(request: VisualReviewRequest): Promise<{ root: string; manifest: EvidenceBundleManifest }>;
  committedOutput(jobId: string, assetId: string): Promise<{ root: string; record: CommittedOutputRecord & { assetId: string } }>;
};
export type JobSessionOptions = {
  jobs: JobService;
  userDataDirectory: string;
  developmentFake: boolean;
  evidenceAdapter?: JobEvidenceAdapter;
};

export class JobSessionController {
  private readonly file: string;
  private pendingWrite: Promise<void> = Promise.resolve();
  constructor(private readonly options: JobSessionOptions) {
    this.file = join(options.userDataDirectory, 'recent-jobs.json');
  }

  private async ids(): Promise<string[]> {
    try { return RecentSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).jobIds; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new Error('recent job registry is invalid', { cause: error });
    }
  }

  recordStarted(jobId: string): Promise<void> {
    if (!jobId || jobId.length > 200) return Promise.reject(new Error('invalid job ID'));
    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      const ids = [jobId, ...(await this.ids()).filter((id) => id !== jobId)].slice(0, MAX_RECENT);
      await mkdir(this.options.userDataDirectory, { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(RecentSchema.parse({ schemaVersion: 1, jobIds: ids })), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) {
        const { unlink } = await import('node:fs/promises');
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.pendingWrite = write;
    return write;
  }

  async recentJobs(): Promise<Array<{ jobId: string; snapshot: JobSnapshot }>> {
    await this.pendingWrite;
    const jobs: Array<{ jobId: string; snapshot: JobSnapshot }> = [];
    for (const jobId of await this.ids()) {
      const snapshot = JobSnapshotSchema.parse(await this.options.jobs.snapshot(jobId));
      if (snapshot.jobId !== jobId) throw new Error('job snapshot ID mismatch');
      jobs.push({ jobId, snapshot });
    }
    return jobs;
  }

  async readReviewImages(jobId: string, assetId: string): Promise<VerifiedReviewImages> {
    const adapter = this.options.evidenceAdapter;
    if (!adapter) throw new Error('verified review evidence adapter unavailable');
    const raw = await this.options.jobs.visualReview(jobId, assetId);
    if (!raw) throw new Error('review request is unavailable');
    const request = VisualReviewRequestSchema.parse(raw);
    if (request.jobId !== jobId || request.assetId !== assetId) throw new Error('review request ID mismatch');
    const { root, manifest } = await adapter.reviewImages(request);
    return { ...await verifyReviewImages(root, request, manifest), synthetic: this.options.developmentFake };
  }

  async committedOutput(jobId: string, assetId: string): Promise<string> {
    const adapter = this.options.evidenceAdapter;
    if (!adapter) throw new Error('verified committed output adapter unavailable');
    const { root, record } = await adapter.committedOutput(jobId, assetId);
    if (record.assetId !== assetId) throw new Error('committed output asset ID mismatch');
    return resolveCommittedOutput(root, jobId, record);
  }

  async safeClose(): Promise<void> {
    for (const { jobId, snapshot } of await this.recentJobs()) {
      if (['completed', 'cancelled', 'paused'].includes(snapshot.state)) continue;
      if (snapshot.state === 'failed' || snapshot.state === 'blocked') throw new Error('job recovery must be resolved before close');
      if (snapshot.state === 'ready' || snapshot.state === 'running') await this.options.jobs.pause(jobId);
      const deadline = Date.now() + SAFE_CLOSE_TIMEOUT_MS;
      let safe = false;
      while (Date.now() < deadline) {
        const current = JobSnapshotSchema.parse(await this.options.jobs.snapshot(jobId));
        if (current.jobId !== jobId) throw new Error('job snapshot ID mismatch');
        if (['paused', 'completed', 'cancelled'].includes(current.state)) { safe = true; break; }
        if (current.state === 'failed' || current.state === 'blocked') throw new Error('job did not reach a safe persisted state');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!safe) throw new Error('timed out waiting for persisted safe job state');
    }
  }
}
