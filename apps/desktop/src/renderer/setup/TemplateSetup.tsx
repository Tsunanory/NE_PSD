import React from 'react';

export function TemplateSetup({ label, onPick, status = 'idle' }: {
  label: string; onPick?: () => void; status?: 'idle' | 'pending' | 'cancelled' | 'error';
}): React.ReactElement {
  return <section aria-labelledby="template-heading">
    <h2 id="template-heading">PSD-шаблон</h2>
    <p>{label}</p>
    <button type="button" disabled={!onPick || status === 'pending'} onClick={onPick}>Выбрать PSD</button>
    {status === 'cancelled' && <p role="status">Выбор отменён. Предыдущий шаблон сохранён.</p>}
    {status === 'error' && <p role="alert">Шаблон не выбран. Проверьте файл.</p>}
  </section>;
}
