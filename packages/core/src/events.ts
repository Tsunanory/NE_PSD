import type { JobEvent, JobSnapshot } from '@ne-psd/contracts';

export type EventKind = JobEvent['kind'];
export function makeEvent(jobId: string, sequence: number, kind: EventKind, snapshot: JobSnapshot, timestamp = new Date()): JobEvent {
  return { schemaVersion: 1, jobId, sequence, timestamp: timestamp.toISOString(), kind, snapshot };
}
