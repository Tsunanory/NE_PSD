export const setupScenarios = ['duplicate-layer-names', 'missing-target', 'unqualified-template', 'unsupported-contain', 'unsupported-stretch', 'missing-model', 'valid-text-only-model', 'invalid-artifact-digest'] as const;
export const jobStates = ['ready', 'running', 'pausing', 'paused', 'completed', 'failed', 'blocked', 'cancelled'] as const;
export const assetStatuses = ['queued', 'rendering', 'reviewing', 'readyToCommit', 'complete', 'failed', 'blocked', 'cancelled'] as const;
