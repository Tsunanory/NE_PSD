import React, { useState } from 'react';
import type { JobSnapshot } from '@ne-psd/contracts';
import { type JobActionHandlers, type JobState } from './job-controls.js';
import { JobControls } from './JobControls.js';
import { AssetList } from './AssetList.js';

export function JobView({ state, snapshot, handlers, start = 0, selectedAssetId, onSelectAsset, onRetrySuccess, onOpenCommittedOutput }: {
  state: JobState; snapshot?: JobSnapshot; handlers?: JobActionHandlers; start?: number;
  selectedAssetId?: string; onSelectAsset?: (assetId: string) => void; onRetrySuccess?: (jobId: string) => void;
  onOpenCommittedOutput?: (assetId: string) => Promise<void>;
}): React.ReactElement {
  const [openError, setOpenError] = useState('');
  const selected = snapshot?.assets.find((asset) => asset.assetId === selectedAssetId);
  async function openOutput(assetId: string): Promise<void> {
    if (!onOpenCommittedOutput) return;
    setOpenError('');
    try { await onOpenCommittedOutput(assetId); }
    catch (error) { setOpenError(error instanceof Error ? error.message : 'Результат недоступен'); }
  }
  return <section>
    <h2>Ход обработки</h2>
    <p>{state === 'blocked' ? 'Состояние Photoshop не подтверждено. Обработка остановлена до восстановления' : `Текущее состояние: ${state}`}</p>
    {snapshot && <>
      <p>{snapshot.complete} / {snapshot.total} завершено; ошибок {snapshot.failed}; блокировано {snapshot.blocked}</p>
      <AssetList assets={snapshot.assets} start={start} selectedAssetId={selectedAssetId} onSelect={onSelectAsset} />
      {selected?.status === 'complete' && onOpenCommittedOutput && <button type="button" onClick={() => void openOutput(selected.assetId)}>Готовые результаты</button>}
      {openError && <p role="alert">{openError}</p>}
    </>}
    <JobControls state={state} handlers={handlers} onRetrySuccess={onRetrySuccess} />
  </section>;
}
