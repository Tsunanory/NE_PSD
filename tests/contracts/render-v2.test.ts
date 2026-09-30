import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatedV2Schema, V2_SCHEMAS } from '../../scripts/generate-contract-schemas.mjs';
import {
  RenderRequestSchema,
  RenderRequestV2Schema,
  RenderEvidenceSchema,
  RenderEvidenceV2Schema,
  RecoveryRequestV2Schema,
  RecoveryResultV2Schema,
  PrepareRequestV2Schema,
  PreparedInputManifestV2Schema,
  validatePreparedInputManifestV2,
  validateRenderRequestV2,
  validateRecoveryResultV2,
  validateRenderEvidenceV2,
} from '@ne-psd/contracts';
import { readFixture } from '../fixtures/read-fixture.js';

const request = () => readFixture<Record<string, unknown>>('render-request.v2.valid.json');
const evidence = () => readFixture<Record<string, unknown>>('render-evidence.v2.valid.json');
const recoveryRequest = () => ({ schemaVersion: 2, jobId: 'job-1', assetId: 'asset-1', attempt: 1, operationId: 'job-1:asset-1:1' });
const recoveryResult = () => ({ ...recoveryRequest(), safe: true, released: true, evidencePaths: ['recovery/owner.json', 'recovery/release.json'], releaseProof: { relativePath: 'recovery/release.json', sha256: 'a'.repeat(64) } });

describe('render v2 boundary', () => {
  it('keeps v1 and v2 separate while binding the owned source to the asset', () => {
    const v2 = request();
    expect(RenderRequestV2Schema.safeParse(v2).success).toBe(true);
    expect(RenderRequestSchema.safeParse(v2).success).toBe(false);
    const v1 = readFixture('render-request.valid.json');
    expect(RenderRequestSchema.safeParse(v1).success).toBe(true);
    expect(RenderRequestV2Schema.safeParse(v1).success).toBe(false);

    const ownedInput = v2.ownedInput as Record<string, unknown>;
    const source = ownedInput.source as Record<string, unknown>;
    expect(RenderRequestV2Schema.safeParse({ ...v2, ownedInput: { ...ownedInput, source: { ...source, sha256: 'f'.repeat(64) } } }).success).toBe(false);
    expect(RenderRequestV2Schema.safeParse({ ...v2, ownedInput: { ...ownedInput, source: { ...source, bytes: 19 } } }).success).toBe(false);
    expect(RenderRequestV2Schema.safeParse({ ...v2, script: 'unsafe' }).success).toBe(false);
    expect(RenderRequestV2Schema.safeParse({ ...v2, stagingDirectory: '/tmp/../source' }).success).toBe(false);
  });

  it('requires distinct owned copy paths inside the declared scratch directory', () => {
    const v2 = request();
    const ownedInput = v2.ownedInput as Record<string, unknown>;
    const source = ownedInput.source as Record<string, unknown>;
    const dependencies = ownedInput.dependencies as Array<Record<string, unknown>>;
    for (const relativePath of ['source.png', 'scratch/../source.png', '/tmp/source.png', 'scratch\\source.png']) {
      expect(RenderRequestV2Schema.safeParse({ ...v2, ownedInput: { ...ownedInput, source: { ...source, relativePath } } }).success).toBe(false);
    }
    expect(RenderRequestV2Schema.safeParse({ ...v2, ownedInput: { ...ownedInput, dependencies: [{ ...dependencies[0], relativePath: source.relativePath }] } }).success).toBe(false);
    expect(RenderRequestV2Schema.safeParse({ ...v2, ownedInput: { ...ownedInput, dependencies: [{ ...dependencies[0], sha256: 'f'.repeat(64) }] } }).success).toBe(false);
    expect(RenderRequestV2Schema.safeParse({ ...v2, ownedInput: { ...ownedInput, dependencies: [{ ...dependencies[0], original: { ...(dependencies[0]!.original as object), relativePath: '../link.psb' } }] } }).success).toBe(false);
    const { closureProof: _missing, ...unchecked } = ownedInput;
    expect(RenderRequestV2Schema.safeParse({ ...v2, ownedInput: { ...unchecked, dependencies: [] } }).success).toBe(false);
  });

  it('binds render evidence to the same operation and requires a digest-bound copy proof', () => {
    const v2 = evidence();
    expect(RenderEvidenceV2Schema.safeParse(v2).success).toBe(true);
    expect(RenderEvidenceSchema.safeParse(v2).success).toBe(false);
    expect(validateRenderEvidenceV2(v2, request()).success).toBe(true);
    expect(validateRenderEvidenceV2({ ...v2, operationId: 'other' }, request()).success).toBe(false);
    expect(validateRenderEvidenceV2({ ...v2, ownedInputProof: { relativePath: '../copy.json', sha256: 'a'.repeat(64) } }, request()).success).toBe(false);
    expect(RenderEvidenceV2Schema.safeParse({ ...v2, templateClosureProof: v2.ownedInputProof }).success).toBe(false);
    expect(RenderEvidenceV2Schema.safeParse({ ...v2, released: false }).success).toBe(false);
    expect(RenderEvidenceV2Schema.safeParse({ ...v2, releaseProof: v2.ownedInputProof }).success).toBe(false);
  });

  it('requires exact recovery identity and positive release proof', () => {
    const requestValue = recoveryRequest();
    const resultValue = recoveryResult();
    expect(RecoveryRequestV2Schema.safeParse(requestValue).success).toBe(true);
    expect(RecoveryResultV2Schema.safeParse(resultValue).success).toBe(true);
    expect(validateRecoveryResultV2(resultValue, requestValue).success).toBe(true);
    expect(RecoveryResultV2Schema.safeParse({ ...resultValue, released: false }).success).toBe(false);
    expect(RecoveryResultV2Schema.safeParse({ ...resultValue, releaseProof: null }).success).toBe(false);
    expect(RecoveryResultV2Schema.safeParse({ ...resultValue, safe: false, released: true }).success).toBe(false);
    expect(RecoveryResultV2Schema.safeParse({ ...resultValue, safe: false, released: false, releaseProof: null }).success).toBe(true);
    expect(validateRecoveryResultV2({ ...resultValue, operationId: 'other' }, requestValue).success).toBe(false);
  });

  it('ships deterministic Draft 2020-12 schemas for each v2 boundary', () => {
    for (const name of Object.keys(V2_SCHEMAS)) {
      const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/contracts/schema/v2', name), 'utf8'));
      expect(schema).toEqual(generatedV2Schema(name));
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      for (const variant of schema.anyOf ?? [schema]) expect(variant.properties.schemaVersion.const).toBe(2);
      expect(schema['x-runtime-only-invariants']).toContain('canonical filesystem containment and symlink/reparse-point rejection');
    }
  });

  it('accepts only a complete B-produced dependency inventory bound to the same attempt', () => {
    const prepare = readFixture('prepare-request.v2.valid.json');
    const prepared = readFixture<Record<string, unknown>>('prepared-input.v2.valid.json');
    expect(PrepareRequestV2Schema.safeParse(prepare).success).toBe(true);
    expect(PreparedInputManifestV2Schema.safeParse(prepared).success).toBe(true);
    expect(validatePreparedInputManifestV2(prepared, prepare).success).toBe(true);
    expect(validateRenderRequestV2(request(), prepared).success).toBe(true);
    expect(PreparedInputManifestV2Schema.safeParse({ ...prepared, closureComplete: false }).success).toBe(false);
    expect(validatePreparedInputManifestV2({ ...prepared, operationId: 'other' }, prepare).success).toBe(false);
    expect(validatePreparedInputManifestV2({ ...prepared, template: { ...(prepared.template as object), sha256: 'f'.repeat(64) } }, prepare).success).toBe(false);
    expect(validatePreparedInputManifestV2({ ...prepared, sourceRootPath: '/other/root' }, prepare).success).toBe(false);
    const ownedInput = request().ownedInput as Record<string, unknown>;
    expect(validateRenderRequestV2({ ...request(), ownedInput: { ...ownedInput, dependencies: [] } }, prepared).success).toBe(false);
    expect(validateRenderRequestV2({ ...request(), ownedInput: { ...ownedInput, sourceRootIdentity: '2'.repeat(64) } }, prepared).success).toBe(false);
    expect(validateRenderRequestV2({ ...request(), stagingDirectory: '/other/attempt' }, prepared).success).toBe(false);
    expect(validateRenderRequestV2({ ...request(), ownedInput: { ...ownedInput, closureProof: { relativePath: 'checks/other.json', sha256: 'd'.repeat(64) } } }, prepared).success).toBe(false);
  });

  it('represents unknown links as a blocked preparation without a fabricated closure', () => {
    const prepared = readFixture<Record<string, unknown>>('prepared-input.v2.valid.json');
    const { source: _source, dependencies: _dependencies, closureComplete: _complete, closureProof: _proof, ...identity } = prepared;
    const blocked = { ...identity, status: 'blocked', errors: [{ code: 'LINKED_SOURCE_UNISOLATED', category: 'capability', message: 'link cannot be resolved', retryable: false, evidencePaths: [] }], evidencePaths: [] };
    expect(PreparedInputManifestV2Schema.safeParse(blocked).success).toBe(true);
    expect(validatePreparedInputManifestV2(blocked, readFixture('prepare-request.v2.valid.json')).success).toBe(true);
    expect(validateRenderRequestV2(request(), blocked).success).toBe(false);
  });
});
