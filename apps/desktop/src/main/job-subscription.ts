import { JobEventSchema, type JobEvent, type JobService } from '@ne-psd/contracts';

export class JobEventForwarder {
  private unsubscribe: (() => void) | undefined;
  private generation = 0;
  private sequence = -1;
  constructor(private readonly service: Pick<JobService, 'subscribe'>) {}

  attach(jobId: string, deliver: (event: JobEvent) => void): void {
    if (!jobId) throw new Error('job ID is required');
    const generation = ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.sequence = -1;
    this.unsubscribe = this.service.subscribe(jobId, (value) => {
      if (generation !== this.generation) return;
      const parsed = JobEventSchema.safeParse(value);
      if (!parsed.success || parsed.data.jobId !== jobId || parsed.data.snapshot.jobId !== jobId || parsed.data.sequence <= this.sequence) return;
      this.sequence = parsed.data.sequence;
      deliver(parsed.data);
    });
  }

  dispose(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
