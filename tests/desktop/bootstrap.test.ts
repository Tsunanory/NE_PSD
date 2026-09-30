import { expect, it, vi } from 'vitest';

const whenReady = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { whenReady }, BrowserWindow: vi.fn(), dialog: {} }));

it('exposes the production bootstrap without starting Electron on import', async () => {
  const { startDesktop } = await import('../../apps/desktop/src/main/bootstrap.js');
  expect(startDesktop).toBeTypeOf('function');
  expect(whenReady).not.toHaveBeenCalled();
});
