import { FakeJobService as ContractFakeJobService, FakeSetupService as ContractFakeSetupService } from '@ne-psd/contracts/testing';
export class FakeJobService extends ContractFakeJobService {
  private readonly sequences = new Map<string, number>();
  override async start(spec: Parameters<ContractFakeJobService['start']>[0]): Promise<{ jobId: string }> {
    const result = await super.start(spec);
    this.sequences.set(result.jobId, 1);
    return result;
  }
  override async pause(jobId: string): Promise<void> { await super.pause(jobId); this.sequences.set(jobId, (this.sequences.get(jobId) ?? 0) + 1); }
  override async resume(jobId: string): Promise<void> { await super.resume(jobId); this.sequences.set(jobId, (this.sequences.get(jobId) ?? 0) + 1); }
  override async snapshot(jobId: string): Promise<any> {
    const snapshot = await super.snapshot(jobId);
    return Object.freeze({ ...snapshot, sequence: this.sequences.get(jobId) ?? 0 });
  }
}
export class FakeSetupService extends ContractFakeSetupService {
  async state(name: string): Promise<'ready' | 'blocked'> {
    return name === 'valid-text-only-model' ? 'ready' : 'blocked';
  }
  readonly supportedStates = ['duplicate-layer-names', 'missing-target', 'unqualified-template', 'unsupported-contain', 'unsupported-stretch', 'missing-model', 'valid-text-only-model', 'invalid-artifact-digest'] as const;
}
