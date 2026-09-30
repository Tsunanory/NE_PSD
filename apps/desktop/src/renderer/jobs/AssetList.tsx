import React from 'react';
import type { JobSnapshot } from '@ne-psd/contracts';
import { boundedAssetWindow } from './job-store.js';

export function AssetList({ assets, start = 0, selectedAssetId, onSelect }: {
  assets: JobSnapshot['assets']; start?: number; selectedAssetId?: string | undefined; onSelect?: ((assetId: string) => void) | undefined;
}): React.ReactElement {
  const visible = boundedAssetWindow(assets, start);
  return <section aria-label="Изображения">
    <p>Показаны {visible.length} из {assets.length}</p>
    <ul>{visible.map((asset) => <li key={asset.assetId} data-asset-id={asset.assetId}>
      <button type="button" aria-pressed={selectedAssetId === asset.assetId} disabled={!onSelect} onClick={() => onSelect?.(asset.assetId)}>{asset.assetId}</button>
      <span> {asset.status}; попытка {asset.attempt}</span>
      {asset.error && <span> {asset.error.message}</span>}
    </li>)}</ul>
  </section>;
}
