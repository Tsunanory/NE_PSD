import { test, expect } from './electron-fixture.js';

test('job controls appear only after a connected job starts', async ({ desktopPage }) => {
  await expect(desktopPage.getByRole('heading', { name: 'Ход обработки' })).toHaveCount(0);
  await desktopPage.getByRole('button', { name: 'Запустить 10 000 тестовых изображений' }).click();
  await expect(desktopPage.getByRole('heading', { name: 'Ход обработки' })).toBeVisible();
  await expect(desktopPage.getByRole('button', { name: 'Приостановить' })).toBeEnabled();
  await expect(desktopPage.locator('[data-asset-id]')).toHaveCount(50);
  await desktopPage.getByRole('button', { name: 'Отменить' }).click();
  await expect(desktopPage.getByText('Текущее состояние: cancelled')).toBeVisible();
});
