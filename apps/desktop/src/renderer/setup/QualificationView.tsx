import React from 'react';
import type { TemplateProfile, VariantId } from '@ne-psd/contracts';
import type { SetupStatus } from './setup-state.js';

export type QualificationPreview = { variantId: VariantId; dataUrl: string; profileSha256: string; synthetic: boolean };
export function qualifiedPreviewSet(profile: TemplateProfile | null | undefined, previews: readonly QualificationPreview[], allowSynthetic = false): boolean {
  const sourceModeValid = previews.every((preview) => !preview.synthetic) || allowSynthetic && previews.every((preview) => preview.synthetic);
  return Boolean(profile && previews.length === 3 &&
    sourceModeValid &&
    previews.map((preview) => preview.variantId).sort().join(',') === '1,2,3' &&
    previews.every((preview) => preview.profileSha256 === profile.profileSha256 && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(preview.dataUrl)));
}
export function QualificationView({ status, profile, previews = [], onConfirm, allowSynthetic = false }: {
  status: SetupStatus; profile?: TemplateProfile | null; previews?: readonly QualificationPreview[]; onConfirm?: () => void; allowSynthetic?: boolean;
}): React.ReactElement {
  const valid = status === 'qualified' && qualifiedPreviewSet(profile, previews, allowSynthetic);
  const synthetic = valid && previews.some((preview) => preview.synthetic);
  const label = synthetic ? 'Синтетическая проверка — только режим разработки' : valid ? 'Шаблон квалифицирован сервисом' : status === 'blocked' ? 'Квалификация заблокирована' : 'Шаблон не квалифицирован для текущего выбора';
  return <section aria-live="polite" aria-labelledby="qualification-heading">
    <h2 id="qualification-heading">Квалификация</h2>
    <p>{label}</p>
    {profile && <p>Профиль: {profile.profileId}; SHA-256 {profile.profileSha256}; способ размещения: {profile.fitMode}; квалификация: {profile.qualificationId}</p>}
    {valid ? <div aria-label="Три квалифицированных варианта">{previews.map((preview) => <figure key={preview.variantId}>
      <img src={preview.dataUrl} alt={`Вариант ${preview.variantId}`} /><figcaption>Вариант {preview.variantId}; профиль {preview.profileSha256}{preview.synthetic ? '; синтетический' : ''}</figcaption>
    </figure>)}</div> : <p>Три изображения текущего профиля не подтверждены. Запуск недоступен.</p>}
    {onConfirm && <button type="button" disabled={!valid} onClick={onConfirm}>Подтвердить три изображения</button>}
    <p>Неподтверждённый шаблон нельзя передать в JobService.start.</p>
  </section>;
}
