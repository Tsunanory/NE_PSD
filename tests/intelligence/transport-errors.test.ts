import { describe, expect, it } from 'vitest';
import { CodexTransport, isLoopbackEndpoint, LocalRuntimeTransport, validateTransportResponse, validateTransportRequest, invokeBounded } from '@ne-psd/intelligence';
import { ModelProfileSchema } from '@ne-psd/contracts';
const localProfile = () => ModelProfileSchema.parse({ profileId: 'local', provider: 'local-qwen', modelId: 'Qwen3.8-27B', provenance: { kind: 'local', artifactSha256: 'a'.repeat(64), runtimeVersion: 'runtime', chatTemplateSha256: 'b'.repeat(64) }, endpoint: 'http://127.0.0.1:1', quantization: 'Q4_K_M', contextTokens: 4096, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: true, tools: true } });
const requestFor = (profile = localProfile()) => ({ profile, sessionId: 's', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], responseSchema: {}, sampling: { temperature: 0, stream: false }, maxOutputBytes: 100, maxOutputTokens: 10, deadlineMs: 20, signal: new AbortController().signal });
describe('transport capability boundaries', () => {
  it('accepts only loopback local endpoints', () => { expect(isLoopbackEndpoint('http://127.0.0.1:8080')).toBe(true); expect(isLoopbackEndpoint('https://example.com')).toBe(false); });
  it('keeps Codex explicitly blocked without a documented bridge', async () => { await expect(new CodexTransport().invoke({} as never)).rejects.toThrow(/missing request|invalid/i); });
  it('does not invoke an unqualified local runtime', async () => { await expect(new LocalRuntimeTransport().invoke({ profile: { endpoint: 'http://127.0.0.1:1', modelId: 'x' }, sessionId: 's', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], responseSchema: {}, sampling: { temperature: 0, stream: false }, maxOutputBytes: 2, maxOutputTokens: 1, deadlineMs: 10, signal: new AbortController().signal } as never)).rejects.toThrow(/unverified/i); });
  it('rejects truncated, mismatched, oversized and cancelled responses', () => {
    const request = { profile: { modelId: 'x' }, sessionId: 's', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], responseSchema: {}, sampling: { temperature: 0, stream: false }, maxOutputBytes: 2, maxOutputTokens: 10, deadlineMs: 100, signal: new AbortController().signal } as never;
    expect(() => validateTransportResponse(request, { raw: new Uint8Array([1]), modelId: 'x', finishReason: 'length', sessionId: 's' } as never)).toThrow(/completed/i);
    expect(() => validateTransportResponse(request, { raw: new Uint8Array([1]), modelId: 'y', finishReason: 'stop', sessionId: 's' } as never)).toThrow(/identity/i);
  });
  it('requires trusted session and transport settings and discards late replies', async () => {
    const request = { profile: { modelId: 'x' }, sessionId: 's', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], responseSchema: {}, sampling: { temperature: 1, stream: true }, maxOutputBytes: 2, maxOutputTokens: 1, deadlineMs: 10, signal: new AbortController().signal } as never;
    expect(() => validateTransportRequest(request)).toThrow();
    const calls = { count: 0 }; const fake = { invoke: async () => { calls.count++; await new Promise((resolve) => setTimeout(resolve, 30)); return { raw: new Uint8Array([1]), modelId: 'x', finishReason: 'stop', sessionId: 's' }; } } as never;
    await expect(invokeBounded(fake, { ...request, sampling: { temperature: 0, stream: false }, deadlineMs: 5 })).rejects.toThrow(/deadline|timeout/i); expect(calls.count).toBe(1);
  });
  it('rejects output and revision mismatches before the fake transport is called', async () => {
    let calls = 0; const fake = { invoke: async () => { calls++; return undefined as never; } } as never;
    const base = { profile: { modelId: 'x', maxOutputTokens: 2, provenance: { kind: 'remote', revision: 'r1' } }, sessionId: 's', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], responseSchema: {}, sampling: { temperature: 0, stream: false }, maxOutputBytes: 10, maxOutputTokens: 3, deadlineMs: 20, signal: new AbortController().signal } as never;
    await expect(invokeBounded(fake, base)).rejects.toThrow(/output/i); await expect(invokeBounded(fake, { ...base, maxOutputTokens: 1, expectedProviderRevision: 'r2' })).rejects.toThrow(/revision/i); expect(calls).toBe(0);
  });
  it('rejects parent cancellation promptly and aborts the child signal', async () => {
    const parent = new AbortController(); let childAborted = false; const fake = { invoke: async (request: { signal: AbortSignal }) => { request.signal.addEventListener('abort', () => { childAborted = true; }); await new Promise((resolve) => setTimeout(resolve, 100)); return undefined as never; } } as never;
    const request = { profile: { modelId: 'x', maxOutputTokens: 2, provenance: { kind: 'local' } }, sessionId: 's', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], responseSchema: {}, sampling: { temperature: 0, stream: false }, maxOutputBytes: 10, maxOutputTokens: 1, deadlineMs: 500, signal: parent.signal } as never;
    const started = Date.now(); const pending = invokeBounded(fake, request); setTimeout(() => parent.abort(), 5); await expect(pending).rejects.toThrow(/abort/i); expect(Date.now() - started).toBeLessThan(80); expect(childAborted).toBe(true);
  });
  it('normalizes malformed responses to TransportError', () => {
    const request = requestFor();
    for (const response of [undefined, {}, { raw: 'text', modelId: 'x', finishReason: 'stop', sessionId: 's' }, { raw: new Uint8Array(), modelId: '', finishReason: 'stop', sessionId: 's' }, { raw: new Uint8Array(), modelId: 'x', finishReason: 'unknown', sessionId: 's' }, { raw: new Uint8Array(), modelId: 'x', finishReason: 'stop', sessionId: '' }, { raw: new Uint8Array(), modelId: 'x', finishReason: 'stop', sessionId: 's', usage: { inputTokens: -1, outputTokens: 1 } }]) expect(() => validateTransportResponse(request as never, response as never)).toThrow();
  });
  it('requires every qualified local handshake field and blocks only after a complete match', async () => {
    const profile = localProfile(); const request = requestFor(profile);
    const matching = { modelId: profile.modelId, artifactSha256: profile.provenance.artifactSha256, chatTemplateSha256: profile.provenance.chatTemplateSha256, revision: null, runtimeVersion: profile.provenance.runtimeVersion, jsonSchema: true, contextTokens: profile.contextTokens, maxOutputTokens: profile.maxOutputTokens, capabilities: { vision: true, tools: true, imageInput: true }, supportsNonStreaming: true };
    await expect(new LocalRuntimeTransport(matching).invoke(request as never)).rejects.toThrow(/LOCAL_RUNTIME_UNAVAILABLE|not configured/i);
    for (const key of ['artifactSha256', 'chatTemplateSha256', 'runtimeVersion', 'contextTokens', 'maxOutputTokens', 'supportsNonStreaming'] as const) { const mismatch = { ...matching, [key]: typeof matching[key] === 'string' ? 'mismatch' : typeof matching[key] === 'number' ? 1 : false }; await expect(new LocalRuntimeTransport(mismatch).invoke(request as never)).rejects.toThrow(/identity|provenance|limits|capabilities|unverified/i); }
    for (const capability of ['vision', 'tools', 'imageInput'] as const) { const mismatch = { ...matching, capabilities: { ...matching.capabilities, [capability]: false } }; await expect(new LocalRuntimeTransport(mismatch).invoke(request as never)).rejects.toThrow(/identity|provenance|limits|capabilities|unverified/i); }
  });
  it('uses an explicitly injected local runtime bridge after exact handshake and validates its reply', async () => {
    const profile = localProfile(); const request = requestFor(profile);
    const handshake = { modelId: profile.modelId, artifactSha256: profile.provenance.artifactSha256, chatTemplateSha256: profile.provenance.chatTemplateSha256, revision: null, runtimeVersion: profile.provenance.runtimeVersion, jsonSchema: true, contextTokens: profile.contextTokens, maxOutputTokens: profile.maxOutputTokens, capabilities: { vision: true, tools: true, imageInput: true }, supportsNonStreaming: true };
    let calls = 0;
    const bridge = async (sent: any) => { calls++; return { raw: new Uint8Array([123, 125]), modelId: sent.profile.modelId, finishReason: 'stop' as const, usage: null, providerRevision: null, sessionId: sent.sessionId }; };
    expect((await new LocalRuntimeTransport(handshake, bridge).invoke(request as never)).sessionId).toBe(request.sessionId);
    expect(calls).toBe(1);
    await expect(new LocalRuntimeTransport(handshake, async (sent: any) => ({ ...await bridge(sent), modelId: 'wrong' })).invoke(request as never)).rejects.toThrow(/identity/i);
  });
  it('uses only an explicitly injected Codex bridge with profile and revision binding', async () => {
    const profile = ModelProfileSchema.parse({ profileId: 'codex-selected', provider: 'codex', modelId: 'codex-model', provenance: { kind: 'remote', provider: 'codex', modelId: 'codex-model', revision: 'r1', qualificationEvidencePath: 'evidence/codex.json' }, endpoint: 'codex-installed', quantization: null, contextTokens: 4096, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: true, tools: false } });
    const request = requestFor(profile as never);
    await expect(new CodexTransport().invoke(request as never)).rejects.toThrow(/unavailable/i);
    const response = async (sent: any) => ({ raw: new Uint8Array([123, 125]), modelId: sent.profile.modelId, finishReason: 'stop' as const, usage: null, providerRevision: 'r1', sessionId: sent.sessionId });
    expect((await new CodexTransport(response).invoke(request as never)).providerRevision).toBe('r1');
    await expect(new CodexTransport(async (sent: any) => ({ ...await response(sent), providerRevision: 'r2' })).invoke(request as never)).rejects.toThrow(/revision/i);
  });
  it('aborts the child signal when the deadline fires', async () => {
    let aborted = false; const fake = { invoke: async (request: { signal: AbortSignal }) => { request.signal.addEventListener('abort', () => { aborted = true; }); await new Promise((resolve) => setTimeout(resolve, 100)); return undefined as never; } } as never; await expect(invokeBounded(fake, requestFor())).rejects.toThrow(/deadline|timeout/i); expect(aborted).toBe(true);
  });
});
