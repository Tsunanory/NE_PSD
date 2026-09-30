import React from 'react';
import type { OutputSpec } from '@ne-psd/contracts';

export function updateOutputSpec(spec: OutputSpec, change: Partial<OutputSpec>): OutputSpec | null {
  const next = { ...spec, ...change };
  return (next.format === 'jpeg' || next.format === 'png') && next.colorSpace === 'sRGB' &&
    Number.isSafeInteger(next.width) && next.width > 0 && Number.isSafeInteger(next.height) && next.height > 0 &&
    Number.isSafeInteger(next.quality) && next.quality >= 1 && next.quality <= 100 ? next : null;
}

export function OutputSetup({ label, spec, onPick, onChange, status = 'idle' }: {
  label: string; spec?: OutputSpec; onPick?: () => void; onChange?: (spec: OutputSpec) => void;
  status?: 'idle' | 'pending' | 'cancelled' | 'error';
}): React.ReactElement {
  const change = (part: Partial<OutputSpec>) => {
    if (!spec || !onChange) return;
    const next = updateOutputSpec(spec, part);
    if (next) onChange(next);
  };
  return <section aria-labelledby="output-heading">
    <h2 id="output-heading">Папка результатов</h2>
    <p>{label}</p>
    <button type="button" disabled={!onPick || status === 'pending'} onClick={onPick}>Выбрать папку результатов</button>
    {status === 'cancelled' && <p role="status">Выбор отменён. Предыдущая папка сохранена.</p>}
    {status === 'error' && <p role="alert">Папка результатов не проверена.</p>}
    {spec ? <fieldset disabled={!onChange}>
      <legend>Параметры результата</legend>
      <label>Формат <select value={spec.format} onChange={(event) => change({ format: event.target.value as OutputSpec['format'] })}><option value="jpeg">JPEG</option><option value="png">PNG</option></select></label>
      <label>Ширина <input type="number" min="1" step="1" value={spec.width} onChange={(event) => change({ width: Number(event.target.value) })} /></label>
      <label>Высота <input type="number" min="1" step="1" value={spec.height} onChange={(event) => change({ height: Number(event.target.value) })} /></label>
      <label>Качество JPEG <input type="number" min="1" max="100" step="1" value={spec.quality} disabled={spec.format === 'png'} onChange={(event) => change({ quality: Number(event.target.value) })} /></label>
      <p>Цветовое пространство: {spec.colorSpace}</p>
    </fieldset> : <p>Параметры результата не заданы.</p>}
  </section>;
}
