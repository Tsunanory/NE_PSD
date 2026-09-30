import { describe, expect, it } from 'vitest';
import {
  OwnedInputProofV2Schema, TemplateClosureProofV2Schema, ReleaseProofV2Schema,
  validateOwnedInputProofV2, validateTemplateClosureProofV2, validateReleaseProofV2,
} from '@ne-psd/contracts';
import { readFixture } from '../fixtures/read-fixture.js';

const request = () => readFixture<Record<string, any>>('render-request.v2.valid.json');
const prepared = () => readFixture<Record<string, any>>('prepared-input.v2.valid.json');
const identity = { schemaVersion: 2, jobId: 'job-1', assetId: 'asset-1', attempt: 1, operationId: 'job-1:asset-1:1' };
const entry = (original: any, ownedRelativePath: string, bytes: number) => ({ original, ownedRelativePath, bytes, originalBeforeSha256: original.sha256, originalAfterSha256: original.sha256, copyBeforeSha256: original.sha256, copyAfterSha256: original.sha256 });

describe('render v2 proof files', () => {
  it('ships valid standalone proof fixtures', () => {
    expect(OwnedInputProofV2Schema.safeParse(readFixture('owned-input-proof.v2.valid.json')).success).toBe(true);
    expect(TemplateClosureProofV2Schema.safeParse(readFixture('template-closure-proof.v2.valid.json')).success).toBe(true);
    expect(ReleaseProofV2Schema.safeParse(readFixture('release-proof.v2.valid.json')).success).toBe(true);
  });
  it('binds the opened asset source and exact discovered linked inventory', () => {
    const value = request();
    const source = value.ownedInput.source;
    const dependency = value.ownedInput.dependencies[0];
    const proof = { ...identity, sourceRootIdentity: value.ownedInput.sourceRootIdentity, openedSourceRelativePath: source.relativePath,
      source: entry(value.asset.source, source.relativePath, source.bytes),
      dependencies: [{ ...entry(dependency.original, dependency.relativePath, dependency.bytes), identity: dependency.identity, sourceKind: 'linked' }],
      observedLinks: [{ parentOwnedRelativePath: source.relativePath, childOwnedRelativePath: dependency.relativePath, identity: dependency.identity }],
      closureProof: value.ownedInput.closureProof };
    expect(OwnedInputProofV2Schema.safeParse(proof).success).toBe(true);
    expect(validateOwnedInputProofV2(proof, value, prepared()).success).toBe(true);
    expect(validateOwnedInputProofV2({ ...proof, dependencies: [] }, value, prepared()).success).toBe(false);
    expect(validateOwnedInputProofV2({ ...proof, openedSourceRelativePath: 'scratch/wrong.png' }, value, prepared()).success).toBe(false);
    expect(validateOwnedInputProofV2({ ...proof, source: { ...proof.source, originalAfterSha256: 'f'.repeat(64) } }, value, prepared()).success).toBe(false);
    expect(validateOwnedInputProofV2({ ...proof, observedLinks: [] }, value, prepared()).success).toBe(false);
  });

  it('binds the template working copy and document route', () => {
    const value = request();
    const template = value.profile.template;
    const workingTemplateRelativePath = 'template/working.psd';
    const proof = { ...identity, template, workingTemplateRelativePath,
      closureEntries: [{ ...entry(template, workingTemplateRelativePath, 20), identity: 'template-root', sourceKind: 'template' }],
      observedLinks: [], documentTrace: { relativePath: 'checks/document-trace.json', sha256: 'b'.repeat(64) } };
    expect(TemplateClosureProofV2Schema.safeParse(proof).success).toBe(true);
    expect(validateTemplateClosureProofV2(proof, value).success).toBe(true);
    expect(validateTemplateClosureProofV2({ ...proof, template: { ...template, sha256: 'f'.repeat(64) } }, value).success).toBe(false);
    expect(validateTemplateClosureProofV2({ ...proof, closureEntries: [] }, value).success).toBe(false);
  });

  it('requires release identity and exact saved owner and journal digests', () => {
    const ownerSnapshot = { relativePath: 'checks/release-owner.json', sha256: 'a'.repeat(64) };
    const journalSnapshot = { relativePath: 'checks/release-journal.jsonl', sha256: 'b'.repeat(64) };
    const proof = { ...identity, released: true, ownerIdentitySha256: ownerSnapshot.sha256, journalSha256: journalSnapshot.sha256, ownerSnapshot, journalSnapshot };
    expect(ReleaseProofV2Schema.safeParse(proof).success).toBe(true);
    expect(validateReleaseProofV2(proof, identity).success).toBe(true);
    expect(validateReleaseProofV2({ ...proof, operationId: 'other' }, identity).success).toBe(false);
    expect(ReleaseProofV2Schema.safeParse({ ...proof, journalSha256: 'c'.repeat(64) }).success).toBe(false);
    expect(ReleaseProofV2Schema.safeParse({ ...proof, released: false }).success).toBe(false);
  });
});
