import React from 'react';
import type { InspectionReport, LayerSelector, VariantId } from '@ne-psd/contracts';
import type { SelectorDetails } from './setup-state.js';

const segment = (value: LayerSelector['layerPath'][number]): string => `${value.name} [${value.kind}; ${value.fingerprint}]`;
export function selectorRoute(selector: LayerSelector): string {
  const documents = selector.documentRoute.map((route, index) => `Документ ${index + 1}: ${route.map(segment).join(' → ')}`).join(' / ');
  return `${documents || 'Корневой документ'} → ${selector.layerPath.map(segment).join(' → ')}`;
}
const VARIANTS: readonly VariantId[] = ['1', '2', '3'];

export function SelectorPicker({ selectors = [], inspection, targetCandidateId, referenceCandidateId, variantCandidateIds, onTarget, onReference, onVariant, onConfirm }: {
  selectors?: readonly SelectorDetails[]; inspection?: InspectionReport;
  targetCandidateId?: string; referenceCandidateId?: string; variantCandidateIds?: Partial<Record<VariantId, string>>;
  onTarget?: (candidateId: string) => void; onReference?: (candidateId: string) => void;
  onVariant?: (variantId: VariantId, candidateId: string) => void; onConfirm?: () => void;
}): React.ReactElement {
  const candidates = inspection?.candidates ?? [];
  const options = (role: 'target' | 'reference' | 'variant') => candidates.filter((candidate) => candidate.roleHints.includes(role));
  const select = (label: string, value: string | undefined, role: 'target' | 'reference' | 'variant', change?: (id: string) => void) =>
    <label key={label}>{label} <select aria-label={label} value={value ?? ''} disabled={!change || !inspection} onChange={(event) => change?.(event.target.value)}>
      <option value="">Не выбран</option>
      {options(role).map((candidate) => <option key={candidate.candidateId} value={candidate.candidateId}>{candidate.candidateId}: {selectorRoute(candidate.selector)}</option>)}
    </select></label>;
  const chosen = [targetCandidateId, referenceCandidateId, ...VARIANTS.map((id) => variantCandidateIds?.[id])];
  const confirmed = chosen.every((id) => id && candidates.some((candidate) => candidate.candidateId === id)) && targetCandidateId !== referenceCandidateId;
  return <section aria-labelledby="selector-heading">
    <h2 id="selector-heading">Селекторы шаблона</h2>
    {inspection ? <>
      <p>Инспекция: {inspection.inspectionId}; {inspection.evidenceStatus === 'liveObserved' ? 'наблюдение Photoshop' : 'только статический кандидат'}</p>
      <h3>Документы</h3>
      <ul>{inspection.documents.map((document) => <li key={document.documentKey}>
        {document.documentKey}; родитель: {document.parentKey ?? 'нет'}; {document.sourceKind === 'linked' ? 'Связанный ресурс' : document.sourceKind === 'embedded' ? 'Встроенный ресурс' : document.sourceKind === 'root' ? 'Корневой документ' : 'Тип источника не подтверждён'}
        {document.viaLayer && <span>; через {selectorRoute(document.viaLayer)}</span>}
      </li>)}</ul>
      {inspection.unresolvedLinks.length > 0 && <p role="alert">Неразрешённые связи: {inspection.unresolvedLinks.join(', ')}</p>}
      <h3>Кандидаты</h3>
      {candidates.map((candidate) => <details key={candidate.candidateId}>
        <summary>{candidate.candidateId}: {selectorRoute(candidate.selector)}</summary>
        <p>Ключ документа: {candidate.documentKey}; видим: {candidate.visible ? 'да' : 'нет'}; обрезан: {candidate.clipped ? 'да' : 'нет'}; ниже: {candidate.belowCandidateId ?? 'нет'}</p>
        <p>Роли: {candidate.roleHints.join(', ') || 'не указаны'}; состояние группы: {inspection.observedVariantStates.find((state) => state.candidateId === candidate.candidateId)?.visible === true ? 'наблюдалась видимой' : 'не подтверждена видимой'}</p>
      </details>)}
      <div>{select('Целевая область', targetCandidateId, 'target', onTarget)}
        {select('Образец', referenceCandidateId, 'reference', onReference)}
        {VARIANTS.map((variantId) => select(`Вариант ${variantId}`, variantCandidateIds?.[variantId], 'variant', onVariant && ((id) => onVariant(variantId, id))))}</div>
      {onConfirm && <button type="button" disabled={!confirmed} onClick={onConfirm}>Подтвердить цель, образец и варианты</button>}
    </> : selectors.map((selector) => <details key={selector.candidateId}><summary>{selector.candidateId}</summary><p>Маршрут: {selector.route}</p><p>Fingerprint: {selector.fingerprint}</p><p>{selector.linked ? 'Связанный ресурс: требуется изоляция' : 'Встроенный ресурс'}</p></details>)}
  </section>;
}
