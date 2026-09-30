import { test, expect } from './electron-fixture.js';

type FakeBridge = {
  failFakeJob(request: { jobId: string }): Promise<void>;
  fakeJobMetrics(request: { jobId: string }): Promise<{ activeSubscriptions: number }>;
  snapshotJob(request: { jobId: string }): Promise<{ state: string; assets: Array<{ assetId: string; status: string; attempt: number }> }>;
  safeClose(): Promise<void>;
};

test('failed job rejects unsafe close, then GUI retry selects a safe successor and releases old subscription', async ({ desktopApp, desktopPage }) => {
  test.setTimeout(60_000);
  await desktopPage.getByRole('button', { name: 'Запустить 10 000 тестовых изображений' }).click();
  const oldId = await desktopPage.locator('[data-job-id]').getAttribute('data-job-id') ?? '';
  await desktopPage.evaluate((jobId) => (globalThis as unknown as { desktop: FakeBridge }).desktop.failFakeJob({ jobId }), oldId);
  await expect(desktopPage.getByText('Текущее состояние: failed')).toBeVisible();
  const unsafeCloseRejected = await desktopPage.evaluate(() => (globalThis as unknown as { desktop: FakeBridge }).desktop.safeClose().then(() => false, () => true));
  expect(unsafeCloseRejected).toBe(true);
  await desktopPage.getByRole('button', { name: 'Повторить неудачные' }).click();
  await expect(desktopPage.locator('[data-job-id]')).not.toHaveAttribute('data-job-id', oldId);
  const successorId = await desktopPage.locator('[data-job-id]').getAttribute('data-job-id') ?? '';
  expect(successorId).toContain(`${oldId}-retry-`);
  await expect(desktopPage.getByText('Текущее состояние: running')).toBeVisible();
  const subscriptions = await desktopPage.evaluate(async ({ oldId, successorId }) => {
    const api = (globalThis as unknown as { desktop: FakeBridge }).desktop;
    return [await api.fakeJobMetrics({ jobId: oldId }), await api.fakeJobMetrics({ jobId: successorId })];
  }, { oldId, successorId });
  expect(subscriptions[0]?.activeSubscriptions).toBe(0);
  expect(subscriptions[1]?.activeSubscriptions).toBe(1);
  await desktopPage.getByRole('region', { name: 'Предыдущие попытки задания' }).getByRole('button', { name: `${oldId}: failed` }).click();
  await expect(desktopPage.getByText('Текущее состояние: failed')).toBeVisible();
  await desktopPage.getByRole('button', { name: 'asset-1', exact: true }).click();
  await expect(desktopPage.getByRole('region', { name: 'Детали изображения' }).getByText('synthetic transient failure')).toBeVisible();
  const closed = desktopApp.waitForEvent('close', { timeout: 15_000 }).then(() => true, () => false);
  await desktopPage.getByRole('button', { name: 'Безопасно закрыть' }).click();
  if (!await closed) {
    const diagnostic = { exitCode: desktopApp.process().exitCode, signalCode: desktopApp.process().signalCode, pageClosed: desktopPage.isClosed(), alerts: await desktopPage.getByRole('alert').allTextContents(), successor: await desktopPage.evaluate((jobId) => (globalThis as unknown as { desktop: FakeBridge }).desktop.snapshotJob({ jobId }), successorId).then((state) => ({ state: state.state, firstAsset: state.assets[0] })) };
    const terminated = desktopApp.waitForEvent('close');
    desktopApp.process().kill('SIGKILL');
    await terminated;
    throw new Error(`safe-close did not exit: ${JSON.stringify(diagnostic)}`);
  }
});
