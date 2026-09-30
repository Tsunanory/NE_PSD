import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvidenceBundleManifest, VisualReviewRequest } from '@ne-psd/contracts';
import { readReviewImages, resolveCommittedOutput } from '../../apps/desktop/src/main/evidence.js';
import { ReviewEvidence } from '../../apps/desktop/src/renderer/jobs/ReviewEvidence.js';
import { readEvidence, openCommittedOutput, redactLog } from '../../apps/desktop/src/main/evidence-access.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
function reviewFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ne-psd-review-'));
  mkdirSync(join(root, 'images'));
  for (const name of ['contact.png', 'one.png', 'two.png', 'three.png']) writeFileSync(join(root, 'images', name), png);
  const artifacts = (['1', '2', '3'] as const).map((variantId, index) => ({ variantId, path: `images/${['one', 'two', 'three'][index]}.png`, sha256: hash, bytes: png.length, width: 1, height: 1, format: 'png' as const, colorSpace: 'sRGB' as const })) as VisualReviewRequest['artifacts'];
  const request: VisualReviewRequest = { requestId: 'request-1', jobId: 'job-1', assetId: 'asset-1', attempt: 1, preAttestationContentSha256: 'a'.repeat(64), profileSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), toolSchemaSha256: 'd'.repeat(64), reviewPolicySha256: 'e'.repeat(64), artifacts, contactSheet: { relativePath: 'images/contact.png', sha256: hash } };
  const paths = ['contact.png', 'one.png', 'three.png', 'two.png'].map((name) => `images/${name}`);
  const manifest: EvidenceBundleManifest = { schemaVersion: 1, jobId: 'job-1', assetId: 'asset-1', attempt: 1,
    files: paths.map((relativePath) => ({ relativePath, sha256: hash, bytes: png.length, role: relativePath.endsWith('contact.png') ? 'imageInput' as const : 'artifact' as const })),
    visionInputs: artifacts.map((artifact) => ({ id: artifact.variantId, role: 'output' as const, relativePath: artifact.path, sha256: hash, width: 1, height: 1, variantId: artifact.variantId, derivedFromSha256: hash, crop: null })) };
  return { root, request, manifest };
}

describe('desktop evidence boundary', () => {
  it('loads only three digest-bound image inputs and contact sheet', async () => {
    const { root, request, manifest } = reviewFixture();
    const images = await readReviewImages(root, request, manifest);
    expect(images.variants.map((item) => item.variantId)).toEqual(['1', '2', '3']);
    expect(images.variants.every((item) => item.dataUrl.startsWith('data:image/png;base64,'))).toBe(true);
    expect(images.contactSheet.dataUrl).toContain('data:image/png;base64,');
    const markup = renderToStaticMarkup(React.createElement(ReviewEvidence, { request, images }));
    expect((markup.match(/<img/g) ?? []).length).toBe(4);
    expect(markup).toContain('Выбор оператора обязателен');
    expect(markup).not.toContain('aria-pressed="true"');
  });
  it('rejects stale digest, unlisted path, symlink and executable bytes', async () => {
    const { root, request, manifest } = reviewFixture();
    await expect(readReviewImages(root, { ...request, artifacts: [{ ...request.artifacts[0], sha256: 'f'.repeat(64) }, request.artifacts[1], request.artifacts[2]] }, manifest)).rejects.toThrow();
    await expect(readReviewImages(root, { ...request, contactSheet: { ...request.contactSheet, relativePath: '../other.png' } }, manifest)).rejects.toThrow();
    writeFileSync(join(root, 'images', 'one.png'), '<script>alert(1)</script>');
    await expect(readReviewImages(root, request, manifest)).rejects.toThrow();
    writeFileSync(join(root, 'images', 'one.png'), png);
    symlinkSync(join(root, 'images', 'one.png'), join(root, 'images', 'alias.png'));
    const linked = { ...request, artifacts: [{ ...request.artifacts[0], path: 'images/alias.png' }, request.artifacts[1], request.artifacts[2]] };
    await expect(readReviewImages(root, linked, manifest)).rejects.toThrow();
  });
  it('keeps the legacy manifest read constrained and never opens staging', () => {
    const { root } = reviewFixture();
    mkdirSync(join(root, 'committed'));
    writeFileSync(join(root, 'committed', 'pass.json'), '{}');
    expect(readEvidence(root, { files: [{ relativePath: 'committed/pass.json' }] }, 'committed/pass.json')).toBe('{}');
    expect(() => readEvidence(root, { files: [{ relativePath: 'committed/pass.json' }] }, '../secret')).toThrow();
    expect(() => openCommittedOutput(root, 'staging')).toThrow();
    expect(openCommittedOutput(root, 'committed')).toContain('committed');
    expect(redactLog('failed /Users/test/secret token=abc123')).toBe('failed [path] token=[redacted]');
  });
  it('resolves only a matching committed output record', async () => {
    const { root } = reviewFixture();
    const record = { jobId: 'job-1', relativePath: 'images/one.png', sha256: hash, bytes: png.length, state: 'complete' as const };
    await expect(resolveCommittedOutput(root, 'job-1', record)).resolves.toContain('images/one.png');
    await expect(resolveCommittedOutput(root, 'job-2', record)).rejects.toThrow();
    await expect(resolveCommittedOutput(root, 'job-1', { ...record, sha256: 'f'.repeat(64) })).rejects.toThrow();
    await expect(resolveCommittedOutput(root, 'job-1', { ...record, relativePath: 'staging/one.png' })).rejects.toThrow();
  });
  it('rejects oversized input before reading and yields during a large verified read', async () => {
    const { root } = reviewFixture();
    const path = join(root, 'images', 'large.png');
    writeFileSync(path, png);
    truncateSync(path, 50 * 1024 * 1024 + 1);
    const oversized = { jobId: 'job-1', relativePath: 'images/large.png', sha256: hash, bytes: 50 * 1024 * 1024 + 1, state: 'complete' as const };
    await expect(resolveCommittedOutput(root, 'job-1', oversized)).rejects.toThrow('size mismatch');
    const large = Buffer.alloc(4 * 1024 * 1024);
    png.copy(large);
    writeFileSync(path, large);
    const record = { ...oversized, sha256: createHash('sha256').update(large).digest('hex'), bytes: large.length };
    let eventLoopAdvanced = false;
    const read = resolveCommittedOutput(root, 'job-1', record);
    setImmediate(() => { eventLoopAdvanced = true; });
    await expect(read).resolves.toContain('images/large.png');
    expect(eventLoopAdvanced).toBe(true);
  });
});
