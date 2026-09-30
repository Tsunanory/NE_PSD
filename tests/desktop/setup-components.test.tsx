import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InspectionReportSchema, TemplateProfileSchema, type OutputSpec } from '@ne-psd/contracts';
import { TemplateSetup } from '../../apps/desktop/src/renderer/setup/TemplateSetup.js';
import { AssetSetup } from '../../apps/desktop/src/renderer/setup/AssetSetup.js';
import { OutputSetup, updateOutputSpec } from '../../apps/desktop/src/renderer/setup/OutputSetup.js';
import { SelectorPicker, selectorRoute } from '../../apps/desktop/src/renderer/setup/SelectorPicker.js';
import { FitControls } from '../../apps/desktop/src/renderer/setup/FitControls.js';
import { QualificationView, qualifiedPreviewSet } from '../../apps/desktop/src/renderer/setup/QualificationView.js';

const fixture = (file: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/contracts', file), 'utf8')) as unknown;
const inspection = InspectionReportSchema.parse(fixture('inspection.live.json'));
const profile = TemplateProfileSchema.parse(fixture('profile.qualified.json'));
const output: OutputSpec = { format: 'jpeg', quality: 90, colorSpace: 'sRGB', width: 800, height: 600 };
const previews = (['1', '2', '3'] as const).map((variantId) => ({ variantId, dataUrl: 'data:image/png;base64,aGVsbG8=', profileSha256: profile.profileSha256, synthetic: false }));

describe('controlled desktop setup components', () => {
  it('uses callbacks for native pickers and retains the displayed selection after cancellation', () => {
    const template = renderToStaticMarkup(<TemplateSetup label="Мой шаблон.psd" status="cancelled" onPick={() => {}} />);
    const assets = renderToStaticMarkup(<AssetSetup label="Каталог" assets={[{ assetId: 'stable-a', name: 'изображение.jpg' }]} rejected={[{ name: 'bad.txt', reason: 'неподдерживаемый формат' }]} onPick={() => {}} />);
    expect(template).toContain('Мой шаблон.psd');
    expect(template).toContain('Выбор отменён');
    expect(template).not.toContain('disabled');
    expect(assets).toContain('stable-a');
    expect(assets).toContain('неподдерживаемый формат');
    expect(assets).toContain('Принято: 1');
  });
  it('keeps the asset list bounded for a 10,000-image folder', () => {
    const assets = Array.from({ length: 10_000 }, (_, index) => ({ assetId: `stable-${index}`, name: `image-${index}.jpg` }));
    const html = renderToStaticMarkup(<AssetSetup label="Каталог" assets={assets} />);
    expect((html.match(/ID: stable-/g) ?? []).length).toBe(50);
    expect(html).toContain('Принято: 10000');
  });
  it('keeps JPEG quality while switching to PNG and rejects invalid dimensions', () => {
    expect(updateOutputSpec(output, { format: 'png' })).toEqual({ ...output, format: 'png' });
    expect(updateOutputSpec(output, { width: 0 })).toBeNull();
    expect(updateOutputSpec(output, { quality: 101 })).toBeNull();
    const png = renderToStaticMarkup(<OutputSetup label="Результаты" spec={{ ...output, format: 'png' }} onPick={() => {}} onChange={() => {}} />);
    expect(png).toContain('value="90"');
    expect(png).toMatch(/Качество JPEG[\s\S]*disabled/);
    expect(png).toContain('sRGB');
  });
  it('shows full selector route, fingerprint and document relationships', () => {
    const candidate = inspection.candidates[0]!;
    const route = selectorRoute({ ...candidate.selector, documentRoute: [[{ name: 'Linked', kind: 'smartObject', fingerprint: 'doc-fp' }]] });
    expect(route).toContain('doc-fp');
    expect(route).toContain('target-fp');
    const nested = { ...inspection, candidates: [{ ...candidate, selector: { ...candidate.selector, documentRoute: [[{ name: 'Linked', kind: 'smartObject' as const, fingerprint: 'doc-fp' }]] } }, ...inspection.candidates.slice(1)], documents: [...inspection.documents, { ...inspection.documents[0]!, documentKey: 'nested', parentKey: 'root', sourceKind: 'linked' as const, viaLayer: candidate.selector }] };
    const html = renderToStaticMarkup(<SelectorPicker inspection={nested} targetCandidateId="target-1" referenceCandidateId="reference-1" variantCandidateIds={{ '1': 'variant-1', '2': 'variant-2', '3': 'variant-3' }} onTarget={() => {}} onReference={() => {}} onVariant={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('doc-fp');
    expect(html).toContain('target-fp');
    expect(html).toContain('Связанный');
    expect(html).toContain('Вариант 3');
    expect(html).toContain('Подтвердить цель, образец и варианты');
  });
  it('explains fit modes and disables unqualified ones', () => {
    const html = renderToStaticMarkup(<FitControls value="cover" supported={['cover']} onChange={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('Вписать целиком; вокруг изображения может остаться свободное место');
    expect(html).toContain('Растянуть по области; пропорции изменятся');
    expect((html.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('Подтвердить способ размещения');
  });
  it('requires current digest and all three non-synthetic previews before confirmation', () => {
    expect(qualifiedPreviewSet(profile, previews)).toBe(true);
    expect(qualifiedPreviewSet(profile, previews.slice(0, 2))).toBe(false);
    expect(qualifiedPreviewSet(profile, [{ ...previews[0]!, profileSha256: 'f'.repeat(64) }, ...previews.slice(1)])).toBe(false);
    expect(qualifiedPreviewSet(profile, [{ ...previews[0]!, synthetic: true }, ...previews.slice(1)])).toBe(false);
    expect(qualifiedPreviewSet(profile, previews.map((preview) => ({ ...preview, synthetic: true })), true)).toBe(true);
    const valid = renderToStaticMarkup(<QualificationView status="qualified" profile={profile} previews={previews} onConfirm={() => {}} />);
    expect((valid.match(/<img/g) ?? []).length).toBe(3);
    expect(valid).toContain('Подтвердить три изображения');
    const invalid = renderToStaticMarkup(<QualificationView status="qualified" profile={profile} previews={previews.slice(0, 2)} onConfirm={() => {}} />);
    expect(invalid).not.toContain('Шаблон квалифицирован сервисом');
    expect(invalid).not.toContain('<img');
    const devOnly = renderToStaticMarkup(<QualificationView status="qualified" profile={profile} previews={previews.map((preview) => ({ ...preview, synthetic: true }))} allowSynthetic onConfirm={() => {}} />);
    expect(devOnly).toContain('Синтетическая проверка — только режим разработки');
    expect(devOnly).toContain('Подтвердить три изображения');
  });
});
