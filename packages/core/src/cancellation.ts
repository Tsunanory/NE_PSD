export type OperationCancellation = { signal: AbortSignal; deadline: Promise<'timeout'>; cancel(reason?: string): void; timedOut(): boolean; dispose(): void };

export function createOperationCancellation(timeoutMs: number, parent?: AbortSignal): OperationCancellation {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort(); else parent?.addEventListener('abort', onAbort, { once: true });
  let expired = false;
  let resolveDeadline!: (value: 'timeout') => void;
  const deadline = new Promise<'timeout'>((resolve) => { resolveDeadline = resolve; });
  const timer = setTimeout(() => { expired = true; controller.abort('deadline'); resolveDeadline('timeout'); }, Math.max(1, timeoutMs));
  timer.unref?.();
  const dispose = () => { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); };
  return { signal: controller.signal, deadline, cancel: (reason = 'cancelled') => controller.abort(reason), timedOut: () => expired, dispose };
}
