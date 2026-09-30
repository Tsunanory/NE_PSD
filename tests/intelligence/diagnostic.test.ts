import { describe, expect, it, vi } from 'vitest';
import { ModelProfileSchema } from '@ne-psd/contracts';
import { admittedActions, diagnose, DiagnosticModelError, loadPrompt, ModelProfileRegistry, ModelQualificationSchema, qualifyModelProfile } from '@ne-psd/intelligence';

const sha = 'a'.repeat(64);
const profile = ModelProfileSchema.parse({ profileId: 'diagnostic-qualified', provider: 'local-qwen', modelId: 'Qwen3.8-27B', provenance: { kind: 'local', artifactSha256: sha, runtimeVersion: 'runtime', chatTemplateSha256: sha }, endpoint: 'http://127.0.0.1:1', quantization: 'Q4_K_M', contextTokens: 4096, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: false, tools: false } });
const tokenCounter = { profileId: profile.profileId, provenance: profile.provenance, qualificationEvidencePath: 'evidence/runtime.json', tokenizerId: 'tokenizer', chatTemplateId: 'template', runtimeBuild: 'runtime', runtimeContextTokens: profile.contextTokens, countPacket: () => ({ systemTokens: 1, userTokens: 1, schemaTokens: 1, wrapperTokens: 1, imageTokens: 0 }) };
const registry = async () => {
  const qualification = ModelQualificationSchema.parse({ profile, stage: 'runtimeQualified', artifactVerified: true, runtimeQualified: true, evidencePaths: ['evidence/runtime.json'], errors: [], fixture: false, artifact: { sourceUrl: 'https://example.test/model', repository: 'qwen', revision: 'rev', architecture: 'arch', parameters: '27B', license: 'license', usageTerms: 'terms', files: [{ path: 'model.gguf', bytes: 1, sha256: sha }], quantization: 'Q4_K_M', converterRevision: null, tokenizer: 'tokenizer', chatTemplate: 'template', runtimeBuild: 'runtime', runtimeSettings: { contextTokens: '4096' }, shardManifestSha256: null, resources: { os: 'test', hardware: 'test', evidencePaths: ['evidence/resources.json'] } } });
  const admission = await qualifyModelProfile(profile, new AbortController().signal, { inspect: async () => ({ available: true, errors: [] }), qualify: async () => ({ qualified: true, evidencePaths: ['evidence/runtime.json'], errors: [], qualification }) });
  const result = new ModelProfileRegistry(); result.register(profile, { qualification: admission.qualification }); return result;
};
const request = async (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, kind: 'diagnostic' as const, requestId: 'req', sessionId: 'session', promptSha256: (await loadPrompt('diagnostic')).sha256, subjectId: 'asset-1', evidenceSha256: sha, evidenceRefs: ['error.json'], attempt: 1 as const, domainError: { code: 'PHOTOSHOP_MUTATION_TIMEOUT', category: 'ambiguousState' as const, message: 'Observed timeout', retryable: true, evidencePaths: ['error.json'] }, allowedActions: ['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED'], ...overrides });
const output = (input: Awaited<ReturnType<typeof request>>, overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, requestId: input.requestId, sessionId: input.sessionId, promptSha256: input.promptSha256, subjectId: input.subjectId, evidenceSha256: input.evidenceSha256, status: 'blocked', observations: ['Observed timeout'], unknowns: ['Photoshop state'], cause: { code: 'PHOTOSHOP_MUTATION_TIMEOUT', summary: 'state unknown', evidenceRefs: ['error.json'] }, actionCode: 'OPERATOR_RECOVERY_REQUIRED', actionReason: 'state unknown', evidenceRefs: ['error.json'], ...overrides });
const options = () => ({ signal: new AbortController().signal, tokenCounter, visualAttestation: true });
const transport = (value: unknown) => ({ invoke: vi.fn(async (input: any) => ({ raw: new TextEncoder().encode(JSON.stringify(value)), modelId: input.profile.modelId, finishReason: 'stop' as const, usage: null, providerRevision: null, sessionId: input.sessionId })) });
const run = async (input: Awaited<ReturnType<typeof request>>, value: unknown, overrides: Record<string, unknown> = {}) => diagnose(input, transport(value), profile.profileId, await registry(), { ...options(), ...overrides });

describe('constrained diagnostic', () => {
  it('admits only recovery or wait after ambiguous Photoshop mutation timeout', () => {
    expect(admittedActions({ attempt: 1, allowedActions: ['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED', 'RETRY_FRESH_COPY'], domainError: { code: 'PHOTOSHOP_MUTATION_TIMEOUT', category: 'ambiguousState' }, safeCleanup: true, knownCause: true, correctionCode: 'REAPPLY_APPROVED_CONFIGURATION', visualAttestation: true })).toEqual(['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED']);
  });
  it('routes unsupported operations to backend requalification', () => {
    expect(admittedActions({ attempt: 1, allowedActions: ['REQUALIFY_BACKEND', 'CORRECT_CONFIGURATION', 'RETRY_FRESH_COPY'], domainError: { code: 'UNSUPPORTED_OPERATION', category: 'capability' }, safeCleanup: true, knownCause: true, correctionCode: 'REAPPLY_APPROVED_CONFIGURATION', visualAttestation: true })).toEqual(['REQUALIFY_BACKEND']);
  });
  it('excludes retry after attempt 2 even with other prerequisites', () => {
    expect(admittedActions({ attempt: 2, allowedActions: ['OPERATOR_RECOVERY_REQUIRED', 'RETRY_FRESH_COPY'], domainError: { code: 'KNOWN_TRANSIENT', category: 'transient' }, safeCleanup: true, knownCause: true, correctionCode: 'REAPPLY_APPROVED_CONFIGURATION', visualAttestation: true })).toEqual(['OPERATOR_RECOVERY_REQUIRED']);
  });
  it('excludes correction and retry without current visual attestation', () => {
    expect(admittedActions({ attempt: 1, allowedActions: ['OPERATOR_RECOVERY_REQUIRED', 'CORRECT_CONFIGURATION', 'RETRY_FRESH_COPY'], domainError: { code: 'KNOWN_REVIEW', category: 'review' }, safeCleanup: true, knownCause: true, correctionCode: 'REAPPLY_APPROVED_CONFIGURATION', visualAttestation: false })).toEqual(['OPERATOR_RECOVERY_REQUIRED']);
  });
  it('does not treat knownCause alone or an unknown correction as retry authority', () => {
    const base = { attempt: 1 as const, allowedActions: ['OPERATOR_RECOVERY_REQUIRED', 'RETRY_FRESH_COPY'], domainError: { code: 'UNLISTED_ERROR', category: 'transient' }, safeCleanup: true, knownCause: true, visualAttestation: true };
    expect(admittedActions(base)).toEqual(['OPERATOR_RECOVERY_REQUIRED']);
    expect(admittedActions({ ...base, correctionCode: 'UNLISTED_CORRECTION' })).toEqual(['OPERATOR_RECOVERY_REQUIRED']);
    expect(admittedActions({ ...base, correctionCode: 'REAPPLY_APPROVED_CONFIGURATION' })).toEqual(['OPERATOR_RECOVERY_REQUIRED']);
  });
  it('admits retry only for an allowlisted cause and coordinator correction', () => {
    expect(admittedActions({ attempt: 1, allowedActions: ['RETRY_FRESH_COPY'], domainError: { code: 'CONFIGURATION_DRIFT', category: 'review' }, safeCleanup: true, knownCause: true, correctionCode: 'REAPPLY_APPROVED_CONFIGURATION', visualAttestation: true })).toEqual(['RETRY_FRESH_COPY']);
  });
  for (const scenario of [
    { label: 'timeout wait', domainError: { code: 'PHOTOSHOP_MUTATION_TIMEOUT', category: 'ambiguousState', message: 'Timeout', retryable: true, evidencePaths: ['error.json'] }, attempt: 1, visualAttestation: true, expected: ['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED'], actionCode: 'WAIT_FOR_REQUIRED_EVIDENCE' },
    { label: 'unsupported backend', domainError: { code: 'UNSUPPORTED_OPERATION', category: 'capability', message: 'Unsupported', retryable: false, evidencePaths: ['error.json'] }, attempt: 1, visualAttestation: true, expected: ['REQUALIFY_BACKEND'], actionCode: 'REQUALIFY_BACKEND' },
    { label: 'attempt 2', domainError: { code: 'CONFIGURATION_DRIFT', category: 'review', message: 'Drift', retryable: true, evidencePaths: ['error.json'] }, attempt: 2, visualAttestation: true, expected: ['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED', 'REQUALIFY_BACKEND', 'CORRECT_CONFIGURATION'], actionCode: 'OPERATOR_RECOVERY_REQUIRED' },
    { label: 'missing attestation', domainError: { code: 'CONFIGURATION_DRIFT', category: 'review', message: 'Drift', retryable: true, evidencePaths: ['error.json'] }, attempt: 1, visualAttestation: false, expected: ['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED', 'REQUALIFY_BACKEND'], actionCode: 'OPERATOR_RECOVERY_REQUIRED' },
  ] as const) {
    it(`sends only admitted actions for ${scenario.label}`, async () => {
      const input = await request({ domainError: scenario.domainError, attempt: scenario.attempt, allowedActions: ['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED', 'REQUALIFY_BACKEND', 'CORRECT_CONFIGURATION', 'RETRY_FRESH_COPY'] });
      const fake = transport(output(input, { actionCode: scenario.actionCode }));
      const result = await diagnose(input, fake, profile.profileId, await registry(), { ...options(), safeCleanup: true, knownCause: true, correctionCode: 'REAPPLY_APPROVED_CONFIGURATION', visualAttestation: scenario.visualAttestation });
      expect(result.actionCode).toBe(scenario.actionCode);
      expect(fake.invoke).toHaveBeenCalledTimes(1);
      const sent = fake.invoke.mock.calls[0][0] as any;
      expect(JSON.parse(sent.messages[1].content).allowedActions).toEqual(scenario.expected);
      expect(sent.messages).toHaveLength(2); expect(sent).not.toHaveProperty('tools');
    });
  }
  it('rejects prompt hash mismatch before transport', async () => {
    const input = await request({ promptSha256: sha }); const fake = transport(output(input));
    await expect(diagnose(input, fake, profile.profileId, await registry(), options())).rejects.toThrow(/PROMPT_HASH/);
    expect(fake.invoke).not.toHaveBeenCalled();
  });
  it('normalizes malformed JSON and schema failures to DiagnosticModelError', async () => {
    const input = await request();
    for (const value of [{ unknown: true }, { ...output(input), observations: 'wrong type' }]) {
      await expect(run(input, value)).rejects.toBeInstanceOf(DiagnosticModelError);
    }
    const malformed = { invoke: vi.fn(async (sent: any) => ({ raw: new TextEncoder().encode('{"schemaVersion":1,'), modelId: sent.profile.modelId, finishReason: 'stop' as const, usage: null, providerRevision: null, sessionId: sent.sessionId })) };
    await expect(diagnose(input, malformed, profile.profileId, await registry(), options())).rejects.toBeInstanceOf(DiagnosticModelError);
  });
  for (const field of ['requestId', 'sessionId', 'promptSha256', 'subjectId', 'evidenceSha256'] as const) {
    it(`rejects a stale ${field} echo independently`, async () => {
      const input = await request(); await expect(run(input, output(input, { [field]: field === 'promptSha256' || field === 'evidenceSha256' ? 'b'.repeat(64) : 'other' }))).rejects.toBeInstanceOf(DiagnosticModelError);
    });
  }
  it('rejects an unknown top-level evidence reference', async () => { const input = await request(); await expect(run(input, output(input, { evidenceRefs: ['unlisted.json'] }))).rejects.toBeInstanceOf(DiagnosticModelError); });
  it('rejects an unknown nested cause evidence reference', async () => { const input = await request(); await expect(run(input, output(input, { cause: { code: 'X', summary: 'x', evidenceRefs: ['unlisted.json'] } }))).rejects.toBeInstanceOf(DiagnosticModelError); });
  it('rejects status/action inconsistency and actions absent from the admitted catalog', async () => {
    const input = await request();
    await expect(run(input, output(input, { status: 'diagnosed' }))).rejects.toBeInstanceOf(DiagnosticModelError);
    await expect(run(input, output(input, { actionCode: 'RUN_SHELL' }))).rejects.toBeInstanceOf(DiagnosticModelError);
  });
  it('returns advisory output through transport without invoking an action executor', async () => {
    const input = await request(); const execute = vi.fn(() => { throw new Error('action execution attempted'); });
    const fake = { ...transport(output(input)), execute };
    const result = await diagnose(input, fake, profile.profileId, await registry(), options());
    expect(result.actionCode).toBe('OPERATOR_RECOVERY_REQUIRED');
    expect(fake.invoke).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
    const sent = fake.invoke.mock.calls[0][0] as any;
    expect(sent.messages).toHaveLength(2); expect(sent).not.toHaveProperty('tools'); expect(sent).not.toHaveProperty('history');
  });
  it('preflights the diagnostic packet before transport', async () => {
    const input = await request(); const fake = transport(output(input));
    await expect(diagnose(input, fake, profile.profileId, await registry(), { ...options(), tokenCounter: { ...tokenCounter, countPacket: () => ({ systemTokens: 3000, userTokens: 3000, schemaTokens: 3000, wrapperTokens: 3000, imageTokens: 0 }) }, safetyTokens: 1024 })).rejects.toThrow(/CONTEXT_BUDGET_EXCEEDED/);
    expect(fake.invoke).not.toHaveBeenCalled();
  });
});

describe('generated diagnostic response schema', () => {
  it('exposes exact nested required fields, enum actions, and closed objects', async () => {
    const { DIAGNOSTIC_RESULT_SCHEMA } = await import('@ne-psd/intelligence');
    const schema: any = DIAGNOSTIC_RESULT_SCHEMA;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(['requestId', 'sessionId', 'subjectId', 'evidenceSha256', 'status', 'cause', 'actionCode']));
    expect(schema.properties.status.enum).toEqual(['diagnosed', 'blocked']);
    expect(schema.properties.actionCode.enum).toContain('RETRY_FRESH_COPY');
    const cause = schema.properties.cause.anyOf.find((part: any) => part.type === 'object');
    expect(cause.required).toEqual(['code', 'summary', 'evidenceRefs']);
    expect(cause.additionalProperties).toBe(false);
  });
});
