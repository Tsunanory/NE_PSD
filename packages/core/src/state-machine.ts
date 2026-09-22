import type { AssetStatus, JobSnapshot } from '@ne-psd/contracts';

export class StateMachineError extends Error { readonly code = 'INVALID_TRANSITION'; constructor(message: string) { super(message); this.name = 'StateMachineError'; } }
const transitions: Record<AssetStatus, readonly AssetStatus[]> = {
  queued: ['rendering', 'cancelled'], rendering: ['reviewing', 'failed', 'blocked', 'cancelled'], reviewing: ['readyToCommit', 'failed', 'blocked', 'cancelled'], readyToCommit: ['complete', 'failed', 'cancelled'], complete: [], failed: ['queued', 'cancelled'], blocked: ['reviewing', 'queued', 'cancelled'], cancelled: [],
};
export function transitionAllowed(from: AssetStatus, to: AssetStatus): boolean { return transitions[from].includes(to); }
export function assertAssetTransition(from: AssetStatus, to: AssetStatus): void { if (!transitionAllowed(from, to)) throw new StateMachineError(`cannot transition asset ${from} to ${to}`); }
export function assertSnapshotCounters(snapshot: JobSnapshot): void {
  const assets = snapshot.assets; const count = (status: AssetStatus) => assets.filter((asset) => asset.status === status).length;
  if (snapshot.total !== assets.length || snapshot.complete !== count('complete') || snapshot.failed !== count('failed') || snapshot.blocked !== count('blocked')) throw new Error('snapshot counters do not match asset rows');
}
