import { test, expect } from './electron-fixture.js';

test('fake development job shell blocks actions without an active job', async ({ desktopPage }) => {
  await expect(desktopPage.getByRole('heading', { name: 'Ход обработки' })).toBeVisible();
  await expect(desktopPage.getByRole('button', { name: 'Приостановить' })).toBeDisabled();
  await expect(desktopPage.getByRole('button', { name: 'Отправить решение' })).toBeDisabled();
});
