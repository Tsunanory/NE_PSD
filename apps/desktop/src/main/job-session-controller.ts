import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { JobSnapshotSchema, VisualReviewRequestSchema, type EvidenceBundleManifest, type JobService, type JobSnapshot, type VisualReviewRequest } from '@ne-psd/contracts';
import { readReviewImages as verifyReviewImages, resolveCommittedOutput, type CommittedOutputRecord, type VerifiedReviewImages } from './evidence.js';

const jobIdSchema = z.string().min(1).max(200);
const RecentSchema = z.object({ schemaVersion: z.literal(1), jobIds: z.array(jobIdSchema).max(20),
  retryLinks: z.array(z.object({ from: jobIdSchema, to: jobIdSchema }).strict()).max(20).default([]) }).strict();
type RecentRegistry = z.infer<typeof RecentSchema>;
const MAX_RECENT = 20;
const SAFE_CLOSE_TIMEOUT_MS = 30_000;
const ambiguous = (snapshot: JobSnapshot): boolean => snapshot.assets.some((asset) => asset.status === 'blocked' || asset.error?.category === 'ambiguousState');
const retryBound = (source: JobSnapshot, successor: JobSnapshot): boolean => {
  const failed = source.assets.filter((asset) => asset.status === 'failed');
  return failed.length > 0 && failed.every((asset) => asset.attempt < 2 && successor.assets.some((next) => next.assetId === asset.assetId && next.attempt === asset.attempt + 1));
};

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

  private async registry(): Promise<RecentRegistry> {
    try { return RecentSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { schemaVersion: 1, jobIds: [], retryLinks: [] };
      throw new Error('recent job registry is invalid', { cause: error });
    }
  }

  private queueRegistry(change: (current: RecentRegistry) => Promise<RecentRegistry> | RecentRegistry): Promise<void> {
    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      const next = RecentSchema.parse(await change(await this.registry()));
      await mkdir(this.options.userDataDirectory, { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) {
        const { unlink } = await import('node:fs/promises');
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.pendingWrite = write.catch(() => undefined);
    return write;
  }

  recordStarted(jobId: string): Promise<void> {
    if (!jobIdSchema.safeParse(jobId).success) return Promise.reject(new Error('invalid job ID'));
    return this.queueRegistry((current) => {
      const jobIds = [jobId, ...current.jobIds.filter((id) => id !== jobId)].slice(0, MAX_RECENT);
      return { ...current, jobIds, retryLinks: current.retryLinks.filter((link) => jobIds.includes(link.from) && jobIds.includes(link.to)) };
    });
  }

  recordRetry(from: string, to: string): Promise<void> {
    if (!jobIdSchema.safeParse(from).success || !jobIdSchema.safeParse(to).success || from === to) return Promise.reject(new Error('invalid retry job IDs'));
    return this.queueRegistry(async (current) => {
      if (!current.jobIds.includes(from) || current.jobIds.includes(to) || current.retryLinks.some((link) => link.from === from || link.to === to)) throw new Error('retry link is stale or conflicting');
      const source = JobSnapshotSchema.parse(await this.options.jobs.snapshot(from));
      const successor = JobSnapshotSchema.parse(await this.options.jobs.snapshot(to));
      if (source.jobId !== from || successor.jobId !== to || source.state !== 'failed' || !['ready', 'running', 'pausing', 'paused', 'completed'].includes(successor.state) ||
          ambiguous(source) || ambiguous(successor)) throw new Error('retry source or successor is not safe');
      if (!retryBound(source, successor)) throw new Error('retry successor does not preserve failed attempts');
      const jobIds = [to, ...current.jobIds].slice(0, MAX_RECENT);
      const retryLinks = [...current.retryLinks, { from, to }].filter((link) => jobIds.includes(link.from) && jobIds.includes(link.to));
      return { ...current, jobIds, retryLinks };
    });
  }

  async recentJobs(): Promise<Array<{ jobId: string; snapshot: JobSnapshot }>> {
    await this.pendingWrite;
    const jobs: Array<{ jobId: string; snapshot: JobSnapshot }> = [];
    for (const jobId of (await this.registry()).jobIds) {
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
    const jobs = await this.recentJobs();
    const registry = await this.registry();
    const links = new Map<string, string>();
    for (const link of registry.retryLinks) {
      if (!registry.jobIds.includes(link.from) || !registry.jobIds.includes(link.to) || link.from === link.to || links.has(link.from)) throw new Error('invalid retry recovery link');
      links.set(link.from, link.to);
    }
    for (const start of links.keys()) {
      const visited = new Set<string>();
      let current: string | undefined = start;
      while (current) {
        if (visited.has(current)) throw new Error('cyclic retry recovery link');
        visited.add(current);
        current = links.get(current);
      }
    }
    const safeIds = new Set<string>();
    for (const { jobId, snapshot } of jobs) {
      if (ambiguous(snapshot)) throw new Error('ambiguous job state prevents safe close');
      if (['completed', 'cancelled', 'paused'].includes(snapshot.state)) { safeIds.add(jobId); continue; }
      if (snapshot.state === 'failed') {
        const successor = links.get(jobId);
        if (!successor || !safeIds.has(successor)) throw new Error('job recovery must be resolved before close');
        const currentSuccessor = JobSnapshotSchema.parse(await this.options.jobs.snapshot(successor));
        if (currentSuccessor.jobId !== successor || ambiguous(currentSuccessor) || !retryBound(snapshot, currentSuccessor) || !['paused', 'completed', 'cancelled'].includes(currentSuccessor.state)) throw new Error('retry successor is not safely paused or complete');
        continue;
      }
      if (snapshot.state === 'blocked') throw new Error('job recovery must be resolved before close');
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
      safeIds.add(jobId);
    }
  }
}
