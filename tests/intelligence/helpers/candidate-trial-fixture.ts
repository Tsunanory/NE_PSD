import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Bytes, type ModelProfile } from '@ne-psd/contracts';
import type { RuntimeProbe } from '../../../packages/intelligence/src/cli/qualify-model.js';
import type { QualifiedTokenCounter } from '../../../packages/intelligence/src/budget/qualified-token-count.js';

/** Isolated exact-byte artifact for testing the nonproduction qualification trial path. */
export async function createCandidateTrialFixture(role: 'planner' | 'reviewer' = 'reviewer') {
  const root = await mkdtemp(join(tmpdir(), 'ne-psd-candidate-trial-'));
  const bytes = Buffer.from('test-model-artifact');
  const artifactSha256 = sha256Bytes(bytes), chatTemplateSha256 = 'b'.repeat(64);
  const profile: ModelProfile = { profileId: `${role}-candidate`, provider: role === 'reviewer' ? 'local-vision' : 'local-qwen', modelId: 'fixture-runtime-model', provenance: { kind: 'local', artifactSha256, runtimeVersion: 'test-runtime', chatTemplateSha256 }, endpoint: 'http://127.0.0.1:1', quantization: 'Q8_0', contextTokens: 8192, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: role === 'reviewer', tools: false } };
  const manifest = { profile, stage: 'artifactVerified', artifactVerified: true, runtimeQualified: false, evidencePaths: ['probe.json'], errors: [], fixture: false, artifact: { sourceUrl: 'https://example.test/model', repository: 'unit-test', revision: 'exact-bytes', architecture: 'test', parameters: '27B', license: 'test', usageTerms: 'test', files: [{ path: 'model.gguf', bytes: bytes.length, sha256: artifactSha256 }], quantization: 'Q8_0', converterRevision: null, tokenizer: 'test-tokenizer', chatTemplate: 'test-template', runtimeBuild: 'test-runtime', runtimeSettings: {}, shardManifestSha256: null, resources: { os: process.platform, hardware: 'unit-test', evidencePaths: ['probe.json'] } } };
  const manifestPath = join(root, 'manifest.json');
  await writeFile(join(root, 'model.gguf'), bytes);
  await writeFile(join(root, 'probe.json'), '{}');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const probe: RuntimeProbe = { profileId: profile.profileId, modelId: profile.modelId, artifactSha256, chatTemplateSha256, tokenizerId: 'test-tokenizer', runtimeBuild: 'test-runtime', contextTokens: 8192, maxOutputTokens: 512, jsonSchema: true, vision: role === 'reviewer', imageInput: role === 'reviewer', visionLimits: role === 'reviewer' ? { maxImages: 20, maxWidth: 512, maxHeight: 384, maxPixels: 512 * 384, maxBytes: 5_000_000, maxDecodedBytes: 512 * 384 * 4 } : null, qualifiedTransport: true, qualifiedSampling: true, evidenceRefs: ['probe.json'] };
  const counter: QualifiedTokenCounter = { profileId: profile.profileId, provenance: profile.provenance, qualificationEvidencePath: 'probe.json', tokenizerId: 'test-tokenizer', chatTemplateId: 'test-template', runtimeBuild: 'test-runtime', runtimeContextTokens: 8192, countPacket(request) { return { systemTokens: 100, userTokens: 200, schemaTokens: 100, wrapperTokens: 20, imageTokens: Array.isArray(request.messages[1].content) ? 200 : 0 }; } };
  return { root, manifestPath, profile, probe, counter, close: () => rm(root, { recursive: true, force: true }) };
}
