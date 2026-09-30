import { test, expect } from './electron-fixture.js';

test('selected local model shows qualification evidence after recheck', async ({ desktopPage }) => {
  await desktopPage.getByRole('combobox', { name: 'Планировщик' }).selectOption({ index: 1 });
  await desktopPage.getByRole('combobox', { name: 'Рецензент' }).selectOption({ index: 1 });
  await expect(desktopPage.getByText('Запрошенная модель: Qwen3.8-27B')).toBeVisible();
  await desktopPage.getByRole('button', { name: 'Выбрать роли моделей' }).click();
  await desktopPage.getByRole('button', { name: 'Проверить планировщик' }).click();
  await desktopPage.getByRole('button', { name: 'Проверить рецензента' }).click();
  await expect(desktopPage.getByRole('region', { name: 'Настройка модели' }).getByText('Квалификация')).toHaveCount(2);
  await expect(desktopPage.getByText('Автоматическая проверка изображений недоступна')).toBeVisible();
});
