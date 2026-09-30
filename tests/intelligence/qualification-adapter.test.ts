import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQualificationAdapter, ModelProfileRegistry, RuntimeIntelligenceService } from '@ne-psd/intelligence';
import { sha256Json } from '@ne-psd/contracts';
import { createCandidateTrialFixture } from './helpers/candidate-trial-fixture.js';
import type { QualificationRuntime } from '../../packages/intelligence/src/cli/qualify-model.js';

describe('public model qualification composition', () => {
  it('stops a hanging corpus invocation when the caller cancels and writes no success report', async () => {
    const fixture = await createCandidateTrialFixture('reviewer');
    const planner = await createCandidateTrialFixture('planner');
    try {
      const report = join(fixture.root, 'canceled-report.json');
      const controller = new AbortController();
      let started!: () => void;
      const invoked = new Promise<void>((resolve) => { started = resolve; });
      let invocationSignal: AbortSignal | undefined;
      let measured = false;
      const runtime: QualificationRuntime = {
        provenance: 'live', deadlineMs: 10_000, locks: {
          plannerProfileId: planner.profile.profileId, reviewerProfileId: fixture.profile.profileId,
          plannerQualificationSha256: sha256Json(JSON.parse(readFileSync(planner.manifestPath, 'utf8'))),
          reviewerQualificationSha256: sha256Json(JSON.parse(readFileSync(fixture.manifestPath, 'utf8'))),
          artifactSha256: planner.profile.provenance.kind === 'local' ? planner.profile.provenance.artifactSha256 : '',
          runtimeBuild: 'test-runtime', chatTemplateSha256: planner.probe.chatTemplateSha256,
          promptSha256: 'c'.repeat(64), policySha256: 'd'.repeat(64), contextTokens: 8192,
          cacheSettings: 'test', maxOutputTokens: 512,
        },
        probe: async (_profileId, role) => role === 'planner' ? planner.probe : fixture.probe,
        transport: { invoke: async (request) => { invocationSignal = request.signal; started(); return new Promise(() => {}); } },
        counterFor: (_profileId, role) => role === 'planner' ? planner.counter : fixture.counter,
        beginMeasurement: async () => {},
        measure: async () => { measured = true; return []; },
      };
      const adapter = createQualificationAdapter({ profile: planner.manifestPath, reviewerProfile: fixture.manifestPath, expectedPlatform: process.platform, corpus: fileURLToPath(new URL('./fixtures/acceptance-corpus.json', import.meta.url)), repetitions: 3, withPhotoshop: true, report }, runtime);
      const qualifying = adapter.qualify(fixture.profile, controller.signal);
      await Promise.race([invoked, qualifying.then((result) => { throw new Error(JSON.stringify({ errors: result.errors, report: JSON.parse(readFileSync(report, 'utf8')) })); })]);
      controller.abort();
      await expect(qualifying).rejects.toMatchObject({ name: 'AbortError' });
      expect(invocationSignal?.aborted).toBe(true);
      expect(measured).toBe(false);
      expect(existsSync(report)).toBe(false);
    } finally { await fixture.close(); await planner.close(); }
  }, 15_000);
  it('uses the CLI artifact/corpus workflow and keeps unavailable live runtime blocked', async () => {
    const fixture = await createCandidateTrialFixture('reviewer');
    try {
      const report = join(fixture.root, 'qualification-report.json');
      const options = { profile: fixture.manifestPath, expectedPlatform: process.platform, corpus: fileURLToPath(new URL('./fixtures/acceptance-corpus.json', import.meta.url)), repetitions: 3 as const, withPhotoshop: true, report };
      const registry = new ModelProfileRegistry();
      const service = new RuntimeIntelligenceService({ registry, qualificationAdapter: createQualificationAdapter(options), transport: { invoke: async () => { throw new Error('unexpected inference'); } }, counterFor: () => null, readAttempt: async () => null, readLimits: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 }, resolveAttemptRoot: async () => fixture.root, imageQualityPolicy: async () => null, colorTrace: async () => null, safeCleanup: async () => false, admissibleCorrections: async () => [] });
      const signal = new AbortController().signal;
      expect((await service.inspectModelProfile(fixture.profile, signal)).available).toBe(true);
      const result = await service.qualifyModelProfile(fixture.profile, signal);
      expect(result.qualified).toBe(false);
      expect(result.errors.some((error) => error.code === 'MODEL_RUNTIME_UNQUALIFIED')).toBe(true);
      expect(registry.get(fixture.profile.profileId)).toBeUndefined();
    } finally { await fixture.close(); }
  });
});
