import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { bundleDigest, EvidenceBundleManifestSchema, JobSpecSchema, RenderEvidenceSchema, sha256Bytes } from '@ne-psd/contracts';
import { validateCorpus } from '../../packages/intelligence/dist/evaluation/run-corpus.js';
import { inspectImageQuality } from '../../packages/intelligence/dist/review/image-quality.js';

const root = new URL('../../', import.meta.url);
const fromRoot = (path: string) => new URL(path, root);
const rows = JSON.parse(await readFile(new URL('./fixtures/acceptance-corpus.json', import.meta.url), 'utf8')) as any[];
const frozen = JSON.parse(await readFile(fromRoot('docs/intelligence/qualification/visual-corpus-manifest.json'), 'utf8')) as any;
const descriptor = async (row: any) => JSON.parse(await readFile(fromRoot(row.fixture), 'utf8'));
const bytes = async (path: string) => new Uint8Array(await readFile(fromRoot(path)));

describe('fixed synthetic acceptance corpus', () => {
  it('contains exactly 64 immutable role-specific cases with the required group counts', () => {
    expect(() => validateCorpus(rows)).not.toThrow();
    expect(rows).toHaveLength(64);
    expect(Object.fromEntries([...new Set(rows.map((row) => row.group))].map((group) => [group, rows.filter((row) => row.group === group).length]))).toEqual({ 'planner-grounding': 12, 'runtime-review': 20, 'adversarial-json': 12, 'failure-context-capability': 12, 'diagnostic-visual': 8 });
    expect(new Set(rows.map((row) => row.fixture)).size).toBe(64);
    expect(rows.every((row) => row.fixture.startsWith('tests/intelligence/fixtures/acceptance/cases/'))).toBe(true);
    expect(frozen.foundationContractVersion).toBe(1);
    expect(frozen.syntheticOnly).toBe(true);
  });
  it('matches every frozen descriptor and original synthetic image digest', async () => {
    expect(sha256Bytes(await bytes('tests/intelligence/fixtures/acceptance-corpus.json'))).toBe(frozen.corpusSha256);
    expect(sha256Bytes(await bytes(frozen.generator))).toBe(frozen.generatorSha256);
    expect(frozen.descriptors).toHaveLength(64);
    for (const item of frozen.descriptors) {
      const content = await bytes(item.path);
      expect(sha256Bytes(content), item.id).toBe(item.sha256);
      expect((await stat(fromRoot(item.path))).isFile()).toBe(true);
    }
    for (const asset of frozen.assets) {
      const content = await bytes(asset.path);
      expect(content.byteLength, asset.name).toBe(asset.bytes);
      expect(sha256Bytes(content), asset.name).toBe(asset.sha256);
      const metadata = await sharp(content).metadata();
      expect([metadata.width, metadata.height, metadata.format], asset.name).toEqual([asset.width, asset.height, 'png']);
    }
  });
  it('keeps expected outcomes distinct from actionable adapter inputs and faults', async () => {
    const semantic = new Set<string>();
    for (const row of rows) {
      const caseFile = await descriptor(row);
      expect(caseFile).toMatchObject({ schemaVersion: 1, foundationContractVersion: 1, id: row.id, role: row.role });
      expect(caseFile).not.toHaveProperty('expected');
      if (row.role === 'planner') expect(caseFile.input.inspection.candidates.length).toBeGreaterThanOrEqual(5);
      if (row.role === 'diagnostic') expect(caseFile.input.diagnosticRequest.evidenceRefs).toContain('error.json');
      if (row.role === 'reviewer') expect(caseFile.input.manifest.visionInputs.length).toBeGreaterThanOrEqual(13);
      if (caseFile.mode === 'response-fault') expect(caseFile.responseFault.stage).toBe('after-live-model-response');
      const signature = JSON.stringify({ role: row.role, mode: caseFile.mode, input: caseFile.input, visual: caseFile.visualBundle?.seededDefect, fault: caseFile.responseFault ?? caseFile.preflightFault });
      expect(semantic.has(signature), row.id).toBe(false);
      semantic.add(signature);
      if (row.expected.kind === 'admitted') expect(row.expected.status).toMatch(/^(proposed|blocked|pass)$/);
      else expect(row.expected.failureCode).toBeTruthy();
    }
  });
  it('freezes exact and overflowing context packets and concrete capability faults', async () => {
    const byId = async (id: string) => descriptor(rows.find((row) => row.id === id));
    const total = (item: any) => { const p = item.preflightFault.parameters.syntheticExampleCounts; return p.systemTokens + p.userTokens + p.schemaTokens + p.wrapperTokens + p.imageTokens + p.reservedOutputTokens + p.safetyTokens; };
    const exact = await byId('FC04'), overInput = await byId('FC05'), overOutput = await byId('FC06');
    expect(total(exact)).toBe(exact.preflightFault.parameters.syntheticExampleCounts.runtimeContextTokens);
    expect(total(overInput)).toBeGreaterThan(overInput.preflightFault.parameters.syntheticExampleCounts.runtimeContextTokens);
    expect(total(overOutput)).toBeGreaterThan(overOutput.preflightFault.parameters.syntheticExampleCounts.runtimeContextTokens);
    for (const item of [exact, overInput, overOutput]) {
      expect(item.preflightFault.parameters.budgetRecipe.source).toBe('qualified-counter.countPacket');
      expect(item.preflightFault.parameters.budgetRecipe.onUnreachable).toBe('fixture-setup-failure');
      expect(item.preflightFault.parameters.budgetRecipe.variableField).toBe('/instruction');
    }
    expect((await byId('FC08')).preflightFault.parameters.profileCapabilities.jsonSchema).toBe(false);
    expect((await byId('FC09')).preflightFault.parameters.qualification.artifactVerified).toBe(false);
    expect((await byId('FC10')).preflightFault.parameters.profileCapabilities.vision).toBe(false);
    expect((await byId('FC11')).preflightFault.parameters.resources.os).not.toBe((await byId('FC11')).preflightFault.parameters.resources.expectedOs);
    expect((await byId('FC12')).responseFault).toMatchObject({ stage: 'after-live-model-response', field: 'transport.modelId', value: 'substitute-model' });
  });
  it('seals complete source/reference/output/detail file sets with exact hashes and crop pixels', async () => {
    const visual = rows.filter((row) => row.role === 'reviewer');
    expect(visual).toHaveLength(27);
    for (const row of visual) {
      const item = await descriptor(row); const input = item.input; const bundle = item.visualBundle;
      JobSpecSchema.parse(input.job); RenderEvidenceSchema.parse(input.evidence); EvidenceBundleManifestSchema.parse(input.manifest);
      expect(input.trustedState.sealedEvidenceSha256).toBe(bundleDigest(input.manifest));
      expect(bundle.images.map((image: any) => image.id)).toEqual(frozen.imageOrder.map((id: string) => id === 'source' ? 'source-design' : id));
      expect(bundle.images.filter((image: any) => image.role === 'output').map((image: any) => image.variantId)).toEqual(['1','2','3']);
      for (const file of input.manifest.files) {
        if (row.id === 'RR15' && file.relativePath === 'images/output-2.png') continue;
        const content = await bytes(`${input.bundleRoot}/${file.relativePath}`);
        expect(content.byteLength, `${row.id}:${file.relativePath}`).toBe(file.bytes);
        expect(sha256Bytes(content), `${row.id}:${file.relativePath}`).toBe(file.sha256);
      }
      for (const image of bundle.images) {
        if (row.id === 'RR15' && image.relativePath === 'images/output-2.png') continue;
        const content = await bytes(`${input.bundleRoot}/${image.relativePath}`);
        const metadata = await sharp(content).metadata();
        expect([metadata.width, metadata.height, metadata.format], `${row.id}:${image.id}`).toEqual([image.width, image.height, 'png']);
        if (image.role === 'detail') {
          if (row.id === 'RR15' && image.variantId === '2') continue;
          const origin = bundle.images.find((candidate: any) => candidate.role === 'output' && candidate.variantId === image.variantId);
          const originBytes = await bytes(`${input.bundleRoot}/${origin.relativePath}`);
          expect(image.derivedFromSha256).toBe(sha256Bytes(originBytes));
          const expectedPixels = await sharp(originBytes).extract({ left: image.crop.left, top: image.crop.top, width: image.crop.right - image.crop.left, height: image.crop.bottom - image.crop.top }).raw().toBuffer();
          expect(await sharp(content).raw().toBuffer()).toEqual(expectedPixels);
        }
      }
    }
  }, 20000);
  it('renders each named major or critical defect in real output pixels', async () => {
    const good = await descriptor(rows.find((row) => row.id === 'RR01'));
    const defects = rows.filter((row) => row.expected.criticalDefect);
    expect(defects).toHaveLength(12);
    for (const row of defects) {
      const item = await descriptor(row); const defect = item.visualBundle.seededDefect;
      expect(defect.severity).toMatch(/^(major|critical)$/);
      expect(defect.expectedVisualFact).toBeTruthy();
      const id = defect.variantId;
      const current = await bytes(`${item.input.bundleRoot}/images/output-${id}.png`);
      const baseline = await bytes(`${good.input.bundleRoot}/images/output-${id}.png`);
      expect(sha256Bytes(current), row.id).not.toBe(sha256Bytes(baseline));
      const region = defect.region;
      const extract = { left: region.left, top: region.top, width: region.right - region.left, height: region.bottom - region.top };
      const a = await sharp(current).extract(extract).raw().toBuffer(); const b = await sharp(baseline).extract(extract).raw().toBuffer();
      expect(a.some((value, index) => value !== b[index]), row.id).toBe(true);
    }
  });
  it('includes valid flat, contain, stretch, and distinct mixed comparison pixels', async () => {
    const ids = ['RR01','RR02','RR03','RR04','DV08'];
    const outputs = await Promise.all(ids.map(async (id) => { const item = await descriptor(rows.find((row) => row.id === id)); return Promise.all(['1','2','3'].map(async (variant) => sha256Bytes(await bytes(`${item.input.bundleRoot}/images/output-${variant}.png`)))); }));
    expect(new Set(outputs.map((list) => list.join(':'))).size).toBe(5);
    expect(outputs.every((list) => list.length === 3)).toBe(true);
  });
  it('provides sealed synthetic calibration and color proof for every positive reviewer bundle', async () => {
    for (const id of ['RR01','RR02','RR03','RR04','DV08']) {
      const item = await descriptor(rows.find((row) => row.id === id)); const input = item.input;
      expect(input.imageQualityPolicy.qualified).toBe(true);
      expect(input.imageQualityPolicy.profileSha256).toBe(input.job.profile.profileSha256);
      const traceFile = input.manifest.files.find((file: any) => file.relativePath === input.colorTraceSelection.relativePath);
      expect(traceFile.role).toBe('trace');
      const traceBytes = await bytes(`${input.bundleRoot}/${traceFile.relativePath}`);
      expect(sha256Bytes(traceBytes)).toBe(traceFile.sha256);
      const artifacts = await Promise.all(input.evidence.artifacts.map(async (artifact: any) => ({ variantId: Number(artifact.variantId), relativePath: artifact.path, bytes: await bytes(`${input.bundleRoot}/${artifact.path}`), sha256: artifact.sha256 })));
      const qa = await inspectImageQuality({ artifacts, output: input.job.profile.output, policy: input.imageQualityPolicy, colorEvidence: { traceBytes, traceSha256: traceFile.sha256, proofs: input.colorTraceSelection.proofs } });
      expect(qa.passed, `${id}: ${qa.reasons.join(',')}`).toBe(true);
      const sealedQa = JSON.parse(await readFile(fromRoot(`${input.bundleRoot}/reports/qa.json`), 'utf8'));
      const calibration = JSON.parse(await readFile(fromRoot(`${input.bundleRoot}/reports/qa-calibration.json`), 'utf8'));
      expect(sealedQa.passed).toBe(true); expect(calibration.scope).toBe('synthetic-corpus-only');
      expect(calibration.policySha256).toBe(input.imageQualityPolicy.policySha256);
    }
  });
});
