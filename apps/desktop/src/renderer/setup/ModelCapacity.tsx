import React from 'react';
import { weightsOnlyLowerBoundGb, type ModelEvidence } from './model-state.js';

export function ModelCapacity({ evidence }: { evidence: ModelEvidence }): React.ReactElement {
  return <section aria-label="Ёмкость модели">
    <h3>Ёмкость модели</h3>
    <p>Нижняя оценка только для весов 27B: Q4 {weightsOnlyLowerBoundGb('Q4')} GB, Q5 {weightsOnlyLowerBoundGb('Q5')} GB, Q6 {weightsOnlyLowerBoundGb('Q6')} GB, Q8 {weightsOnlyLowerBoundGb('Q8')} GB.</p>
    <p>Метаданные, KV-кэш, runtime и память Photoshop не включены.</p>
    <p>Измерено: RAM {evidence.resources.peakRamGb} GB; VRAM {evidence.resources.peakVramGb} GB; требуемый запас {evidence.resources.requiredHeadroomGb} GB; задержка {evidence.benchmark.latencyMs} ms.</p>
    <p>{evidence.benchmark.passed ? 'Проверка ёмкости пройдена' : 'Ёмкости недостаточно или проверка не завершена'}</p>
  </section>;
}
