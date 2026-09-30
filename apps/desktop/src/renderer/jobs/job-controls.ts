import type { JobSnapshot } from '@ne-psd/contracts';

export type JobState = JobSnapshot['state'];
export type JobAction = 'pause' | 'resume' | 'cancel' | 'retry';
export type JobActionHandlers = {
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<{ jobId: string }>;
};
export function controlAvailability(state: JobState): Record<JobAction, boolean> {
  return { pause: state === 'running', resume: state === 'paused', cancel: state === 'running' || state === 'pausing' || state === 'paused', retry: state === 'failed' || state === 'blocked' };
}
export function pendingControl(action: JobAction): { pending: true; message: string } {
  const messages = { pause: 'Завершается текущая операция. Затем обработка остановится', resume: 'Операция возобновляется', cancel: 'Завершается текущая операция. Затем обработка остановится', retry: 'Повторная обработка запрошена' };
  return { pending: true, message: messages[action] };
}
export class JobActionController {
  pending: JobAction | null = null;
  error: string | null = null;
  lastResult: { jobId: string } | null = null;
  private listeners = new Set<() => void>();
  constructor(private handlers: JobActionHandlers) {}
  setHandlers(handlers: JobActionHandlers): void { this.handlers = handlers; }
  listen(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }
  async run(action: JobAction, state: JobState): Promise<void | { jobId: string }> {
    if (this.pending) throw new Error('job action pending');
    if (!controlAvailability(state)[action]) throw new Error('job action unavailable in current state');
    this.pending = action;
    this.error = null;
    this.lastResult = null;
    this.emit();
    try {
      const result = await this.handlers[action]();
      if (action === 'retry') {
        if (!result || typeof result !== 'object' || !('jobId' in result) || typeof result.jobId !== 'string' || !result.jobId) throw new Error('retry successor ID is missing');
        this.lastResult = result;
      }
      return result;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Операция не выполнена';
      throw error;
    } finally {
      this.pending = null;
      this.emit();
    }
  }
}
