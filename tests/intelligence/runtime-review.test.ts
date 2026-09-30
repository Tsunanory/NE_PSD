import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { bundleDigest, canonicalize, sha256Bytes, sha256Json, type ReviewDecision } from '@ne-psd/contracts';
import { RuntimeIntelligenceService, createReviewPolicy, loadPrompt, MANDATORY_REQUIREMENTS } from '@ne-psd/intelligence';
import { createReviewFixture } from './helpers/review-fixture.js';

const digest = 'a'.repeat(64);
const profile: any = { profileId: 'reviewer', provider: 'local-vision', modelId: 'vision-model', provenance: { kind: 'local', artifactSha256: digest, runtimeVersion: 'runtime', chatTemplateSha256: digest }, endpoint: 'http://127.0.0.1:1', quantization: 'Q8_0', contextTokens: 8192, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: true, tools: false } };
const qualification: any = { runtimeQualified: true, evidencePaths: ['qualification.json'], artifact: { tokenizer: 'tokenizer', chatTemplate: 'template', runtimeBuild: 'runtime', runtimeSettings: { contextTokens: '8192', visionInputQualified: 'true', visionMaxImages: '10', visionMaxWidth: '10', visionMaxHeight: '10', visionMaxPixels: '100', visionMaxTotalBytes: '100000', visionMaxDecodedBytes: '400', visionMaxTotalDecodedBytes: '4000' } } };
const baseRecord: any = { profile, qualification, selectable: true };
const png = (red: number) => sharp({ create: { width: 10, height: 10, channels: 4, background: { r: red, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
const text = (value: unknown) => Buffer.from(JSON.stringify(value));

async function setup(gate: 'qualifiedVisionReviewer' | 'humanPerAsset' = 'qualifiedVisionReviewer') {
  const record = structuredClone(baseRecord);
  const fixture = await createReviewFixture(gate);
  const prompt = await loadPrompt(gate === 'humanPerAsset' ? 'manual-reviewer' : 'runtime-reviewer');
  const policy = createReviewPolicy({ visualGate: gate, promptSha256: prompt.sha256 });
  const source = await png(30);
  const variants = await Promise.all([70, 100, 130].map(png));
  const contents = new Map<string, Uint8Array>();
  contents.set('source.png', source);
  const artifacts = fixture.evidence.artifacts.map((artifact, index) => {
    const bytes = variants[index]!;
    contents.set(artifact.path, bytes);
    return { ...artifact, sha256: sha256Bytes(bytes), bytes: bytes.length };
  }) as typeof fixture.evidence.artifacts;
  const checks = MANDATORY_REQUIREMENTS.filter((row) => row.evaluator === 'deterministic').map((row) => ({ id: row.id, passed: true, evidencePath: `checks/${row.id}.json` }));
  for (const check of checks) contents.set(check.evidencePath, text({ passed: true, id: check.id }));
  const qualityBase: any = { qualified: true, profileSha256: fixture.job.profile.profileSha256, templateSha256: fixture.job.profile.template.sha256, backendQualificationSha256: digest, transformId: 'qualified-srgb', output: fixture.job.profile.output, maxInputBytes: 100000, maxPixels: 100, maxDecodedBytes: 400, backgroundRgb: [255, 255, 255], foregroundDistance: 20, alphaThreshold: 128, metrics: { minForegroundFraction: 0.1 } };
  const quality = { ...qualityBase, policySha256: sha256Json(qualityBase) };
  const proofs = artifacts.map((artifact) => ({ variantId: Number(artifact.variantId) as 1 | 2 | 3, artifactSha256: artifact.sha256, profileSha256: quality.profileSha256, templateSha256: quality.templateSha256, backendQualificationSha256: quality.backendQualificationSha256, transformId: quality.transformId, outputColorSpace: 'sRGB' as const }));
  contents.set('traces/document.json', text({ colorExports: proofs }));
  contents.set('traces/tool.json', text({ tools: [] }));
  const job = { ...fixture.job, assets: [{ ...fixture.job.assets[0]!, source: { ...fixture.job.assets[0]!.source, sha256: sha256Bytes(source) }, sourceBytes: source.length }], reviewPolicySha256: policy.policySha256 };
  const evidence = { ...fixture.evidence, sourceSha256: sha256Bytes(source), artifacts, checks };
  contents.set('render-evidence.json', text(evidence));
  const visionInputs: typeof fixture.manifest.visionInputs = [{ id: 'source', role: 'source', relativePath: 'source.png', sha256: sha256Bytes(source), width: 10, height: 10, variantId: null, derivedFromSha256: sha256Bytes(source), crop: null }];
  for (const artifact of artifacts) {
    const id = artifact.variantId;
    const output = contents.get(artifact.path)!;
    const reference = await png(20);
    const detail = await sharp(output).extract({ left: 1, top: 1, width: 4, height: 4 }).png().toBuffer();
    contents.set(`references/${id}.png`, reference);
    contents.set(`details/${id}.png`, detail);
    visionInputs.push({ id: `reference-${id}`, role: 'reference', relativePath: `references/${id}.png`, sha256: sha256Bytes(reference), width: 10, height: 10, variantId: id, derivedFromSha256: sha256Bytes(reference), crop: null });
    visionInputs.push({ id: `output-${id}`, role: 'output', relativePath: artifact.path, sha256: artifact.sha256, width: 10, height: 10, variantId: id, derivedFromSha256: artifact.sha256, crop: null });
    visionInputs.push({ id: `detail-${id}`, role: 'detail', relativePath: `details/${id}.png`, sha256: sha256Bytes(detail), width: 4, height: 4, variantId: id, derivedFromSha256: artifact.sha256, crop: { left: 1, top: 1, right: 5, bottom: 5 } });
  }
  if (gate === 'humanPerAsset') { contents.set('contact.png', await png(30)); contents.set('attestation.json', text({ approved: true })); }
  const files = [...contents].map(([relativePath, bytes]) => ({ relativePath, sha256: sha256Bytes(bytes), bytes: bytes.length, role: relativePath === 'render-evidence.json' ? 'renderEvidence' as const : relativePath === 'attestation.json' ? 'humanAttestation' as const : relativePath.startsWith('outputs/') ? 'artifact' as const : relativePath.startsWith('checks/') ? 'check' as const : relativePath.startsWith('traces/') ? 'trace' as const : 'imageInput' as const })).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const manifest = { ...fixture.manifest, files, visionInputs };
  const preAttestationContentSha256 = bundleDigest({ ...manifest, files: files.filter((file) => file.role !== 'humanAttestation') });
  const attestation: any = gate === 'humanPerAsset' ? { request: { requestId: 'request-1', jobId: job.jobId, assetId: 'asset-1', attempt: 1, preAttestationContentSha256, profileSha256: job.profile.profileSha256, sourceSha256: evidence.sourceSha256, toolSchemaSha256: evidence.toolSchemaSha256, reviewPolicySha256: policy.policySha256, artifacts, contactSheet: { relativePath: 'contact.png', sha256: sha256Bytes(contents.get('contact.png')!) } }, decision: 'approve', operatorIdentity: 'fixture-operator', consumed: true, consumedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), attestationRelativePath: 'attestation.json', attestationSha256: sha256Bytes(contents.get('attestation.json')!) } : null;
  const state = { job, currentAttempt: 1 as const, sealed: true as const, sealedEvidenceSha256: bundleDigest(manifest) };
  for (const [path, bytes] of contents) { const target = join(fixture.root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, bytes); }
  let calls = 0;
  let makeDecision = (packet: any): ReviewDecision => {
    const content = packet.messages[1].content;
    const user = JSON.parse(typeof content === 'string' ? content : content[0].text);
    return { schemaVersion: 1, reviewId: user.reviewId, jobId: job.jobId, assetId: 'asset-1', attempt: 1, evidenceSha256: state.sealedEvidenceSha256, sessionId: packet.sessionId, promptSha256: prompt.sha256, modelId: profile.modelId, modelProvenance: profile.provenance, reviewerVersion: 'qualified-test', reviewPolicySha256: policy.policySha256, verdict: 'pass', variantChecks: artifacts.map((artifact) => ({ variantId: artifact.variantId, verdict: 'pass', evidenceRefs: [artifact.path], reason: `Variant ${artifact.variantId} image is complete and visually clear.` })) as ReviewDecision['variantChecks'], checks: MANDATORY_REQUIREMENTS.map((row) => ({ requirementId: row.id, result: 'pass', evidenceRefs: [checks[0]!.evidencePath], reason: 'Verified against sealed evidence.' })), findings: [] };
  };
  const transport = { async invoke(packet: any) { calls++; return { raw: text(makeDecision(packet)), modelId: profile.modelId, finishReason: 'stop' as const, usage: { inputTokens: 100, outputTokens: 100 }, providerRevision: null, sessionId: packet.sessionId }; } };
  const counter: any = { profileId: profile.profileId, provenance: profile.provenance, qualificationEvidencePath: 'qualification.json', tokenizerId: 'tokenizer', chatTemplateId: 'template', runtimeBuild: 'runtime', runtimeContextTokens: 8192, countPacket(packet: any) { return { systemTokens: 100, userTokens: 200, schemaTokens: 100, wrapperTokens: 20, imageTokens: Array.isArray(packet.messages[1].content) ? 200 : 0 }; } };
  const service = new RuntimeIntelligenceService({ registry: { get: () => record } as any, transport, counterFor: () => counter, readAttempt: async () => state, readLimits: { maxFiles: 100, maxFileBytes: 100000, maxTotalBytes: 1000000 }, resolveAttemptRoot: async () => fixture.root, imageQualityPolicy: async () => quality, colorTrace: async () => ({ relativePath: 'traces/document.json', proofs }), readTrustedAttestation: async () => attestation, safeCleanup: async () => true, admissibleCorrections: async () => [] });
  return { fixture, service, job, policy, manifest, evidence, state, contents, transport, counter, record, attestation, get calls() { return calls; }, setDecision(fn: typeof makeDecision) { makeDecision = fn; }, decision: makeDecision };
}

const active: { close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map((item) => item.close())); });
const create = async (gate?: 'qualifiedVisionReviewer' | 'humanPerAsset') => { const value = await setup(gate); active.push(value.fixture); return value; };
const review = (value: Awaited<ReturnType<typeof setup>>) => value.service.review({ manifest: value.manifest, evidence: value.evidence, policy: value.policy }, profile.profileId, new AbortController().signal);

describe('runtime review visual gate', () => {
  it('passes three decoded variants with all ten image attachments and complete checks', async () => {
    const value = await create();
    const packet: any[] = [];
    value.transport.invoke = async (request: any) => { packet.push(request); return { raw: text(value.decision(request)), modelId: profile.modelId, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 100 }, providerRevision: null, sessionId: request.sessionId }; };
    const result = await review(value);
    expect(result.verdict).toBe('pass');
    expect(packet).toHaveLength(1);
    expect(packet[0].messages[1].content.filter((part: any) => part.type === 'image')).toHaveLength(10);
    expect(result.checks).toHaveLength(15);
  });
  it('uses consumed human attestation with a text-only reviewer packet', async () => {
    const value = await create('humanPerAsset');
    const packets: any[] = [];
    value.transport.invoke = async (request: any) => { packets.push(request); return { raw: text(value.decision(request)), modelId: profile.modelId, finishReason: 'stop', usage: null, providerRevision: null, sessionId: request.sessionId }; };
    expect((await review(value)).verdict).toBe('pass');
    expect(typeof packets[0].messages[1].content).toBe('string');
  });
  it('rejects an unconsumed human attestation before inference', async () => {
    const value = await create('humanPerAsset');
    value.attestation.consumed = false;
    await expect(review(value)).rejects.toThrow(/ATTESTATION_MISSING/);
    expect(value.calls).toBe(0);
  });
  it.each(['missing', 'fourth'] as const)('rejects %s variant response', async (kind) => {
    const value = await create();
    value.setDecision((packet) => { const decision = value.decision(packet); return { ...decision, variantChecks: kind === 'missing' ? decision.variantChecks.slice(0, 2) : [...decision.variantChecks, decision.variantChecks[0]] } as ReviewDecision; });
    await expect(review(value)).rejects.toThrow();
  });
  it('rejects incomplete check set and severe finding despite aggregate pass', async () => {
    const value = await create();
    value.setDecision((packet) => ({ ...value.decision(packet), checks: value.decision(packet).checks.slice(1) }));
    await expect(review(value)).rejects.toMatchObject({ code: 'REVIEW_CHECK_SET_INVALID' });
  });
  it.each([
    ['duplicate check', (decision: any) => ({ ...decision, checks: [...decision.checks.slice(0, -1), decision.checks[0]] }), 'REVIEW_CHECK_SET_INVALID'],
    ['wrong session', (decision: any) => ({ ...decision, sessionId: 'prior-session' }), 'REVIEW_BINDING_MISMATCH'],
    ['wrong attempt', (decision: any) => ({ ...decision, attempt: 2 }), 'REVIEW_BINDING_MISMATCH'],
    ['wrong evidence digest', (decision: any) => ({ ...decision, evidenceSha256: digest }), 'REVIEW_BINDING_MISMATCH'],
    ['wrong model provenance', (decision: any) => ({ ...decision, modelProvenance: { ...decision.modelProvenance, artifactSha256: 'b'.repeat(64) } }), 'REVIEW_BINDING_MISMATCH'],
    ['unknown cited evidence', (decision: any) => ({ ...decision, checks: [{ ...decision.checks[0], evidenceRefs: ['not-in-manifest.json'] }, ...decision.checks.slice(1)] }), 'REVIEW_REFERENCE_UNKNOWN'],
    ['wrong variant binding', (decision: any) => ({ ...decision, variantChecks: [{ ...decision.variantChecks[0], evidenceRefs: [decision.variantChecks[1].evidenceRefs[0]] }, ...decision.variantChecks.slice(1)] }), 'REVIEW_VARIANT_BINDING_INVALID'],
    ['host check contradicted', (decision: any) => ({ ...decision, verdict: 'blocked', checks: [{ ...decision.checks[0], result: 'fail' }, ...decision.checks.slice(1)] }), 'REVIEW_HOST_CHECK_CONTRADICTION'],
    ['severe finding with pass', (decision: any) => ({ ...decision, findings: [{ severity: 'major', code: 'VISUAL_DEFECT', evidenceRefs: [decision.variantChecks[0].evidenceRefs[0]], message: 'visible defect' }] }), 'REVIEW_FALSE_PASS'],
    ['unapproved correction', (decision: any) => ({ ...decision, verdict: 'revise', findings: [{ severity: 'major', code: 'REAPPLY_APPROVED_CONFIGURATION', evidenceRefs: [decision.variantChecks[0].evidenceRefs[0]], message: 'proposal' }] }), 'REVIEW_REVISION_UNQUALIFIED'],
  ])('rejects %s', async (_name, mutate, code) => {
    const value = await create();
    value.setDecision((packet) => mutate(value.decision(packet)));
    await expect(review(value)).rejects.toMatchObject({ code });
  });
  it('blocks absent qualified image limits before any model call', async () => {
    const value = await create();
    value.record.qualification.artifact.runtimeSettings.visionMaxImages = undefined;
    await expect(review(value)).rejects.toMatchObject({ code: 'REVIEW_VISION_UNQUALIFIED' });
    expect(value.calls).toBe(0);
  });
  it('blocks an image-count limit below the complete packet before inference', async () => {
    const value = await create();
    value.record.qualification.artifact.runtimeSettings.visionMaxImages = '9';
    await expect(review(value)).rejects.toMatchObject({ code: 'REVIEW_IMAGE_LIMIT' });
    expect(value.calls).toBe(0);
  });
  it('rejects failed deterministic evidence despite a model prepared to pass', async () => {
    const value = await create();
    value.evidence.checks[0]!.passed = false;
    await expect(review(value)).rejects.toThrow();
    expect(value.calls).toBe(0);
  });
  it('rejects a corrupt or removed image before inference', async () => {
    const value = await create();
    await writeFile(join(value.fixture.root, 'source.png'), Buffer.from('not an image'));
    await expect(review(value)).rejects.toThrow(/EVIDENCE_INVALID/);
    expect(value.calls).toBe(0);
  });
  it('detects image bytes changed after inference and a renamed bundle root', async () => {
    const value = await create();
    value.transport.invoke = async (request: any) => {
      await writeFile(join(value.fixture.root, 'source.png'), Buffer.from('changed'));
      return { raw: text(value.decision(request)), modelId: profile.modelId, finishReason: 'stop', usage: null, providerRevision: null, sessionId: request.sessionId };
    };
    await expect(review(value)).rejects.toThrow(/EVIDENCE_INVALID/);
    const next = await create();
    const moved = `${next.fixture.root}-moved`;
    next.transport.invoke = async (request: any) => {
      await rename(next.fixture.root, moved);
      return { raw: text(next.decision(request)), modelId: profile.modelId, finishReason: 'stop', usage: null, providerRevision: null, sessionId: request.sessionId };
    };
    await expect(review(next)).rejects.toThrow(/EVIDENCE_INVALID/);
    await rename(moved, next.fixture.root);
  });
  it('blocks context overflow before transport', async () => {
    const value = await create();
    value.counter.countPacket = () => ({ systemTokens: 9000, userTokens: 200, schemaTokens: 100, wrapperTokens: 20, imageTokens: 200 });
    await expect(review(value)).rejects.toThrow();
    expect(value.calls).toBe(0);
  });
});
