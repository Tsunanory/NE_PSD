import { test, expect } from './electron-fixture.js';

test('fake development model setup shows requested identity and blocked state', async ({ desktopPage }) => {
  await expect(desktopPage.getByText('Запрошенная модель: Qwen3.8-27B')).toBeVisible();
  await expect(desktopPage.getByText('Модель не проверяет изображение визуально')).toBeVisible();
  await expect(desktopPage.getByText('Рецензент изображений не выбран. Автоматическая проверка изображений недоступна.')).toBeVisible();
  await expect(desktopPage.getByText('Метаданные, KV-кэш, runtime и память Photoshop не включены.')).toBeVisible();
});
