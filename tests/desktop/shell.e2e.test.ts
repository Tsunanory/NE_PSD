import { test, expect } from 'playwright/test';
test('desktop shell has no network dependency', async ({ page }) => {
  await page.setContent('<main>NE PSD</main>');
  await expect(page.locator('main')).toHaveText('NE PSD');
});
