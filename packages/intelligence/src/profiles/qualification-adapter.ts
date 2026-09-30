import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { canonicalize, type ModelProfile } from '@ne-psd/contracts';
import { qualifyModel, type QualificationOptions, type QualificationReport, type QualificationRuntime } from '../cli/qualify-model.js';
import { verifyModel, validateRelativePath } from '../cli/verify-model.js';
import { ModelQualificationSchema, type ModelQualification } from './qualification-schema.js';
import type { QualificationAdapter } from './profile-registry.js';

const capabilityError = (code: string, message: string) => ({ code, category: 'capability' as const, message, retryable: false, evidencePaths: [] });
const matching = (a: ModelProfile, b: ModelProfile) => canonicalize(a) === canonicalize(b);

/** Connects the public model-profile API to the same measured CLI workflow. */
export type TrustedV2ReleaseGate = (profile: ModelProfile, report: QualificationReport) => Promise<{ v2ProofsValidated: true; evidenceSha256: string } | null>;
export function createQualificationAdapter(options: QualificationOptions, runtime?: QualificationRuntime, releaseGate?: TrustedV2ReleaseGate): QualificationAdapter {
  const manifestFor = async (profile: ModelProfile) => {
    for (const path of [options.profile, options.reviewerProfile].filter((value): value is string => !!value)) {
      const candidate = ModelQualificationSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')));
      if (matching(candidate.profile, profile)) return { path, candidate };
    }
    return null;
  };
  return {
    async inspect(profile, signal) {
      if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const found = await manifestFor(profile);
      if (!found) return { available: false, errors: [capabilityError('QUALIFICATION_PROFILE_MISMATCH', 'selected profile has no matching artifact manifest')] };
      const verified = await verifyModel({ manifest: found.path, expectedPlatform: options.expectedPlatform, artifactOnly: true });
      return verified.ok && 'artifactVerified' in verified && verified.artifactVerified
        ? { available: true, errors: [] }
        : { available: false, errors: [capabilityError('MODEL_ARTIFACT_UNVERIFIED', 'exact artifact verification failed')] };
    },
    async qualify(profile, signal) {
      if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const found = await manifestFor(profile);
      if (!found) return { qualified: false, evidencePaths: [], errors: [capabilityError('QUALIFICATION_PROFILE_MISMATCH', 'selected profile has no matching artifact manifest')] };
      const report = await qualifyModel(options, runtime, signal);
      if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const reportPath = relative(dirname(resolve(found.path)), resolve(options.report));
      const probe = report.probes.find((item) => item.profileId === profile.profileId);
      if (report.status !== 'trial-passed' || report.corpus?.status !== 'passed' || !report.corpusSha256 || !report.fixtureManifestSha256 ||
          report.corpusSha256 !== report.corpus.corpusSha256 || report.fixtureManifestSha256 !== report.corpus.fixtureManifestSha256 ||
          report.resources?.releaseQualified !== true || report.platform !== 'win32' || !probe || !validateRelativePath(reportPath))
        return { qualified: false, evidencePaths: [], errors: [capabilityError('MODEL_RUNTIME_UNQUALIFIED', `measured qualification blocked: ${report.reasons.join(',') || 'report/evidence incomplete'}`)] };
      const release = await releaseGate?.(profile, report);
      if (!release?.v2ProofsValidated || !/^[a-f0-9]{64}$/.test(release.evidenceSha256))
        return { qualified: false, evidencePaths: [], errors: [capabilityError('V2_RELEASE_GATE_UNAVAILABLE', 'trusted V2 proof closure is required before production profile admission')] };
      const diskReport = JSON.parse(await readFile(resolve(options.report), 'utf8')) as unknown;
      if (canonicalize(diskReport) !== canonicalize(report) || !found.candidate.artifact) return { qualified: false, evidencePaths: [], errors: [capabilityError('QUALIFICATION_REPORT_MISMATCH', 'persisted qualification report does not match measured result')] };
      const limits = probe.visionLimits;
      const runtimeSettings = { ...found.candidate.artifact.runtimeSettings, contextTokens: String(probe.contextTokens),
        ...(limits ? { visionInputQualified: 'true', visionMaxImages: String(limits.maxImages), visionMaxWidth: String(limits.maxWidth), visionMaxHeight: String(limits.maxHeight), visionMaxPixels: String(limits.maxPixels), visionMaxTotalBytes: String(limits.maxBytes), visionMaxDecodedBytes: String(limits.maxDecodedBytes), visionMaxTotalDecodedBytes: String(limits.maxDecodedBytes * limits.maxImages) } : {}) };
      const qualification: ModelQualification = ModelQualificationSchema.parse({ ...found.candidate, stage: 'runtimeQualified', runtimeQualified: true, evidencePaths: [...new Set([...found.candidate.evidencePaths, ...probe.evidenceRefs, reportPath])], errors: [], artifact: { ...found.candidate.artifact, runtimeSettings } });
      return { qualified: true, evidencePaths: qualification.evidencePaths, errors: [], qualification };
    },
  };
}
