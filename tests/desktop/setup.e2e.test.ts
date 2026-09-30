import { test, expect } from './electron-fixture.js';

test('fake development setup labels unqualified template', async ({ desktopPage }) => {
  await expect(desktopPage.getByRole('heading', { name: 'Настройка шаблона' })).toBeVisible();
  await expect(desktopPage.getByText('Синтетические данные; шаблон не квалифицирован')).toBeVisible();
  for (const id of ['1', '2', '3']) await expect(desktopPage.getByRole('figure', { name: `Синтетический вариант ${id}` })).toBeVisible();
});
