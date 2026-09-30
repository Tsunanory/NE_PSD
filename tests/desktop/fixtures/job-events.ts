import type { JobEvent, JobSnapshot } from '@ne-psd/contracts';

export function jobSnapshot(jobId = 'job-1', state: JobSnapshot['state'] = 'running', total = 2): JobSnapshot {
  return { jobId, state, total, complete: state === 'completed' ? total : 0, failed: 0, blocked: 0,
    assets: Array.from({ length: total }, (_, index) => ({ assetId: `asset-${index}`, status: state === 'completed' ? 'complete' as const : 'queued' as const, attempt: state === 'completed' ? 1 : 0, error: null })) };
}
export function jobEvent(sequence: number, jobId = 'job-1', state: JobSnapshot['state'] = 'running'): JobEvent {
  return { schemaVersion: 1, jobId, sequence, timestamp: '2026-09-30T00:00:00.000Z', kind: 'snapshot', snapshot: jobSnapshot(jobId, state) };
}
