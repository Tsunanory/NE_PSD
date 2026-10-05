import { describe, expect, it } from 'vitest';
import { sha256Json } from '@ne-psd/contracts';
import {
  ModelProfileRegistry,
  ModelQualificationSchema,
  createModelProfileRestorationSeal,
  type ModelQualificationRestorationVerification,
} from '@ne-psd/intelligence';
import { createCandidateTrialFixture } from './helpers/candidate-trial-fixture.js';

const digest = (value: string) => sha256Json({ value });

async function setup() {
  const fixture = await createCandidateTrialFixture('reviewer');
  const qualification = ModelQualificationSchema.parse({
    ...JSON.parse(await (await import('node:fs/promises')).readFile(fixture.manifestPath, 'utf8')),
    stage: 'runtimeQualified',
    runtimeQualified: true,
  });
  const verification: ModelQualificationRestorationVerification = {
    reportSha256: digest('current-report'),
    v2ReleaseGateSha256: digest('current-v2-release'),
    runtimeProbe: fixture.probe,
    tokenCounter: fixture.counter,
    evidencePaths: ['probe.json'],
  };
  return { fixture, qualification, verification };
}

describe('restart model-profile restoration', () => {
  it('restores only through an independently verified sealed admission', async () => {
    const { fixture, qualification, verification } = await setup();
    try {
      const registry = new ModelProfileRegistry();
      const record = await registry.restore(fixture.profile, qualification, async (candidate) => {
        expect(candidate.qualificationSha256).toBe(sha256Json(qualification));
        return verification;
      });
      expect(record.selectable).toBe(true);
      expect(record.qualification?.profile.profileId).toBe(fixture.profile.profileId);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ['forged report digest', (v: ModelQualificationRestorationVerification) => ({ ...v, reportSha256: 'not-a-digest' })],
    ['mismatched runtime probe', (v: ModelQualificationRestorationVerification) => ({ ...v, runtimeProbe: { ...v.runtimeProbe, profileId: 'other-profile' } })],
    ['mismatched token counter', (v: ModelQualificationRestorationVerification) => ({ ...v, tokenCounter: { ...v.tokenCounter, runtimeBuild: 'other-runtime' } })],
    ['mismatched vision binding', (v: ModelQualificationRestorationVerification) => ({ ...v, runtimeProbe: { ...v.runtimeProbe, vision: false, imageInput: false, visionLimits: null } })],
    ['mismatched evidence', (v: ModelQualificationRestorationVerification) => ({ ...v, evidencePaths: ['stale.json'] })],
  ])('rejects %s', async (_name, mutate) => {
    const { fixture, qualification, verification } = await setup();
    try {
      await expect(createModelProfileRestorationSeal(fixture.profile, qualification, async () => mutate(verification))).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });

  it('rejects profile mismatch, fixture records, plain forged seals, and replay', async () => {
    const { fixture, qualification, verification } = await setup();
    try {
      await expect(createModelProfileRestorationSeal({ ...fixture.profile, profileId: 'other' }, qualification, async () => verification)).rejects.toThrow(/profile/i);
      const fixtureQualification = ModelQualificationSchema.parse({ ...qualification, fixture: true });
      await expect(createModelProfileRestorationSeal(fixture.profile, fixtureQualification, async () => verification)).rejects.toThrow(/fixture/i);
      const seal = await createModelProfileRestorationSeal(fixture.profile, qualification, async () => verification);
      const registry = new ModelProfileRegistry();
      await expect(registry.restore(fixture.profile, qualification, { ...seal })).rejects.toThrow(/seal|admission/i);
      await registry.restore(fixture.profile, qualification, seal);
      await expect(registry.restore(fixture.profile, qualification, seal)).rejects.toThrow(/replay|consumed/i);
    } finally {
      await fixture.close();
    }
  });

  it('does not let a verifier rewrite the candidate digest binding', async () => {
    const { fixture, qualification, verification } = await setup();
    try {
      await expect(createModelProfileRestorationSeal(fixture.profile, qualification, async (candidate) => {
        expect(() => (candidate as { qualificationSha256: string }).qualificationSha256 = 'f'.repeat(64)).toThrow();
        expect(candidate.qualificationSha256).toBe(sha256Json(qualification));
        return verification;
      })).resolves.toBeDefined();
    } finally {
      await fixture.close();
    }
  });
});
