import { describe, expect, it } from 'vitest';
import { ModelProfileSchema } from '@ne-psd/contracts';
import { ModelProfileRegistry, inspectModelProfile, qualifyModelProfile } from '@ne-psd/intelligence';
import { assertInvocationAllowed } from '@ne-psd/intelligence';

const sha = 'a'.repeat(64);
const local = (overrides: Record<string, unknown> = {}) => ModelProfileSchema.parse({
  profileId: 'fixture-local', provider: 'local-qwen', modelId: 'Qwen3.8-27B',
  provenance: { kind: 'local', artifactSha256: sha, runtimeVersion: 'llama.cpp@fixture', chatTemplateSha256: sha },
  endpoint: 'http://127.0.0.1:8080', quantization: 'Q4_K_M', contextTokens: 4096,
  maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: false, tools: true }, ...overrides,
});

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

  it('permits only explicit qualified interactive profiles', () => {
    const profile = local({ profileId: 'qualified-local' });
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true, profileQualified: true })).not.toThrow();
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: false })).toThrow();
    expect(() => assertInvocationAllowed({ trigger: 'scheduled', jobKind: 'planning', profile, explicitSelection: true })).toThrow();
  });

  it('allows a qualified local vision reviewer and Codex only when explicitly selected', () => {
    const vision = local({ profileId: 'qualified-vision', provider: 'local-vision', capabilities: { jsonSchema: true, vision: true, tools: true } });
    const codex = ModelProfileSchema.parse({ profileId: 'qualified-codex', provider: 'codex', modelId: 'codex', provenance: { kind: 'remote', provider: 'codex', modelId: 'codex', revision: 'rev', qualificationEvidencePath: 'evidence/codex.json' }, endpoint: 'codex://bridge', quantization: null, contextTokens: 4096, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: true, tools: true } });
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: vision, explicitSelection: true, profileQualified: true })).not.toThrow();
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: codex, explicitSelection: true, profileQualified: true })).not.toThrow();
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: codex, explicitSelection: false })).toThrow();
  });

  it('does not claim qualification merely from availability', async () => {
    const adapter = { inspect: async () => ({ available: true, errors: [] }), qualify: async () => ({ qualified: false, evidencePaths: [], errors: [] }) };
    const result = await qualifyModelProfile(local({ profileId: 'healthy-endpoint' }), new AbortController().signal, adapter);
    expect(result.qualified).toBe(false);
  });

  it('fails closed for absent qualification and rejects text-only visual review', () => {
    const profile = local({ profileId: 'text-only', capabilities: { jsonSchema: true, vision: false, tools: true } });
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile, explicitSelection: true })).toThrow(/vision|qualified/i);
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile, explicitSelection: true, profileQualified: false })).toThrow(/qualified/i);
  });

  it('cancels and invalidates a qualification when evidence context changes', async () => {
    const controller = new AbortController();
    const adapter = { inspect: async () => ({ available: true, errors: [] }), qualify: async () => { controller.abort(); return { qualified: true, evidencePaths: ['evidence/report.json'], errors: [] }; } };
    await expect(qualifyModelProfile(local(), controller.signal, adapter)).rejects.toThrow(/aborted/i);
  });
});
