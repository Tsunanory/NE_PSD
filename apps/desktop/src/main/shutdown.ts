export type CloseChoice = 'safe-pause-and-close' | 'keep-open';
export async function closeActiveJob(choice: CloseChoice, pause: () => Promise<void>, waitForSafeState: () => Promise<void>, closeWindow: () => void): Promise<void> { if (choice === 'keep-open') return; await pause(); await waitForSafeState(); closeWindow(); }
