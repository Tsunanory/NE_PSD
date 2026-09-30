import React, { useEffect, useState } from 'react';
import type { ConfigurationProposal, InspectionReport, OutputSpec, TemplateProfile, VariantId } from '@ne-psd/contracts';
import type { BridgeApi } from '../../main/ipc-schema.js';
import type { AssetSelection, OutputSelection, Preview, TemplateSelection } from '../../main/setup-controller.js';
import { AssetSetup } from './AssetSetup.js';
import { FitControls } from './FitControls.js';
import { OutputSetup } from './OutputSetup.js';
import { QualificationView } from './QualificationView.js';
import { SelectorPicker } from './SelectorPicker.js';
import { TemplateSetup } from './TemplateSetup.js';
import { ModelSetup } from './ModelSetup.js';

type PickStatus = 'idle' | 'pending' | 'cancelled' | 'error';
type Catalog = Awaited<ReturnType<BridgeApi['setupCatalog']>>;
const variants: readonly VariantId[] = ['1', '2', '3'];
const message = (cause: unknown): string => cause instanceof Error ? cause.message : 'Операция не выполнена';

export function SetupWizard({ onJobStarted }: { onJobStarted: (jobId: string) => void }): React.ReactElement {
  const api = window.desktop;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [template, setTemplate] = useState<TemplateSelection | null>(null);
  const [assets, setAssets] = useState<AssetSelection | null>(null);
  const [output, setOutput] = useState<OutputSelection | null>(null);
  const [inspection, setInspection] = useState<InspectionReport | null>(null);
  const [proposal, setProposal] = useState<ConfigurationProposal | null>(null);
  const [profile, setProfile] = useState<TemplateProfile | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [selectorsConfirmed, setSelectorsConfirmed] = useState(false);
  const [fitConfirmed, setFitConfirmed] = useState(false);
  const [outputConfirmed, setOutputConfirmed] = useState(false);
  const [instruction, setInstruction] = useState('Поместить изображение в выбранную область и подготовить три варианта');
  const [plannerId, setPlannerId] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [pickStatus, setPickStatus] = useState<Record<'template' | 'assets' | 'output', PickStatus>>({ template: 'idle', assets: 'idle', output: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { void api.setupCatalog().then(setCatalog).catch((cause: unknown) => setError(message(cause))); }, [api]);
  const models = catalog?.models ?? [];
  const selectedPlanner = models.find((entry) => entry.profile.profileId === plannerId);
  const selectedReviewer = models.find((entry) => entry.profile.profileId === reviewerId);
  const resetQualification = (): void => { setProfile(null); setPreviews([]); setConfirmed(false); };
  const resetProposal = (): void => { setProposal(null); setSelectorsConfirmed(false); setFitConfirmed(false); setOutputConfirmed(false); resetQualification(); };
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function pick(kind: 'template' | 'assets' | 'output'): Promise<void> {
    setPickStatus((current) => ({ ...current, [kind]: 'pending' }));
    try {
      const result = kind === 'template' ? await api.chooseTemplate() : kind === 'assets' ? await api.chooseAssets() : await api.chooseOutput();
      if (result === null) { setPickStatus((current) => ({ ...current, [kind]: 'cancelled' })); return; }
      if (kind === 'template') { setTemplate(result as TemplateSelection); setInspection(null); resetProposal(); }
      if (kind === 'assets') { setAssets(result as AssetSelection); resetQualification(); }
      if (kind === 'output') { setOutput(result as OutputSelection); resetQualification(); }
      setPickStatus((current) => ({ ...current, [kind]: 'idle' }));
    } catch (cause) { setPickStatus((current) => ({ ...current, [kind]: 'error' })); setError(message(cause)); }
  }
  function changeProposal(next: ConfigurationProposal): void { setProposal(next); setSelectorsConfirmed(false); setFitConfirmed(false); setOutputConfirmed(false); resetQualification(); }
  function chooseTarget(id: string): void { if (proposal) changeProposal({ ...proposal, targets: [{ ...proposal.targets[0]!, targetCandidateId: id }, ...proposal.targets.slice(1)] }); }
  function chooseReference(id: string): void { if (proposal) changeProposal({ ...proposal, targets: [{ ...proposal.targets[0]!, referenceCandidateId: id }, ...proposal.targets.slice(1)] }); }
  function chooseVariant(variantId: VariantId, id: string): void { if (proposal) changeProposal({ ...proposal, variants: proposal.variants.map((variant) => variant.id === variantId ? { ...variant, groupCandidateId: id } : variant) as ConfigurationProposal['variants'] }); }
  const canQualify = Boolean(proposal?.status === 'proposed' && proposal.output && selectorsConfirmed && fitConfirmed && outputConfirmed && template && assets && output);
  return <main><h1>NE PSD</h1>
    <TemplateSetup label={template?.label ?? 'Шаблон не выбран'} status={pickStatus.template} onPick={() => void pick('template')} />
    <AssetSetup label={assets?.label ?? 'Входная папка не выбрана'} assets={assets?.assets.map((asset) => ({ assetId: asset.assetId, name: asset.source.relativePath })) ?? []} rejected={assets?.rejected ?? []} status={pickStatus.assets} onPick={() => void pick('assets')} />
    <OutputSetup label={output?.label ?? 'Папка результатов не выбрана'} {...(proposal?.output ? { spec: proposal.output } : {})} onChange={(spec: OutputSpec) => { if (proposal) changeProposal({ ...proposal, output: spec }); }} status={pickStatus.output} onPick={() => void pick('output')} />
    <section aria-label="Модели"><h2>Роли моделей</h2>
      <label>Планировщик <select value={plannerId} onChange={(event) => setPlannerId(event.target.value)}><option value="">Не выбран</option>{models.map((entry) => <option key={entry.profile.profileId} value={entry.profile.profileId}>{entry.evidence.label}</option>)}</select></label>
      <label>Рецензент <select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}><option value="">Не выбран</option>{models.filter((entry) => entry.profile.capabilities.vision).map((entry) => <option key={entry.profile.profileId} value={entry.profile.profileId}>{entry.evidence.label}</option>)}</select></label>
      <button type="button" disabled={busy || !plannerId || !reviewerId} onClick={() => void run(async () => { await api.selectModels({ plannerProfileId: plannerId, reviewerProfileId: reviewerId }); setNotice('Роли моделей выбраны'); })}>Выбрать роли моделей</button>
      {selectedPlanner && <ModelSetup evidence={selectedPlanner.evidence} {...(selectedReviewer ? { reviewer: selectedReviewer.evidence } : {})} onInspectModelProfile={(model) => api.inspectModel({ profile: model })} onQualifyModelProfile={(model) => api.qualifyModel({ profile: model })} onRefreshEvidence={async () => { setCatalog(await api.setupCatalog()); }} />}
    </section>
    <section aria-label="Инспекция и предложение"><h2>Инспекция шаблона</h2>
      <button type="button" disabled={busy || !template} onClick={() => void run(async () => { const report = await api.inspectSetup({ templateHandle: template!.handle, relativePath: template!.relativePath }); setInspection(report); resetProposal(); })}>Инспектировать PSD</button>
      <label>Инструкция <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label>
      <button type="button" disabled={busy || !inspection || !plannerId || !instruction.trim()} onClick={() => void run(async () => { changeProposal(await api.proposeSetup({ instruction, inspectionId: inspection!.inspectionId, modelProfileId: plannerId })); })}>Предложить конфигурацию</button>
      <button type="button" disabled={busy || !inspection || !proposal} onClick={() => void run(async () => { await api.saveCandidate({ proposal: proposal! }); setNotice('Кандидат сохранён'); })}>Сохранить кандидат</button>
      <button type="button" disabled={busy || !inspection} onClick={() => void run(async () => { changeProposal(await api.loadCandidate()); setNotice('Кандидат загружен; подтверждения требуются снова'); })}>Загрузить кандидат</button>
      {proposal?.status === 'blocked' && <p role="alert">Предложение заблокировано: {proposal.missingFields.join(', ')}</p>}
    </section>
    <SelectorPicker {...(inspection ? { inspection } : {})} {...(proposal ? { targetCandidateId: proposal.targets[0]?.targetCandidateId ?? '', referenceCandidateId: proposal.targets[0]?.referenceCandidateId ?? '', variantCandidateIds: Object.fromEntries(variants.map((id) => [id, proposal.variants.find((variant) => variant.id === id)?.groupCandidateId])), onTarget: chooseTarget, onReference: chooseReference, onVariant: chooseVariant, onConfirm: () => setSelectorsConfirmed(true) } : {})} />
    {proposal?.output && <><FitControls value={proposal.fitMode} supported={inspection?.capabilities?.supportedFitModes ?? []} onChange={(fitMode) => changeProposal({ ...proposal, fitMode })} onConfirm={() => setFitConfirmed(true)} />
      <button type="button" disabled={busy} onClick={() => setOutputConfirmed(true)}>Подтвердить параметры результата</button></>}
    <button type="button" disabled={busy || !canQualify} onClick={() => void run(async () => { const result = await api.qualifySetup({ proposal: proposal! }); setProfile(result.profile); setPreviews(result.previews); setConfirmed(false); })}>Квалифицировать шаблон</button>
    <QualificationView status={profile ? 'qualified' : 'unqualified'} profile={profile} previews={previews} allowSynthetic={catalog?.developmentFake ?? false} {...(profile ? { onConfirm: () => void run(async () => { await api.confirmPreviews({ profileSha256: profile.profileSha256 }); setConfirmed(true); }) } : {})} />
    <button type="button" disabled={busy || !confirmed} onClick={() => void run(async () => { await api.saveProfile(); setNotice('Профиль сохранён'); })}>Сохранить профиль</button>
    <button type="button" disabled={busy || !inspection} onClick={() => void run(async () => { const saved = await api.loadProfile(); setNotice(`Сохранённый профиль ${saved.profileId} загружен для просмотра; требуется новая квалификация`); resetQualification(); })}>Загрузить профиль</button>
    <button type="button" disabled={busy || !confirmed || !assets || !output || !plannerId || !reviewerId} onClick={() => void run(async () => { const result = await api.startSetupJob(); onJobStarted(result.jobId); })}>Запустить задание</button>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </main>;
}
