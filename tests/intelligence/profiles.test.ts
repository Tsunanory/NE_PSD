import { describe, expect, it } from 'vitest';
import { ModelProfileSchema } from '@ne-psd/contracts';
import { ModelProfileRegistry, inspectModelProfile, qualifyModelProfile, ModelQualificationSchema } from '@ne-psd/intelligence';
import { assertInvocationAllowed } from '@ne-psd/intelligence';

const sha = 'a'.repeat(64);
const local = (overrides: Record<string, unknown> = {}) => ModelProfileSchema.parse({
  profileId: 'fixture-local', provider: 'local-qwen', modelId: 'Qwen3.8-27B',
  provenance: { kind: 'local', artifactSha256: sha, runtimeVersion: 'llama.cpp@fixture', chatTemplateSha256: sha },
  endpoint: 'http://127.0.0.1:8080', quantization: 'Q4_K_M', contextTokens: 4096,
  maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: false, tools: true }, ...overrides,
});
const qualification = (profile: ReturnType<typeof local>, overrides: Record<string, unknown> = {}) => ModelQualificationSchema.parse({
  profile, stage: 'runtimeQualified', artifactVerified: true, runtimeQualified: true,
  evidencePaths: ['evidence/runtime.json'], errors: [], fixture: false,
  artifact: { sourceUrl: 'https://example.test/qwen', repository: 'qwen', revision: 'rev', architecture: 'arch', parameters: '27B', license: 'license', usageTerms: 'terms', files: [{ path: 'model.gguf', bytes: 1, sha256: sha }], quantization: 'Q4_K_M', converterRevision: null, tokenizer: 'tokenizer', chatTemplate: 'template', runtimeBuild: 'runtime', runtimeSettings: {}, shardManifestSha256: null, resources: { os: 'test', hardware: 'test', evidencePaths: ['evidence/resources.json'] } },
  ...overrides,
});
const trustedQualification = async (profile: ReturnType<typeof local>, overrides: Record<string, unknown> = {}) => (await qualifyModelProfile(profile, new AbortController().signal, { inspect: async () => ({ available: true, errors: [] }), qualify: async () => ({ qualified: true, evidencePaths: ['evidence/runtime.json'], errors: [], qualification: qualification(profile, overrides) }) })).qualification!;

describe('model profile qualification and selection', () => {
  it('rejects a requested Qwen profile whose artifact is unverified', async () => {
    const result = await inspectModelProfile(local(), new AbortController().signal);
    expect(result.available).toBe(false);
    expect(result.errors[0]?.code).toBe('MODEL_ARTIFACT_UNVERIFIED');
  });

  it('keeps fixture profiles visibly non-selectable', () => {
    const result = new ModelProfileRegistry().register({ ...local(), profileId: 'fixture-profile' }, { fixture: true });
    expect(result.selectable).toBe(false);
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile: result.profile, explicitSelection: true })).toThrow();
  });

  it('permits only explicit qualified interactive profiles', async () => {
    const profile = local({ profileId: 'qualified-local' });
    const registry = new ModelProfileRegistry(); registry.register(profile, { qualification: await trustedQualification(profile) });
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true, registry })).not.toThrow();
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true, profileQualified: true })).toThrow(/qualified/i);
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: false, qualification: qualification(profile) })).toThrow();
    expect(() => assertInvocationAllowed({ trigger: 'scheduled', jobKind: 'planning', profile, explicitSelection: true })).toThrow();
  });

  it('allows a qualified local vision reviewer and Codex only when explicitly selected', async () => {
    const vision = local({ profileId: 'qualified-vision', provider: 'local-vision', capabilities: { jsonSchema: true, vision: true, tools: true } });
    const codex = ModelProfileSchema.parse({ profileId: 'qualified-codex', provider: 'codex', modelId: 'codex', provenance: { kind: 'remote', provider: 'codex', modelId: 'codex', revision: 'rev', qualificationEvidencePath: 'evidence/codex.json' }, endpoint: 'codex://bridge', quantization: null, contextTokens: 4096, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: true, tools: true } });
    const registry = new ModelProfileRegistry(); registry.register(vision, { qualification: await trustedQualification(vision) }); registry.register(codex, { qualification: await trustedQualification(codex, { artifact: null, profile: codex }) });
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: vision, explicitSelection: true, registry })).not.toThrow();
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: codex, explicitSelection: true, registry })).not.toThrow();
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: codex, explicitSelection: false, qualification: qualification(codex, { artifact: null, profile: codex }) })).toThrow();
  });

  it('does not claim qualification merely from availability', async () => {
    const adapter = { inspect: async () => ({ available: true, errors: [] }), qualify: async () => ({ qualified: false, evidencePaths: [], errors: [] }) };
    const result = await qualifyModelProfile(local({ profileId: 'healthy-endpoint' }), new AbortController().signal, adapter);
    expect(result.qualified).toBe(false);
  });

  it('fails closed for absent qualification and rejects text-only visual review', () => {
    const profile = local({ profileId: 'text-only', capabilities: { jsonSchema: true, vision: false, tools: true } });
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile, explicitSelection: true, qualification: qualification(profile) })).toThrow(/vision|qualified/i);
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true })).toThrow(/qualified/i);
  });

  it('cancels and invalidates a qualification when evidence context changes', async () => {
    const controller = new AbortController();
    const adapter = { inspect: async () => ({ available: true, errors: [] }), qualify: async () => { controller.abort(); return { qualified: true, evidencePaths: ['evidence/report.json'], errors: [] }; } };
    await expect(qualifyModelProfile(local(), controller.signal, adapter)).rejects.toThrow(/aborted/i);
  });

  it('rejects qualification evidence bound to a different endpoint and unsafe evidence paths', async () => {
    const profile = local({ profileId: 'qualified-local' });
    const result = await qualifyModelProfile(profile, new AbortController().signal, {
      inspect: async () => ({ available: true, errors: [] }),
      qualify: async () => ({ qualified: true, evidencePaths: ['../outside.json'], errors: [], qualification: qualification({ ...profile, endpoint: 'http://127.0.0.1:9999' }) }),
    });
    expect(result.qualified).toBe(false);
    expect(result.errors[0]?.code).toMatch(/BINDING|EVIDENCE/);
  });

  it('rejects a forged caller qualification unless the registry admits the profile', () => {
    const profile = local({ profileId: 'forged-local' });
    const forged = qualification(profile);
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true, qualification: forged })).toThrow(/qualified/i);
    const registry = new ModelProfileRegistry();
    registry.register(profile, { qualification: forged });
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true, qualification: forged, registry })).toThrow(/qualified/i);
  });

  it('does not admit unsafe evidence paths through direct registry registration', () => {
    const profile = local({ profileId: 'unsafe-registry' });
    const registry = new ModelProfileRegistry();
    const result = registry.register(profile, { qualification: qualification(profile, { evidencePaths: ['../outside.json'] }) });
    expect(result.selectable).toBe(false);
    expect(result.qualification).toBeNull();
  });

  it('keeps registry admission immutable after caller mutation attempts', async () => {
    const profile = local({ profileId: 'immutable-registry' });
    const registry = new ModelProfileRegistry();
    const result = registry.register(profile, { qualification: await trustedQualification(profile) });
    try { (result as { selectable: boolean }).selectable = false; } catch { /* frozen boundary */ }
    try { (registry.get(profile.profileId) as { selectable: boolean }).selectable = false; } catch { /* frozen boundary */ }
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true, registry })).not.toThrow();
  });
});
