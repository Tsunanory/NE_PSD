import React, { useEffect, useState } from 'react';
import type { VisualReviewRequest } from '@ne-psd/contracts';
import type { VerifiedReviewImages } from '../../main/evidence.js';

export type ReviewArtifact = { variantId: '1' | '2' | '3'; path: string; synthetic?: boolean };
export type ReviewEvidenceProps = {
  artifacts?: readonly ReviewArtifact[];
  contactSheet?: string;
  request?: VisualReviewRequest | null;
  images?: VerifiedReviewImages | null;
  onSubmit?: (requestId: string, decision: 'approve' | 'reject', notes: string) => Promise<void>;
};

export function ReviewEvidence({ artifacts = [], contactSheet, request, images, onSubmit }: ReviewEvidenceProps): React.ReactElement {
  const [choice, setChoice] = useState<{ requestId: string; decision: 'approve' | 'reject' } | null>(null);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setChoice(null); setNotes(''); setSubmitted(false); setError(''); }, [request?.requestId]);
  const decision = choice && choice.requestId === request?.requestId ? choice.decision : null;
  const verified = Boolean(request && images && images.requestId === request.requestId && images.jobId === request.jobId &&
    images.assetId === request.assetId && images.attempt === request.attempt && images.variants.length === 3 &&
    request.artifacts.every((artifact) => images.variants.some((image) => image.variantId === artifact.variantId && image.sha256 === artifact.sha256 && /^data:image\/(?:png|jpeg);base64,/.test(image.dataUrl))) &&
    images.contactSheet.sha256 === request.contactSheet.sha256 && /^data:image\/(?:png|jpeg);base64,/.test(images.contactSheet.dataUrl));
  async function submit(): Promise<void> {
    if (!verified || !request || !decision || !onSubmit || pending || submitted) return;
    setPending(true);
    setError('');
    try { await onSubmit(request.requestId, decision, notes); setSubmitted(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Решение не принято'); }
    finally { setPending(false); }
  }
  return <section aria-labelledby="review-heading">
    <h2 id="review-heading">Проверка изображений</h2>
    {verified && images ? <>
      <div>{images.variants.map((image) => <figure key={image.variantId}><img src={image.dataUrl} alt={`Вариант ${image.variantId}`} /><figcaption>Вариант {image.variantId}; SHA-256 {image.sha256}</figcaption></figure>)}</div>
      <figure><img src={images.contactSheet.dataUrl} alt="Контактный лист трёх вариантов" /><figcaption>Контактный лист; SHA-256 {images.contactSheet.sha256}</figcaption></figure>
    </> : <>
      <p>Изображения не подтверждены по текущему пакету доказательств.</p>
      {artifacts.map((artifact) => <p key={artifact.variantId}>Вариант {artifact.variantId}{artifact.synthetic ? ' — synthetic' : ''}</p>)}
      {contactSheet && <p>Contact sheet: недоступен до проверки</p>}
    </>}
    <p>Нет автоматического решения. Выбор оператора обязателен.</p>
    <button type="button" disabled={!verified || !onSubmit || pending || submitted} onClick={() => request && setChoice({ requestId: request.requestId, decision: 'approve' })} aria-pressed={decision === 'approve'}>Одобрить</button>
    <button type="button" disabled={!verified || !onSubmit || pending || submitted} onClick={() => request && setChoice({ requestId: request.requestId, decision: 'reject' })} aria-pressed={decision === 'reject'}>Отклонить</button>
    <label>Примечание<textarea value={notes} onChange={(event) => setNotes(event.target.value)} disabled={!verified || pending || submitted} /></label>
    <button type="button" disabled={!decision || !verified || !onSubmit || pending || submitted} onClick={() => void submit()}>Отправить решение</button>
    {pending && <p role="status">Решение отправляется</p>}
    {submitted && <p role="status">Решение получено сервисом; ожидается подтверждённое состояние задания</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
