import { test, expect } from './electron-fixture.js';

type FakeDesktop = {
  startFakeCorpus(request: { count: number }): Promise<{ jobId: string }>;
  completeFakeJob(request: { jobId: string }): Promise<void>;
  fakeJobMetrics(request: { jobId: string }): Promise<{ activeSubscriptions: number; eventCount: number; lastSequence: number }>;
  snapshotJob(request: { jobId: string }): Promise<{ state: string; total: number; complete: number; assets: unknown[] }>;
};
const fake = () => (globalThis as unknown as { desktop: FakeDesktop }).desktop;

async function frameP95(page: import('playwright').Page): Promise<number> {
  return page.evaluate(async () => {
    const deltas: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 20; i++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const now = performance.now(); deltas.push(now - previous); previous = now;
    }
    return deltas.sort((a, b) => a - b)[Math.floor(deltas.length * .95)] ?? Infinity;
  });
}

test('10,000 fake assets render bounded rows and preserve the final snapshot', async ({ desktopApp, desktopPage }, testInfo) => {
  test.setTimeout(120_000);
  const rssBefore = await desktopApp.evaluate(() => process.memoryUsage().rss);
  const started = await desktopPage.evaluate(async () => {
    const begin = performance.now();
    const { jobId } = await fake().startFakeCorpus({ count: 10_000 });
    return { jobId, startMs: performance.now() - begin };
  });
  await expect(desktopPage.getByText('0 / 10000 завершено', { exact: false })).toBeVisible();
  expect(await desktopPage.locator('[data-asset-id]').count()).toBeLessThanOrEqual(50);
  const initial = await desktopPage.evaluate(jobId => fake().fakeJobMetrics({ jobId }), started.jobId);
  expect(initial.activeSubscriptions).toBe(1);
  const frameMsP95 = await frameP95(desktopPage);
  await desktopPage.getByRole('button', { name: 'Приостановить' }).click();
  await expect(desktopPage.getByText('Текущее состояние: paused')).toBeVisible();
  await desktopPage.getByRole('button', { name: 'Продолжить' }).click();
  await expect(desktopPage.getByText('Текущее состояние: running')).toBeVisible();
  await desktopPage.evaluate(jobId => fake().completeFakeJob({ jobId }), started.jobId);
  await expect(desktopPage.getByText('10000 / 10000 завершено', { exact: false })).toBeVisible();
  const final = await desktopPage.evaluate(jobId => fake().snapshotJob({ jobId }), started.jobId);
  const metrics = await desktopPage.evaluate(jobId => fake().fakeJobMetrics({ jobId }), started.jobId);
  expect(final).toMatchObject({ state: 'completed', total: 10_000, complete: 10_000 });
  expect(final.assets).toHaveLength(10_000);
  expect(metrics.activeSubscriptions).toBe(1);
  expect(metrics.lastSequence).toBeGreaterThan(initial.lastSequence);
  expect(metrics.eventCount).toBeGreaterThanOrEqual(4);
  expect(await desktopPage.locator('[data-asset-id]').count()).toBeLessThanOrEqual(50);
  const rssAfter = await desktopApp.evaluate(() => process.memoryUsage().rss);
  expect(frameMsP95).toBeLessThan(1000);
  await testInfo.attach('endurance-metrics', { body: JSON.stringify({ count: 10_000, startMs: started.startMs, frameMsP95, rssBefore, rssAfter, activeSubscriptions: metrics.activeSubscriptions, lastSequence: metrics.lastSequence, eventCount: metrics.eventCount }, null, 2), contentType: 'application/json' });
});

test('cancel a 10,000-asset fake job through the GUI', async ({ desktopPage }) => {
  test.setTimeout(120_000);
  const { jobId } = await desktopPage.evaluate(() => fake().startFakeCorpus({ count: 10_000 }));
  await expect(desktopPage.getByText('0 / 10000 завершено', { exact: false })).toBeVisible();
  await desktopPage.getByRole('button', { name: 'Отменить' }).click();
  await expect(desktopPage.getByText('Текущее состояние: cancelled')).toBeVisible();
  const snapshot = await desktopPage.evaluate(id => fake().snapshotJob({ jobId: id }), jobId);
  expect(snapshot.state).toBe('cancelled');
  expect(snapshot.assets).toHaveLength(10_000);
  expect(await desktopPage.locator('[data-asset-id]').count()).toBeLessThanOrEqual(50);
});
