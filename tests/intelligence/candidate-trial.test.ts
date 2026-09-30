import { afterEach, describe, expect, it } from 'vitest';
import { admitCandidateTrial, assertInvocationAllowed, preflightQualifiedPacket, prepareVisionPayload } from '@ne-psd/intelligence';
import { createCandidateTrialFixture } from './helpers/candidate-trial-fixture.js';

const active: { close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map((fixture) => fixture.close())); });
const fixture = async (role: 'planner' | 'reviewer' = 'reviewer') => { const value = await createCandidateTrialFixture(role); active.push(value); return value; };

describe('qualification-only candidate admission', () => {
  it('verifies exact artifact and probe while keeping production registry closed', async () => {
    const f = await fixture();
    const trial = await admitCandidateTrial({ manifestPath: f.manifestPath, expectedPlatform: process.platform, probe: f.probe, counter: f.counter, role: 'reviewer' });
    const record = trial.registry.get(f.profile.profileId)!;
    expect(record.selectable).toBe(false);
    expect(record.qualification).toBeNull();
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: f.profile, explicitSelection: true, registry: trial.registry })).toThrow(/unqualified/i);
    expect(assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: f.profile, explicitSelection: true, registry: trial.registry, trialAdmission: trial.admission })).toBe(true);
    expect(() => assertInvocationAllowed({ trigger: 'scheduled', jobKind: 'review', profile: f.profile, explicitSelection: true, registry: trial.registry, trialAdmission: trial.admission })).toThrow();
  });
  it('cannot copy the private trial token or use it for the wrong role', async () => {
    const f = await fixture();
    const trial = await admitCandidateTrial({ manifestPath: f.manifestPath, expectedPlatform: process.platform, probe: f.probe, counter: f.counter, role: 'reviewer' });
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'review', profile: f.profile, explicitSelection: true, registry: trial.registry, trialAdmission: { ...trial.admission } })).toThrow(/unqualified/i);
    expect(() => assertInvocationAllowed({ trigger: 'foreground', jobKind: 'planning', profile: f.profile, explicitSelection: true, registry: trial.registry, trialAdmission: trial.admission })).toThrow(/unqualified/i);
  });
  it('preflights only the bound probe and tokenizer counter', async () => {
    const f = await fixture('planner');
    const trial = await admitCandidateTrial({ manifestPath: f.manifestPath, expectedPlatform: process.platform, probe: f.probe, counter: f.counter, role: 'planner' });
    const request: any = { profile: f.profile, sessionId: 'new-session', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }], responseSchema: {}, sampling: { temperature: 0, stream: false }, maxOutputBytes: 1000, maxOutputTokens: 512, deadlineMs: 1000, signal: new AbortController().signal };
    const record = trial.registry.get(f.profile.profileId)!;
    expect(preflightQualifiedPacket(record, f.counter, request, 1024, trial.admission).totalTokens).toBeGreaterThan(0);
    expect(() => preflightQualifiedPacket(record, f.counter, request, 1024)).toThrow(/UNQUALIFIED/);
    expect(() => preflightQualifiedPacket(record, { ...f.counter }, request, 1024, trial.admission)).toThrow(/UNQUALIFIED/);
  });
  it('rejects mismatched runtime probe without issuing admission', async () => {
    const f = await fixture();
    await expect(admitCandidateTrial({ manifestPath: f.manifestPath, expectedPlatform: process.platform, probe: { ...f.probe, imageInput: false }, counter: f.counter, role: 'reviewer' })).rejects.toThrow(/PROBE_MISMATCH/);
    await expect(admitCandidateTrial({ manifestPath: f.manifestPath, expectedPlatform: process.platform, probe: f.probe, counter: { ...f.counter, tokenizerId: 'wrong' }, role: 'reviewer' })).rejects.toThrow(/PROBE_MISMATCH/);
  });
});
