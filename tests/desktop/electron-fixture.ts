import { test as base } from 'playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const executablePath = require('electron') as string;
const entry = resolve('apps/desktop/dist/main/index.js');

export const test = base.extend<{ desktopApp: ElectronApplication; desktopPage: Page }>({
  desktopApp: async ({}, use) => {
    const app = await electron.launch({ executablePath, args: [entry], env: { ...process.env, NODE_ENV: 'development', NE_PSD_DEV_FAKE: '1', NE_PSD_DEV_FILE: '1' } });
    try { await use(app); } finally { await app.close(); }
  },
  desktopPage: async ({ desktopApp }, use) => { await use(await desktopApp.firstWindow()); },
});
export { expect } from 'playwright/test';
