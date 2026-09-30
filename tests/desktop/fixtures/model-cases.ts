import type { ModelProfile } from '@ne-psd/contracts';
import type { ModelEvidence } from '../../../apps/desktop/src/renderer/setup/model-state.js';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
export function modelCase(quantization: 'Q4' | 'Q6' | 'Q8'): ModelEvidence {
  const profile: ModelProfile = {
    profileId: `testOnly-${quantization}`, provider: 'local-qwen', modelId: 'Qwen3.8-27B',
    provenance: { kind: 'local', artifactSha256: a, runtimeVersion: 'test-runtime-1', chatTemplateSha256: b },
    endpoint: 'http://127.0.0.1:8080', quantization, contextTokens: 32768, maxOutputTokens: 4096,
    capabilities: { jsonSchema: true, tools: true, vision: true },
  };
  return { label: 'Qwen3.8-27B', modelId: profile.modelId, artifactSha256: a, runtimeVersion: 'test-runtime-1', chatTemplateSha256: b,
    quantization, contextTokens: 32768, maxOutputTokens: 4096, capabilities: { ...profile.capabilities },
    benchmark: { passed: true, latencyMs: 100 }, resources: { peakRamGb: 24, peakVramGb: 20, requiredHeadroomGb: 4 },
    artifactVerified: true, endpointReachable: true, reviewGateAvailable: true, synthetic: false,
    selectedProfile: profile, qualification: { qualified: true, evidencePaths: ['testOnly/model/qualification.json'], errors: [] },
  };
}
const valid = modelCase('Q4');
export const modelCases = {
  offline: { ...valid, endpointReachable: false },
  wrongModel: { ...valid, modelId: 'Other-27B' },
  wrongArtifact: { ...valid, artifactSha256: 'c'.repeat(64) },
  badDigest: { ...valid, artifactSha256: 'not-a-digest' },
  wrongRuntime: { ...valid, runtimeVersion: 'other-runtime' },
  wrongChatTemplate: { ...valid, chatTemplateSha256: 'c'.repeat(64) },
  schemaFailed: { ...valid, capabilities: { ...valid.capabilities, jsonSchema: false } },
  toolsFailed: { ...valid, capabilities: { ...valid.capabilities, tools: false } },
  visionFailed: { ...valid, capabilities: { ...valid.capabilities, vision: false } },
  capacityFailed: { ...valid, benchmark: { passed: false, latencyMs: 10000 } },
  reviewUnavailable: { ...valid, reviewGateAvailable: false },
  unqualified: { ...valid, qualification: { qualified: false, evidencePaths: [], errors: [] } },
  synthetic: { ...valid, synthetic: true },
} satisfies Record<string, ModelEvidence>;
