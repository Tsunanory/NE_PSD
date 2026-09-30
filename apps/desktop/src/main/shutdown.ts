export type CloseChoice = 'safe-pause-and-close' | 'keep-open';
export type PersistedSafeState = { persisted: boolean; state: 'ready' | 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'blocked' | 'cancelled' };

export async function closeActiveJob(
  choice: CloseChoice,
  pause: () => Promise<void>,
  waitForSafeState: () => Promise<PersistedSafeState>,
  closeWindow: () => void,
): Promise<void> {
  if (choice === 'keep-open') return;
  await pause();
  const safe = await waitForSafeState();
  if (!safe.persisted || !['paused', 'completed', 'cancelled'].includes(safe.state)) throw new Error('job has not reached a persisted safe state');
  closeWindow();
}
