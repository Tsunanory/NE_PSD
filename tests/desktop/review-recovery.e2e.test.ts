import { test, expect } from './electron-fixture.js';

test('verified synthetic images require an explicit human attestation', async ({ desktopPage }) => {
  await desktopPage.getByRole('button', { name: 'Запустить 10 000 тестовых изображений' }).click();
  await desktopPage.getByRole('button', { name: 'asset-1', exact: true }).click();
  const detail = desktopPage.getByRole('region', { name: 'Детали изображения' });
  await expect(detail.getByRole('img', { name: 'Вариант 1' })).toBeVisible();
  await expect(detail.getByRole('img', { name: 'Вариант 2' })).toBeVisible();
  await expect(detail.getByRole('img', { name: 'Вариант 3' })).toBeVisible();
  await expect(detail.getByRole('img', { name: 'Контактный лист трёх вариантов' })).toBeVisible();
  await expect(detail.getByText('Синтетические изображения режима разработки', { exact: false })).toBeVisible();
  await expect(detail.getByText('История решений, детерминированные проверки и диагностические доказательства: неизвестно')).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Отправить решение' })).toBeDisabled();
  await detail.getByRole('button', { name: 'Отклонить' }).click();
  await detail.getByRole('textbox', { name: 'Примечание' }).fill('Недостаточная читаемость');
  await detail.getByRole('button', { name: 'Отправить решение' }).click();
  await expect(detail.getByText('Решение получено сервисом', { exact: false })).toBeVisible();
  await desktopPage.getByRole('button', { name: 'Отменить' }).click();
});

test('renderer reload recovers a paused job and safe-close exits', async ({ desktopApp, desktopPage }) => {
  await desktopPage.getByRole('button', { name: 'Запустить 10 000 тестовых изображений' }).click();
  const jobId = await desktopPage.locator('[data-job-id]').getAttribute('data-job-id');
  await desktopPage.getByRole('button', { name: 'Приостановить' }).click();
  await expect(desktopPage.getByText('Текущее состояние: paused')).toBeVisible();
  await desktopPage.reload();
  await expect(desktopPage.getByRole('region', { name: 'Недавние задания' }).getByRole('button', { name: `${jobId}: paused` })).toBeVisible();
  await desktopPage.getByRole('region', { name: 'Недавние задания' }).getByRole('button', { name: `${jobId}: paused` }).click();
  await expect(desktopPage.getByText('Текущее состояние: paused')).toBeVisible();
  const closed = desktopApp.waitForEvent('close');
  await desktopPage.getByRole('button', { name: 'Безопасно закрыть' }).click();
  await closed;
});

test('completed job allows explicit safe-close exit', async ({ desktopApp, desktopPage }) => {
  await desktopPage.getByRole('button', { name: 'Запустить 10 000 тестовых изображений' }).click();
  const jobId = await desktopPage.locator('[data-job-id]').getAttribute('data-job-id') ?? '';
  await desktopPage.evaluate((id) => (globalThis as unknown as { desktop: { completeFakeJob(request: { jobId: string }): Promise<void> } }).desktop.completeFakeJob({ jobId: id }), jobId);
  await expect(desktopPage.getByText('Текущее состояние: completed')).toBeVisible();
  const closed = desktopApp.waitForEvent('close');
  await desktopPage.getByRole('button', { name: 'Безопасно закрыть' }).click();
  await closed;
});
