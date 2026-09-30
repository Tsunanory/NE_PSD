import { test, expect } from './electron-fixture.js';

test('desktop shell uses isolated preload and fixed IPC', async ({ desktopPage }) => {
  await expect(desktopPage.getByRole('heading', { name: 'NE PSD', exact: true })).toBeVisible();
  expect(await desktopPage.evaluate(() => ({ node: typeof process, api: Object.keys((globalThis as { desktop?: Record<string, unknown> }).desktop ?? {}) }))).toEqual({ node: 'undefined', api: expect.arrayContaining(['startJob', 'subscribeJob']) });
});
