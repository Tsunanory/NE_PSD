import { loadFixture } from '@ne-psd/contracts/testing';
import { InspectionReportSchema, type ConfigurationProposal, type InspectionReport, type LayerSelector } from '@ne-psd/contracts';
export const syntheticInspection = (): InspectionReport => loadFixture<InspectionReport>('inspection.live.json');
export const syntheticProposal = (): ConfigurationProposal => loadFixture<ConfigurationProposal>('proposal.valid.json');

const embedded: LayerSelector = { documentRoute: [], layerPath: [{ name: 'Embedded PSB', kind: 'smartObject', fingerprint: 'embedded-psb-fp' }] };
const linked: LayerSelector = { documentRoute: [embedded.layerPath], layerPath: [{ name: 'Linked Texture', kind: 'smartObject', fingerprint: 'linked-texture-fp' }] };
const nestedRoute = [embedded.layerPath];

/** Synthetic graph for selector and isolation tests; it is not a Photoshop inspection. */
export function nestedTemplateCase(): InspectionReport {
  const base = syntheticInspection();
  const nested = base.candidates.map((candidate) => ({
    ...candidate, documentKey: 'embedded-psb', selector: { documentRoute: nestedRoute,
      layerPath: candidate.candidateId === 'target-1'
        ? [{ name: 'Front', kind: 'group' as const, fingerprint: 'front-fp' }, { name: 'МЕНЯТЬ ЗДЕСЬ!', kind: 'smartObject' as const, fingerprint: 'target-front-fp' }]
        : candidate.selector.layerPath },
    bounds: candidate.candidateId === 'reference-1' ? { left: 20, top: 30, right: 420, bottom: 230 } : candidate.bounds,
  }));
  const twin = { ...nested[0]!, candidateId: 'target-back', selector: { documentRoute: nestedRoute,
    layerPath: [{ name: 'Back', kind: 'group' as const, fingerprint: 'back-fp' }, { name: 'МЕНЯТЬ ЗДЕСЬ!', kind: 'smartObject' as const, fingerprint: 'target-back-fp' }] } };
  return InspectionReportSchema.parse({ ...base,
    documents: [
      { ...base.documents[0]!, width: 1000, height: 1000 },
      { documentKey: 'embedded-psb', parentKey: 'root', viaLayer: embedded, sourceKind: 'embedded', source: { rootId: 'fixture-root', relativePath: 'assets/nested.psb', sha256: '1'.repeat(64) }, width: 1000, height: 1000, colorMode: 'RGB', bitDepth: 8 },
      { documentKey: 'linked-texture', parentKey: 'embedded-psb', viaLayer: linked, sourceKind: 'linked', source: { rootId: 'fixture-root', relativePath: 'assets/linked.psb', sha256: '2'.repeat(64) }, width: 500, height: 500, colorMode: 'RGB', bitDepth: 8 },
    ],
    candidates: [...nested, twin],
    evidencePaths: [...base.evidencePaths, 'testOnly/linked-isolation.json', 'testOnly/reference-alpha-sentinel.json'],
  });
}

export const syntheticGeometry = {
  source: { width: 1000, height: 1000 },
  reference: { width: 400, height: 200, alphaPolygon: [[0, 0], [400, 0], [380, 200], [20, 200]] },
  sentinel: 'synthetic-corner-marker',
} as const;
