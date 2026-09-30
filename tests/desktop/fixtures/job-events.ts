import { JobSnapshotSchema, type AssetStatus, type JobEvent, type JobSnapshot } from '@ne-psd/contracts';

export function jobSnapshot(jobId = 'job-1', state: JobSnapshot['state'] = 'running', total = 2): JobSnapshot {
  return { jobId, state, total, complete: state === 'completed' ? total : 0, failed: 0, blocked: 0,
    assets: Array.from({ length: total }, (_, index) => ({ assetId: `asset-${index}`, status: state === 'completed' ? 'complete' as const : 'queued' as const, attempt: state === 'completed' ? 1 : 0, error: null })) };
}
export function jobEvent(sequence: number, jobId = 'job-1', state: JobSnapshot['state'] = 'running'): JobEvent {
  return { schemaVersion: 1, jobId, sequence, timestamp: '2026-09-30T00:00:00.000Z', kind: 'snapshot', snapshot: jobSnapshot(jobId, state) };
}

export function snapshotForAssetStatus(status: AssetStatus, jobId = `job-${status}`): JobSnapshot {
  const error = status === 'failed' || status === 'blocked'
    ? { code: status.toUpperCase(), category: status === 'blocked' ? 'ambiguousState' as const : 'transient' as const,
      message: `${status} evidence retained`, retryable: status === 'failed', evidencePaths: ['testOnly/jobs/error.json'] }
    : null;
  return JobSnapshotSchema.parse({ jobId,
    state: status === 'complete' ? 'completed' : status === 'failed' ? 'failed' : status === 'blocked' ? 'blocked' : status === 'cancelled' ? 'cancelled' : 'running',
    total: 1, complete: status === 'complete' ? 1 : 0, failed: status === 'failed' ? 1 : 0, blocked: status === 'blocked' ? 1 : 0,
    assets: [{ assetId: 'asset-1', status, attempt: status === 'queued' ? 0 : 1, error }],
  });
}
