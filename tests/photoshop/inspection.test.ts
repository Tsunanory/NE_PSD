import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { InspectionReportSchema, validateQualificationRequest, type CapabilityReport } from '@ne-psd/contracts';
import { inspect, type InspectionAdapter } from '../../packages/photoshop/src/inspection.js';
import { sceneFixture } from './fixtures/scenes.js';

const MASTER = '/tmp/template.psd';
writeFileSync(MASTER, 'B05-owned-master');
const testLock = { runExclusive: async <T>(_id: string, fn: () => Promise<T>) => fn() } as const;

const capability: CapabilityReport = {
  backendId: 'alisaitteke', version: 'fake', sourceCommit: 'fake',
  supportedFitModes: ['cover', 'contain', 'stretch'], toolSchemaSha256: 'a'.repeat(64),
  platform: 'darwin', photoshopVersion: 'fake', evidencePaths: ['capabilities/fake.json'],
};

function adapter(overrides: Partial<InspectionAdapter> = {}): InspectionAdapter {
  const scene = sceneFixture();
  return {
    lock: testLock,
    listDocuments: async () => [scene.root, ...scene.documents.slice(1).map((d) => ({ ...d, layers: [] })) as never, { ...scene.unrelated, layers: [] } as never],
    openDocument: async () => ({ document: scene.root, opened: true }),
    readDocument: async (id) => id === scene.root.id ? scene.root : { ...scene.documents[1]!, layers: scene.childLayers ?? [] } as never,
    readLinkage: async () => ({ sourceKind: 'embedded', proven: true }),
    openContents: async (_id, layer) => ({ document: (layer.childDocument ?? { ...scene.root, id: 'opened-child', layers: scene.childLayers ?? [] }) as never, opened: true }),
    closeDiscard: async () => undefined,
    capabilities: async () => capability,
    ...overrides,
  };
}

describe('live/static candidate inspection', () => {
  it('normalizes nested graph and effective bounds, preserving user documents', async () => {
    const report = await inspect(MASTER, adapter());
    expect(report.evidenceStatus).toBe('liveObserved');
    expect(report.documents.some((doc) => doc.width === 3190 && doc.height === 1418)).toBe(true);
    expect(report.candidates.find((candidate) => candidate.roleHints.includes('reference'))?.bounds)
      .toEqual({ left: 100, top: 200, right: 900, bottom: 600 });
    expect(report.capabilities).toEqual(capability);
    expect(InspectionReportSchema.parse(report)).toEqual(report);
  });

  it('records zero raw vector bounds as live effective bounds', async () => {
    const scene = sceneFixture();
    const shape = scene.layers[0]!;
    shape.name = 'Vector zero raw'; shape.kind = 'shape'; shape.bounds = null;
    shape.rawBounds = null; shape.effectiveBounds = { left: 100, top: 200, right: 900, bottom: 600 };
    const report = await inspect(MASTER, adapter({ listDocuments: async () => [scene.root], readDocument: async () => scene.root }));
    expect(report.candidates.find((candidate) => candidate.bounds?.left === 100)?.bounds).toEqual({ left: 100, top: 200, right: 900, bottom: 600 });
  });

  it('blocks unknown linkage and does not invent a parent edge', async () => {
    const report = await inspect(MASTER, adapter({ readLinkage: async () => ({ sourceKind: 'unknown', proven: false, source: null }) }));
    expect(report.unresolvedLinks.length).toBeGreaterThan(0);
    expect(report.evidenceStatus).toBe('staticCandidate');
    expect(report.capabilities).toBeNull();
  });

  it('keeps duplicate selectors distinct and preserves user-open documents', async () => {
    const scene = sceneFixture();
    const duplicate = { ...scene.layers[2]!, id: 'duplicate', children: [] };
    scene.root.layers.push(duplicate);
    const closed: string[] = [];
    const report = await inspect(MASTER, adapter({
      listDocuments: async () => [scene.root, scene.documents[1]!, { ...scene.unrelated, layers: [] } as never],
      readDocument: async () => scene.root,
      closeDiscard: async (id) => { closed.push(id); },
    }));
    expect(new Set(report.candidates.map((candidate) => candidate.candidateId)).size).toBe(report.candidates.length);
    expect(report.documents.some((document) => document.width === 640)).toBe(false);
    expect(closed).toEqual([]);
  });

  it('forms a QualificationRequest from live inspection and a validated proposal without a TemplateProfile', async () => {
    const report = await inspect(MASTER, adapter());
    const target = report.candidates.find((candidate) => candidate.roleHints.includes('target'))!;
    const reference = report.candidates.find((candidate) => candidate.roleHints.includes('reference'))!;
    const variants = report.candidates.filter((candidate) => candidate.roleHints.includes('variant')).slice(0, 3);
    const proposal = {
      schemaVersion: 1 as const, inspectionId: report.inspectionId, status: 'proposed' as const,
      targets: [{ targetCandidateId: target.candidateId, referenceCandidateId: reference.candidateId, inputCandidateId: null }],
      variants: variants.map((candidate, index) => ({ id: String(index + 1) as '1' | '2' | '3', groupCandidateId: candidate.candidateId })) as [{ id: '1'; groupCandidateId: string }, { id: '2'; groupCandidateId: string }, { id: '3'; groupCandidateId: string }],
      fitMode: 'cover' as const,
      output: { format: 'jpeg' as const, quality: 90, colorSpace: 'sRGB' as const, width: 800, height: 600 },
      missingFields: [], facts: [{ claim: 'three variants', evidenceRefs: report.evidencePaths }], explanation: 'validated candidate proposal',
    };
    const request = validateQualificationRequest({ schemaVersion: 1, inspection: report, proposal, workingTemplatePath: '/tmp/template.psd', evidenceDirectory: '/tmp/evidence' });
    expect(request.success).toBe(true);
    expect('qualificationId' in proposal).toBe(false);
  });

  it('keeps static reports candidate-only with null capabilities', async () => {
    const report = await inspect(MASTER, adapter({ capabilities: undefined }));
    expect(report.evidenceStatus).toBe('staticCandidate');
    expect(report.capabilities).toBeNull();
  });

  it('serializes the whole lifecycle under the injected lock and writes trace evidence', async () => {
    let active = 0; let maximum = 0;
    const lock = { runExclusive: async <T>(_id: string, fn: () => Promise<T>) => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 2)); try { return await fn(); } finally { active -= 1; } } } as const;
    const evidence = '/tmp/b05-evidence';
    const report = await inspect(MASTER, adapter({ lock }), { evidenceDirectory: evidence, inspectionId: 'fixed-inspection' });
    expect(maximum).toBe(1);
    expect(report.inspectionId).toBe('fixed-inspection');
    expect(existsSync(`${evidence}/inspection/report.json`)).toBe(true);
    expect(existsSync(`${evidence}/inspection/trace.json`)).toBe(true);
  });
});
