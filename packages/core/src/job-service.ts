import type { JobService, JobSpec, JobSnapshot, DomainError } from '@ne-psd/contracts';
import type { JobRepository, OutputRootBinding } from './job-repository.js';
import { validateJobSpec } from '@ne-psd/contracts';

export type JobServiceDependencies = { repository: JobRepository; outputRoot: OutputRootBinding };
export function createJobService(dependencies: JobServiceDependencies): JobService {
  const { repository, outputRoot } = dependencies;
  return {
    async validate(spec: JobSpec): Promise<{ valid: boolean; errors: DomainError[] }> { const parsed = validateJobSpec(spec); return parsed.success ? { valid: true, errors: [] } : { valid: false, errors: [{ code: 'INVALID_CONFIGURATION', category: 'validation', message: parsed.error.message, retryable: false, evidencePaths: [] }] }; },
    async start(spec: JobSpec): Promise<{ jobId: string }> { repository.createJob(spec, null, outputRoot); return { jobId: spec.jobId }; },
    async pause(jobId: string): Promise<void> { repository.pause(jobId); },
    async resume(jobId: string): Promise<void> { repository.resume(jobId); },
    async cancel(jobId: string): Promise<void> { repository.cancel(jobId); },
    async retryFailed(jobId: string): Promise<{ jobId: string }> { return repository.retryFailed(jobId); },
    async visualReview(): Promise<null> { return null; },
    async submitVisualAttestation(): Promise<void> { throw new Error('visual attestation is reserved for the review integration'); },
    async snapshot(jobId: string): Promise<JobSnapshot> { return repository.snapshot(jobId); },
    subscribe(jobId: string, listener: (event: import('@ne-psd/contracts').JobEvent) => void): () => void { let active = true; let sequence = 0; const timer = setInterval(() => { if (!active) return; for (const event of repository.events(jobId)) if (event.sequence > sequence) { sequence = event.sequence; listener(event); } }, 250); timer.unref?.(); return () => { active = false; clearInterval(timer); }; },
  };
}
