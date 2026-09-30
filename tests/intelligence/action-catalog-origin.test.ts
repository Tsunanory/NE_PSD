import { describe, expect, it } from 'vitest';
import { admittedActions } from '@ne-psd/intelligence';

const actions = ['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED', 'REQUALIFY_BACKEND', 'REQUALIFY_MODEL'];
const forCode = (code: string, category: string) => admittedActions({ attempt: 1, allowedActions: actions, domainError: { code, category }, safeCleanup: false, knownCause: false, visualAttestation: false });

describe('diagnostic failure origin', () => {
  it('routes model timeout and unsupported capability to model requalification', () => {
    expect(forCode('MODEL_REQUEST_TIMEOUT', 'transient')).toEqual(['REQUALIFY_MODEL']);
    expect(forCode('MODEL_SCHEMA_UNSUPPORTED', 'capability')).toEqual(['REQUALIFY_MODEL']);
  });
  it('keeps ambiguous Photoshop mutation under operator recovery', () => {
    expect(forCode('PHOTOSHOP_MUTATION_TIMEOUT', 'ambiguousState')).toEqual(['WAIT_FOR_REQUIRED_EVIDENCE', 'OPERATOR_RECOVERY_REQUIRED']);
    expect(forCode('UNSUPPORTED_OPERATION', 'capability')).toEqual(['REQUALIFY_BACKEND']);
  });
});
