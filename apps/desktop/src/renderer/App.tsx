import React, { useEffect, useMemo, useState } from 'react';
import type { JobEvent, VisualReviewRequest } from '@ne-psd/contracts';
import type { VerifiedReviewImages } from '../main/evidence.js';
import { SetupWizard } from './setup/SetupWizard.js';
import { JobView } from './jobs/JobView.js';
import { ReviewEvidence } from './jobs/ReviewEvidence.js';
import { JobStore } from './jobs/job-store.js';

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : 'Задание недоступно';

export function App(): React.ReactElement {
  const api = window.desktop;
  const store = useMemo(() => {
    let pending: Promise<() => void> | null = null;
    return new JobStore({
      subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
        const subscription = api.subscribeJob(jobId, listener);
        pending = subscription;
        return () => { void subscription.then((unsubscribe) => unsubscribe()).catch(() => undefined); };
      },
      async snapshot(jobId) { await pending; return api.snapshotJob({ jobId }); },
      retryFailed: (jobId) => api.retryFailed({ jobId }),
    });
  }, [api]);
  const [, render] = useState(0);
  const [jobId, setJobId] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [start, setStart] = useState(0);
  const [error, setError] = useState('');
  const [startingFake, setStartingFake] = useState(false);
  const [reviewRequest, setReviewRequest] = useState<VisualReviewRequest | null>(null);
  const [reviewImages, setReviewImages] = useState<VerifiedReviewImages | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.assetDetail>> | null>(null);
  const [recent, setRecent] = useState<Awaited<ReturnType<typeof api.recentJobs>>>([]);
  const snapshot = store.getSnapshot();
  useEffect(() => { const stop = store.listen(() => render((value) => value + 1)); return () => { stop(); store.dispose(); }; }, [store]);
  useEffect(() => { void api.recentJobs().then(setRecent).catch(() => undefined); }, [api]);
  useEffect(() => {
    let alive = true;
    setReviewRequest(null); setReviewImages(null); setReviewError(''); setDetail(null);
    if (!jobId || !selectedAssetId) return () => { alive = false; };
    void (async () => {
      try {
        const result = await api.assetDetail({ jobId, assetId: selectedAssetId });
        if (alive) setDetail(result);
        const request = await api.visualReview({ jobId, assetId: selectedAssetId });
        if (!alive) return;
        setReviewRequest(request);
        if (request) {
          const images = await api.reviewImages({ jobId, assetId: selectedAssetId });
          if (alive) setReviewImages(images);
        }
      } catch (cause) { if (alive) setReviewError(errorMessage(cause)); }
    })();
    return () => { alive = false; };
  }, [api, jobId, selectedAssetId, snapshot?.sequence]);
  async function connect(id: string): Promise<void> {
    setJobId(id); setSelectedAssetId(''); setStart(0); setError('');
    try { await store.connect(id); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  async function startFakeCorpus(): Promise<void> {
    if (!api.startFakeCorpus) return;
    setStartingFake(true); setError('');
    try { const { jobId: id } = await api.startFakeCorpus({ count: 10_000 }); await connect(id); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setStartingFake(false); }
  }
  const selected = snapshot?.assets.find((asset) => asset.assetId === selectedAssetId);
  return <>
    <SetupWizard onJobStarted={(id) => void connect(id)} />
    {api.startFakeCorpus && <section aria-label="Режим разработки"><button type="button" disabled={startingFake} onClick={() => void startFakeCorpus()}>Запустить 10 000 тестовых изображений</button></section>}
    {jobId && <section data-job-id={jobId}>
      <p>Задание: {jobId}</p>
      {snapshot ? <>
        <JobView state={snapshot.state} snapshot={snapshot} start={start} selectedAssetId={selectedAssetId} onSelectAsset={setSelectedAssetId} onOpenCommittedOutput={(assetId) => api.openCommittedOutput({ jobId, assetId })}
          handlers={{ pause: () => api.pauseJob({ jobId }), resume: () => api.resumeJob({ jobId }), cancel: () => api.cancelJob({ jobId }), retry: () => api.retryFailed({ jobId }) }}
          onRetrySuccess={(id) => { store.previousJobs.push(snapshot); void connect(id); }} />
        {snapshot.assets.length > 50 && <nav aria-label="Страницы задания"><button type="button" disabled={start === 0} onClick={() => setStart(Math.max(0, start - 50))}>Предыдущие</button><span> {start + 1}–{Math.min(start + 50, snapshot.assets.length)} из {snapshot.assets.length} </span><button type="button" disabled={start + 50 >= snapshot.assets.length} onClick={() => setStart(start + 50)}>Следующие</button></nav>}
        {selected && <section aria-label="Детали изображения"><h3>{selected.assetId}</h3><p>Состояние: {selected.status}; попытка {selected.attempt}</p>
          {selected.error && <p role="alert">{selected.error.message}</p>}
          {detail?.available ? <section aria-label="История проверок"><h4>История проверок</h4>{detail.synthetic && <p>Синтетические записи режима разработки</p>}{detail.attempts.map((attempt) => <article key={attempt.attempt}>
            <h5>Попытка {attempt.attempt}</h5><p>Решение рецензента: {attempt.verdict ?? 'неизвестно'}; ID проверки: {attempt.reviewId ?? 'неизвестно'}</p>
            {attempt.variants.map((variant) => <p key={variant.variantId}>Вариант {variant.variantId}: {variant.verdict ?? 'неизвестно'}; доказательства: {variant.evidenceIds.join(', ') || 'неизвестно'}</p>)}
            <p>Детерминированные проверки:</p>{attempt.checks.length ? attempt.checks.map((check) => <p key={check.requirementId}>{check.requirementId}: {check.result}; {check.reason}; доказательства: {check.evidenceIds.join(', ') || 'неизвестно'}</p>) : <p>неизвестно</p>}
            <p>Доказательства: {attempt.evidenceIds.join(', ') || 'неизвестно'}</p>
            {attempt.diagnostics.map((diagnostic) => <p key={diagnostic.evidenceId}>{diagnostic.code}: {diagnostic.summary}; ID {diagnostic.evidenceId}</p>)}
          </article>)}</section> : <p>История решений, детерминированные проверки и диагностические доказательства: неизвестно</p>}
          {reviewImages?.synthetic && <p>Синтетические изображения режима разработки. Визуальное решение не подтверждено.</p>}
          <ReviewEvidence request={reviewRequest} images={reviewImages} onSubmit={(requestId, decision, notes) => api.submitVisualAttestation({ requestId, decision, notes })} />
          {reviewError && <p role="alert">{reviewError}</p>}
        </section>}
      </> : <p role="status">Загрузка состояния задания</p>}
    </section>}
    {store.previousJobs.length > 0 && <section aria-label="Предыдущие попытки задания"><h2>Предыдущие попытки</h2>{store.previousJobs.map((previous) => <button key={previous.jobId} type="button" onClick={() => void connect(previous.jobId)}>{previous.jobId}: {previous.state}</button>)}</section>}
    {recent.length > 0 && <section aria-label="Недавние задания"><h2>Недавние задания</h2>{recent.map((entry) => <button key={entry.jobId} type="button" onClick={() => void connect(entry.jobId)}>{entry.jobId}: {entry.snapshot.state}</button>)}</section>}
    <button type="button" onClick={() => void api.safeClose().catch((cause: unknown) => setError(errorMessage(cause)))}>Безопасно закрыть</button>
    {(error || store.error) && <p role="alert">{error || store.error}</p>}
  </>;
}
