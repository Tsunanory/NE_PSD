import React, { useState } from 'react';

export type AssetDisplay = { assetId: string; name: string };
export type RejectedAssetDisplay = { name: string; reason: string };
export function AssetSetup({ label, assets = [], rejected = [], onPick, status = 'idle' }: {
  label: string; assets?: readonly AssetDisplay[]; rejected?: readonly RejectedAssetDisplay[];
  onPick?: () => void; status?: 'idle' | 'pending' | 'cancelled' | 'error';
}): React.ReactElement {
  const [acceptedPage, setAcceptedPage] = useState(0);
  const [rejectedPage, setRejectedPage] = useState(0);
  const acceptedStart = Math.min(acceptedPage * 50, Math.max(0, Math.ceil(assets.length / 50) - 1) * 50);
  const rejectedStart = Math.min(rejectedPage * 50, Math.max(0, Math.ceil(rejected.length / 50) - 1) * 50);
  return <section aria-labelledby="assets-heading">
    <h2 id="assets-heading">Исходные изображения</h2>
    <p>{label}</p>
    <button type="button" disabled={!onPick || status === 'pending'} onClick={onPick}>Выбрать входную папку</button>
    {status === 'cancelled' && <p role="status">Выбор отменён. Предыдущая папка сохранена.</p>}
    {status === 'error' && <p role="alert">Входная папка не проверена.</p>}
    <p>Принято: {assets.length}; отклонено: {rejected.length}</p>
    {assets.length > 0 && <><ul aria-label="Принятые изображения">{assets.slice(acceptedStart, acceptedStart + 50).map((asset) => <li key={asset.assetId}>{asset.name} <small>ID: {asset.assetId}</small></li>)}</ul>
      {assets.length > 50 && <nav aria-label="Страницы принятых изображений"><button type="button" disabled={acceptedStart === 0} onClick={() => setAcceptedPage((page) => page - 1)}>Предыдущие принятые</button><span> {acceptedStart + 1}–{Math.min(acceptedStart + 50, assets.length)} из {assets.length} </span><button type="button" disabled={acceptedStart + 50 >= assets.length} onClick={() => setAcceptedPage((page) => page + 1)}>Следующие принятые</button></nav>}</>}
    {rejected.length > 0 && <><ul aria-label="Отклонённые изображения">{rejected.slice(rejectedStart, rejectedStart + 50).map((asset, index) => <li key={`${asset.name}-${rejectedStart + index}`}>{asset.name}: {asset.reason}</li>)}</ul>
      {rejected.length > 50 && <nav aria-label="Страницы отклонённых изображений"><button type="button" disabled={rejectedStart === 0} onClick={() => setRejectedPage((page) => page - 1)}>Предыдущие отклонённые</button><span> {rejectedStart + 1}–{Math.min(rejectedStart + 50, rejected.length)} из {rejected.length} </span><button type="button" disabled={rejectedStart + 50 >= rejected.length} onClick={() => setRejectedPage((page) => page + 1)}>Следующие отклонённые</button></nav>}</>}
  </section>;
}
