import React, { useEffect, useRef, useState } from 'react';
import { JobActionController, controlAvailability, pendingControl, type JobAction, type JobActionHandlers, type JobState } from './job-controls.js';

const LABELS: Record<JobAction, string> = { pause: 'Приостановить', resume: 'Продолжить', cancel: 'Отменить', retry: 'Повторить неудачные' };
export function JobControls({ state, handlers, onRetrySuccess }: { state: JobState; handlers?: JobActionHandlers | undefined; onRetrySuccess?: ((jobId: string) => void) | undefined }): React.ReactElement {
  const [, redraw] = useState(0);
  const controller = useRef<JobActionController | null>(null);
  if (handlers && !controller.current) controller.current = new JobActionController(handlers);
  if (handlers) controller.current?.setHandlers(handlers);
  useEffect(() => controller.current?.listen(() => redraw((value) => value + 1)), [Boolean(handlers)]);
  const availability = controlAvailability(state);
  const active = controller.current;
  async function perform(action: JobAction): Promise<void> {
    if (!active) return;
    try {
      const result = await active.run(action, state);
      if (action === 'retry' && result && onRetrySuccess) onRetrySuccess(result.jobId);
    } catch { /* The controller exposes the service error without changing authoritative state. */ }
  }
  return <div aria-label="Управление заданием">
    {(['pause', 'resume', 'cancel', 'retry'] as const).map((action) =>
      <button key={action} type="button" disabled={!handlers || !availability[action] || active?.pending !== null && active?.pending !== undefined}
        onClick={() => void perform(action)}>{LABELS[action]}</button>)}
    {active?.pending && <p role="status">{pendingControl(active.pending).message}</p>}
    {active?.error && <p role="alert">{active.error}</p>}
  </div>;
}
