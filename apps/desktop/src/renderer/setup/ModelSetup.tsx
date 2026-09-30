import React, { useState } from 'react';
import type { ModelProfile, SetupService } from '@ne-psd/contracts';
import { evaluateModelSetup, evaluateModelSelection, type ModelEvidence } from './model-state.js';
import { ModelCapacity } from './ModelCapacity.js';

type Inspection = Awaited<ReturnType<SetupService['inspectModelProfile']>>;
type Qualification = Awaited<ReturnType<SetupService['qualifyModelProfile']>>;
export type ModelSetupProps = {
  evidence: ModelEvidence;
  reviewer?: ModelEvidence;
  onInspectModelProfile?: (profile: ModelProfile) => Promise<Inspection>;
  onQualifyModelProfile?: (profile: ModelProfile) => Promise<Qualification>;
  onRefreshEvidence?: (role: 'planner' | 'reviewer') => Promise<void>;
};

function EvidenceView({ role, evidence }: { role: 'planner' | 'reviewer'; evidence: ModelEvidence }): React.ReactElement {
  const result = evaluateModelSetup(evidence, role);
  const label = role === 'planner' ? 'Планировщик' : 'Рецензент изображений';
  return <section aria-label={label}>
    <h3>{label}: {evidence.label}</h3><p>{result.message}</p>
    <dl>
      <dt>Endpoint</dt><dd>{result.checks.endpoint ? 'доступен' : 'недоступен'}</dd>
      <dt>Идентичность и provenance</dt><dd>{result.checks.identity ? 'подтверждены' : 'не подтверждены'}</dd>
      <dt>JSON Schema</dt><dd>{result.checks.capabilities.jsonSchema ? 'да' : 'нет'}</dd>
      <dt>Инструменты</dt><dd>{result.checks.capabilities.tools ? 'да' : 'нет'}</dd>
      <dt>Зрение</dt><dd>{result.checks.capabilities.vision ? 'да' : 'нет'}</dd>
      <dt>Бенчмарк</dt><dd>{result.checks.benchmark ? 'пройден' : 'не пройден'}</dd>
      <dt>Review gate</dt><dd>{result.checks.reviewGate ? 'доступен' : 'недоступен'}</dd>
      <dt>Квалификация</dt><dd>{result.checks.qualified ? 'подтверждена' : 'не подтверждена'}</dd>
    </dl>
    <p>Model ID: {evidence.modelId}; профиль: {evidence.selectedProfile?.profileId ?? 'не выбран'}; endpoint: {evidence.selectedProfile?.endpoint ?? 'не выбран'}</p>
    <p>Artifact SHA-256: {evidence.artifactSha256}; runtime: {evidence.runtimeVersion}; chat template SHA-256: {evidence.chatTemplateSha256}</p>
    <p>Quantization: {evidence.quantization}; context: {evidence.contextTokens}; output: {evidence.maxOutputTokens}</p>
    <ModelCapacity evidence={evidence} />
  </section>;
}

export function ModelSetup({ evidence, reviewer, onInspectModelProfile, onQualifyModelProfile, onRefreshEvidence }: ModelSetupProps): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const selection = reviewer ? evaluateModelSelection(evidence, reviewer) : null;
  async function recheck(role: 'planner' | 'reviewer', selected: ModelEvidence): Promise<void> {
    if (!selected.selectedProfile || !onInspectModelProfile || !onQualifyModelProfile || !onRefreshEvidence) return;
    setBusy(true);
    setNotice('');
    try {
      const inspection = await onInspectModelProfile(selected.selectedProfile);
      if (!inspection.available) setNotice('Модель недоступна. Проверьте настроенный сервер.');
      else {
        const qualification = await onQualifyModelProfile(selected.selectedProfile);
        if (!qualification.qualified) setNotice('Указанная модель не подтверждена. Обработка недоступна');
      }
      await onRefreshEvidence(role);
    } catch { setNotice('Проверка модели не завершена. Повторите проверку.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Настройка модели">
    <h2>Локальная модель</h2>
    <p>Запрошенная модель: {evidence.label}</p>
    <EvidenceView role="planner" evidence={evidence} />
    {reviewer && <EvidenceView role="reviewer" evidence={reviewer} />}
    {!reviewer && <p>Рецензент изображений не выбран. Автоматическая проверка изображений недоступна.</p>}
    {selection && <p>{selection.automatedVisual ? 'Автоматическая проверка изображений доступна' : 'Автоматическая проверка изображений недоступна'}</p>}
    <p>Для каждого изображения рецензент получает новый контекст и реальные изображения. Публикация требует три положительных визуальных решения.</p>
    {notice && <p role="status">{notice}</p>}
    {onInspectModelProfile && onQualifyModelProfile && onRefreshEvidence && <div>
      <button type="button" disabled={busy || !evidence.selectedProfile} onClick={() => void recheck('planner', evidence)}>Проверить планировщик</button>
      {reviewer && <button type="button" disabled={busy || !reviewer.selectedProfile} onClick={() => void recheck('reviewer', reviewer)}>Проверить рецензента</button>}
    </div>}
  </section>;
}
