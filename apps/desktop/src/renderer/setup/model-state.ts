import type { ModelProfile, SetupService } from '@ne-psd/contracts';

export type ModelCapabilities = { jsonSchema: boolean; tools: boolean; vision: boolean };
export type ModelEvidence = {
  label: 'Qwen3.8-27B'; modelId: string; artifactSha256: string; runtimeVersion: string; chatTemplateSha256: string;
  quantization: 'Q4' | 'Q5' | 'Q6' | 'Q8'; contextTokens: number; maxOutputTokens: number;
  capabilities: ModelCapabilities; benchmark: { passed: boolean; latencyMs: number };
  resources: { peakRamGb: number; peakVramGb: number; requiredHeadroomGb: number };
  artifactVerified: boolean; endpointReachable: boolean; reviewGateAvailable: boolean; synthetic: boolean;
  selectedProfile?: ModelProfile;
  qualification?: Awaited<ReturnType<SetupService['qualifyModelProfile']>>;
};
export const WEIGHTS_ONLY_LOWER_BOUNDS_GB = { Q4: 13.5, Q5: 16.9, Q6: 20.3, Q8: 27.0 } as const;
export const weightsOnlyLowerBoundGb = (quantization: keyof typeof WEIGHTS_ONLY_LOWER_BOUNDS_GB): number => WEIGHTS_ONLY_LOWER_BOUNDS_GB[quantization];
const sha256 = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);
const localEndpoint = (value: string): boolean => /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/.test(value);

export function validateModelTrigger(provider: ModelProfile['provider'], trigger: 'interactive' | 'scheduled'): { allowed: boolean; reason: string } {
  if (trigger === 'scheduled') return { allowed: false, reason: provider === 'luna' ? 'scheduled Luna qualification is deferred' : 'scheduled model jobs are outside this release' };
  return { allowed: true, reason: 'interactive model use only' };
}

export function evaluateModelSetup(evidence: ModelEvidence, role: 'planner' | 'reviewer' = 'reviewer') {
  const profile = evidence.selectedProfile;
  const provenance = profile?.provenance;
  const identity = evidence.label === 'Qwen3.8-27B' && evidence.modelId === 'Qwen3.8-27B' &&
    profile?.provider === 'local-qwen' && profile.modelId === evidence.modelId && provenance?.kind === 'local' &&
    sha256(evidence.artifactSha256) && sha256(evidence.chatTemplateSha256) && evidence.artifactVerified &&
    provenance.artifactSha256 === evidence.artifactSha256 && provenance.chatTemplateSha256 === evidence.chatTemplateSha256 &&
    provenance.runtimeVersion === evidence.runtimeVersion && evidence.runtimeVersion.length > 0 &&
    localEndpoint(profile.endpoint) && profile.quantization === evidence.quantization && profile.contextTokens === evidence.contextTokens &&
    profile.maxOutputTokens === evidence.maxOutputTokens && Number.isSafeInteger(evidence.contextTokens) && evidence.contextTokens > 0 &&
    Number.isSafeInteger(evidence.maxOutputTokens) && evidence.maxOutputTokens > 0 &&
    profile.capabilities.jsonSchema === evidence.capabilities.jsonSchema && profile.capabilities.tools === evidence.capabilities.tools &&
    profile.capabilities.vision === evidence.capabilities.vision;
  const capabilities = { ...evidence.capabilities };
  const benchmark = evidence.benchmark.passed && Number.isFinite(evidence.benchmark.latencyMs) && evidence.benchmark.latencyMs > 0 &&
    Number.isFinite(evidence.resources.peakRamGb) && evidence.resources.peakRamGb > 0 &&
    Number.isFinite(evidence.resources.peakVramGb) && evidence.resources.peakVramGb >= 0 &&
    Number.isFinite(evidence.resources.requiredHeadroomGb) && evidence.resources.requiredHeadroomGb > 0;
  const qualified = evidence.qualification?.qualified === true && evidence.qualification.errors.length === 0 &&
    evidence.qualification.evidencePaths.length > 0 && !evidence.synthetic;
  const ready = evidence.endpointReachable && identity && capabilities.jsonSchema && capabilities.tools &&
    (role === 'planner' || capabilities.vision) && benchmark &&
    (role === 'planner' || evidence.reviewGateAvailable) && qualified;
  const automatedVisual = ready && capabilities.vision;
  const message = role === 'reviewer' && !capabilities.vision ? 'Модель не проверяет изображение визуально' :
    !ready ? 'Указанная модель не подтверждена. Обработка недоступна' : `${evidence.label} квалифицирована для настроенного режима`;
  return { ready, automatedVisual, evidence, message, checks: { endpoint: evidence.endpointReachable, identity, capabilities, benchmark, reviewGate: evidence.reviewGateAvailable, qualified } };
}

export function evaluateModelSelection(planner: ModelEvidence, reviewer: ModelEvidence) {
  const plannerResult = evaluateModelSetup(planner, 'planner');
  const reviewerResult = evaluateModelSetup(reviewer, 'reviewer');
  return { ready: plannerResult.ready && reviewerResult.ready, automatedVisual: plannerResult.ready && reviewerResult.automatedVisual, planner: plannerResult, reviewer: reviewerResult };
}
