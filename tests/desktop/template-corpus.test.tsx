import React from 'react';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { qualifyInspection } from '../../apps/desktop/src/main/evidence.js';
import { SelectorPicker } from '../../apps/desktop/src/renderer/setup/SelectorPicker.js';
import { FitControls } from '../../apps/desktop/src/renderer/setup/FitControls.js';
import { qualifiedPreviewSet } from '../../apps/desktop/src/renderer/setup/QualificationView.js';
import { nestedTemplateCase, syntheticGeometry, syntheticProposal } from './fixtures/template-cases.js';

const qualify = (inspection = nestedTemplateCase(), proposal = syntheticProposal()) => qualifyInspection(inspection, proposal, '/tmp/working-template.psd', '/tmp/evidence');

describe('synthetic nested template corpus', () => {
  it('keeps same-named targets distinct across parents and nested/linked documents visible', () => {
    const inspection = nestedTemplateCase();
    const [front, back] = [inspection.candidates.find((item) => item.candidateId === 'target-1')!, inspection.candidates.find((item) => item.candidateId === 'target-back')!];
    expect(front.selector.layerPath.at(-1)?.name).toBe(back.selector.layerPath.at(-1)?.name);
    expect(front.selector).not.toEqual(back.selector);
    expect(inspection.documents.map((item) => [item.documentKey, item.parentKey, item.sourceKind])).toEqual([
      ['root', null, 'root'], ['embedded-psb', 'root', 'embedded'], ['linked-texture', 'embedded-psb', 'linked'],
    ]);
    const html = renderToStaticMarkup(<SelectorPicker inspection={inspection} targetCandidateId="target-1" referenceCandidateId="reference-1"
      variantCandidateIds={{ '1': 'variant-1', '2': 'variant-2', '3': 'variant-3' }} onTarget={() => {}} onReference={() => {}} onVariant={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('target-front-fp');
    expect(html).toContain('target-back-fp');
    expect(html).toContain('Связанный ресурс');
    expect(html).toContain('Встроенный ресурс');
    expect(html).toContain('Embedded PSB');
  });

  it('qualifies only structural selection with linked isolation and blocks missing or ambiguous targets', () => {
    const good = qualify();
    expect(good.status).toBe('qualified');
    if (good.status !== 'qualified') return;
    expect(good.profile.targets[0]?.target.layerPath.at(-1)?.fingerprint).toBe('target-front-fp');
    const twin = syntheticProposal(); twin.targets[0]!.targetCandidateId = 'target-back';
    const alternate = qualify(nestedTemplateCase(), twin);
    expect(alternate.status).toBe('qualified');
    if (alternate.status === 'qualified') expect(alternate.profile.profileSha256).not.toBe(good.profile.profileSha256);
    for (const selection of ['target', 'reference', 'variant'] as const) {
      const missing = syntheticProposal();
      if (selection === 'target') missing.targets[0]!.targetCandidateId = 'missing-target';
      if (selection === 'reference') missing.targets[0]!.referenceCandidateId = 'missing-reference';
      if (selection === 'variant') missing.variants[0]!.groupCandidateId = 'missing-variant';
      expect(qualify(nestedTemplateCase(), missing).status).toBe('blocked');
    }
    const noIsolation = nestedTemplateCase(); noIsolation.evidencePaths = noIsolation.evidencePaths.filter((path) => !path.includes('linked-isolation'));
    expect(qualify(noIsolation).status).toBe('blocked');
    const ambiguous = nestedTemplateCase(); ambiguous.candidates.find((item) => item.candidateId === 'target-back')!.selector = structuredClone(ambiguous.candidates[0]!.selector);
    expect(qualify(ambiguous).status).toBe('blocked');
  });

  it('blocks unresolved links even when an isolation evidence path is present', () => {
    const unresolved = nestedTemplateCase(); unresolved.unresolvedLinks = ['assets/linked.psb'];
    expect(qualify(unresolved).status).toBe('blocked');
  });

  it('invalidates a preview after source, fit, output or backend qualification changes', () => {
    const base = qualify();
    expect(base.status).toBe('qualified');
    if (base.status !== 'qualified') return;
    const previews = (['1', '2', '3'] as const).map((variantId) => ({ variantId, profileSha256: base.profile.profileSha256, dataUrl: 'data:image/png;base64,aGVsbG8=', synthetic: true }));
    expect(qualifiedPreviewSet(base.profile, previews, true)).toBe(true);
    const changedSource = nestedTemplateCase(); changedSource.template.sha256 = createHash('sha256').update('changed template bytes').digest('hex');
    const changedFit = syntheticProposal(); changedFit.fitMode = 'contain';
    const changedOutput = syntheticProposal(); changedOutput.output!.quality = 80;
    const changedBackend = nestedTemplateCase(); changedBackend.capabilities!.toolSchemaSha256 = createHash('sha256').update('new backend schema').digest('hex');
    for (const result of [qualify(changedSource), qualify(nestedTemplateCase(), changedFit), qualify(nestedTemplateCase(), changedOutput), qualify(changedBackend)]) {
      expect(result.status).toBe('qualified');
      if (result.status === 'qualified') expect(qualifiedPreviewSet(result.profile, previews, true)).toBe(false);
    }
    const unsupported = nestedTemplateCase(); unsupported.capabilities!.supportedFitModes = ['cover'];
    for (const mode of ['contain', 'stretch'] as const) {
      const proposal = syntheticProposal(); proposal.fitMode = mode;
      expect(qualify(unsupported, proposal).status).toBe('blocked');
    }
  });

  it('keeps synthetic geometry explicit and disabled fit descriptions visible', () => {
    const inspection = nestedTemplateCase();
    const reference = inspection.candidates.find((item) => item.candidateId === 'reference-1')!.bounds!;
    expect([reference.right - reference.left, reference.bottom - reference.top]).toEqual([syntheticGeometry.reference.width, syntheticGeometry.reference.height]);
    expect(syntheticGeometry.source).toEqual({ width: 1000, height: 1000 });
    expect(syntheticGeometry.reference.alphaPolygon).toHaveLength(4);
    const html = renderToStaticMarkup(<FitControls value="cover" supported={['cover']} onChange={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('Вписать целиком; вокруг изображения может остаться свободное место');
    expect(html).toContain('Растянуть по области; пропорции изменятся');
    expect((html.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
