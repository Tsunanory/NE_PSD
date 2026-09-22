import { test, expect } from 'playwright/test';
import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';
test('desktop shell uses isolated preload and fixed IPC', async () => {
  const app = await electron.launch({ args: [resolve('apps/desktop/dist/main/index.js')], env: { ...process.env, NODE_ENV: 'production' } });
  const page = await app.firstWindow();
  await expect(page.locator('h1')).toHaveText('NE PSD');
  expect(await page.evaluate(() => ({ node: typeof process, api: Object.keys((globalThis as { desktop?: Record<string, unknown> }).desktop ?? {}) }))).toEqual({ node: 'undefined', api: expect.arrayContaining(['startJob', 'subscribe']) });
  await app.close();
});
