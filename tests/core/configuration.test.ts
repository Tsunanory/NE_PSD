import { describe, expect, it } from 'vitest';
import { validateConfiguration } from '@ne-psd/core';

const hash = 'a'.repeat(64);
const selector = { documentRoute: [], layerPath: [{ name: 'target', kind: 'smartObject' as const, fingerprint: 'f' }] };
const spec = { schemaVersion: 1 as const, jobId: 'scheduled', outputRootId: 'out', modelProfileId: 'brain', reviewerModelProfileId: 'reviewer', reviewPolicySha256: hash, trigger: 'scheduled' as const, maxAttempts: 2 as const, profile: { schemaVersion: 1 as const, profileId: 'profile', template: { rootId: 'templates', relativePath: 'template.psd', sha256: hash }, profileSha256: hash, qualificationId: 'qualification', backendId: 'alisaitteke' as const, toolSchemaSha256: hash, targets: [{ target: selector, reference: selector, input: null }], fitMode: 'cover' as const, output: { format: 'png' as const, quality: 90, colorSpace: 'sRGB' as const, width: 10, height: 10 }, variants: [{ id: '1' as const, group: selector }, { id: '2' as const, group: selector }, { id: '3' as const, group: selector }] }, assets: [] };
const localQwen = { profileId: 'brain', provider: 'local-qwen' as const, modelId: 'qwen', provenance: { kind: 'local' as const, artifactSha256: hash, runtimeVersion: '1', chatTemplateSha256: hash }, endpoint: 'http://localhost', quantization: null, contextTokens: 1, maxOutputTokens: 1, capabilities: { jsonSchema: true, vision: false, tools: false } };

describe('configuration gates', () => {
  it('fails scheduled jobs closed unless both profiles are explicit Luna profiles with vision reviewer', () => {
    const result = validateConfiguration(spec, { modelProfile: localQwen });
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['SCHEDULED_PROFILE_REQUIRED', 'SCHEDULED_QWEN_FORBIDDEN']));
  });
});
