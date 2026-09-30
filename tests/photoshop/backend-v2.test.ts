import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { PrepareRequestV2, RenderEvidence, RenderRequestV2 } from '@ne-psd/contracts';
import { PhotoshopBackendV2Adapter } from '../../packages/photoshop/src/backend-v2.js';
import { sourceRootIdentity } from '../../packages/photoshop/src/prepare-v2.js';
import { SessionLock } from '../../packages/photoshop/src/session-lock.js';
import { CanonicalTraceWriter, renderTraceOperationId } from '../../packages/photoshop/src/trace.js';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join('tests/fixtures/contracts', name), 'utf8')) as T;

describe('Photoshop V2 owned raster rendering', () => {
  it('blocks PSD inventory without a qualified read-only scanner', async () => {
    const home = await realpath(await mkdtemp('/private/tmp/ne-psd-v2-psd-'));
    try {
      const sourceRoot = join(home, 'input');
      const stage = join(home, 'stage');
      const templateRoot = join(home, 'templates');
      const contextRoot = join(home, 'contexts');
      await Promise.all([mkdir(join(sourceRoot, 'assets'), { recursive: true }), mkdir(stage), mkdir(templateRoot), mkdir(contextRoot)]);
      const source = Buffer.from('PSD bytes with unknown links');
      await writeFile(join(sourceRoot, 'assets/source.psd'), source);
      const request = await fixture<PrepareRequestV2>('prepare-request.v2.valid.json');
      request.stagingDirectory = stage;
      request.sourceRoot.path = sourceRoot;
      request.sourceRoot.identity = (await sourceRootIdentity(sourceRoot)).identity;
      request.asset.source.relativePath = 'assets/source.psd';
      request.asset.source.sha256 = hash(source);
      request.asset.sourceBytes = source.length;
      const adapter = new PhotoshopBackendV2Adapter({
        base: { capabilities: async () => { throw Error('unused'); }, inspect: async () => { throw Error('unused'); }, qualify: async () => { throw Error('unused'); } },
        lock: new SessionLock({ lockPath: join(home, 'photoshop.lock'), installationPath: join(home, 'Photoshop.app'), hostId: 'test-host', installationDigest: hash('installation'), processStartIdentity: 'test-process' }),
        templateLinks: { readLinks: async () => [] }, templateRoot, templateRootId: 'fixture-root', contextRoot,
        renderOwned: async () => { throw Error('unused'); }, recoveryRuntime: async () => { throw Error('unused'); },
      });
      const result = await adapter.prepareOwnedInput(request, new AbortController().signal);
      expect(result.status).toBe('blocked');
      if (result.status === 'blocked') expect(result.errors[0]?.code).toBe('LINK_SCAN_UNAVAILABLE');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('binds exact owned bytes and both proof sets to confirmed release', async () => {
    const home = await realpath(await mkdtemp('/private/tmp/ne-psd-v2-'));
    try {
      const sourceRoot = join(home, 'input');
      const stage = join(home, 'stage');
      const contextRoot = join(home, 'contexts');
      const templateRoot = join(home, 'templates');
      await Promise.all([mkdir(join(sourceRoot, 'assets'), { recursive: true }), mkdir(stage), mkdir(contextRoot), mkdir(join(templateRoot, 'assets'), { recursive: true })]);
      const sourceBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
      const sourcePath = join(sourceRoot, 'assets/source.png');
      const templatePath = join(templateRoot, 'assets/template.psd');
      await writeFile(sourcePath, sourceBytes);
      await writeFile(templatePath, 'template PSD fixture');
      const prepare = await fixture<PrepareRequestV2>('prepare-request.v2.valid.json');
      prepare.stagingDirectory = stage;
      prepare.asset.source.sha256 = hash(sourceBytes);
      prepare.asset.sourceBytes = sourceBytes.length;
      prepare.sourceRoot.path = sourceRoot;
      prepare.sourceRoot.identity = (await sourceRootIdentity(sourceRoot)).identity;
      prepare.profile.template.sha256 = hash('template PSD fixture');
      const lock = new SessionLock({ lockPath: join(home, 'photoshop.lock'), installationPath: join(home, 'Photoshop.app'), hostId: 'test-host', installationDigest: hash('installation'), processStartIdentity: 'test-process' });
      const adapter = new PhotoshopBackendV2Adapter({
        base: { capabilities: async () => { throw Error('unused'); }, inspect: async () => { throw Error('unused'); }, qualify: async () => { throw Error('unused'); } },
        lock, templateLinks: { readLinks: async () => [] },
        templateRoot, templateRootId: 'fixture-root', contextRoot,
        renderOwned: async (request, ownedSourcePath, workingTemplatePath) => {
          expect(ownedSourcePath).toBe(await realpath(join(stage, 'scratch/input/source.png')));
          expect(workingTemplatePath).not.toBe(templatePath);
          const operationId = renderTraceOperationId(request);
          for (const path of ['document-trace.jsonl', 'tool-trace.jsonl']) {
            const trace = new CanonicalTraceWriter(stage, join(stage, path), { operationId, requestId: 'render-1' });
            await trace.bytes('pre', 'openDocument', sourceBytes);
            await trace.bytes('post', 'openDocument', sourceBytes);
          }
          const journal = lock.operationJournal();
          await journal.issued({ operation: 'openDocument', requestId: 'render-1', mutation: false });
          await journal.acknowledged('render-1');
          await mkdir(join(stage, 'assets'));
          const artifacts = await Promise.all(request.profile.variants.map(async (variant) => {
            const path = `assets/${variant.id}.jpg`;
            const bytes = Buffer.from(`artifact-${variant.id}`);
            await writeFile(join(stage, path), bytes);
            return { variantId: variant.id, path, sha256: hash(bytes), bytes: bytes.length, colorSpace: 'sRGB' as const,
              width: request.profile.output.width, height: request.profile.output.height, format: 'jpeg' as const };
          }));
          const evidence: RenderEvidence = { schemaVersion: 1, jobId: request.jobId, assetId: request.asset.assetId,
            attempt: request.attempt, profileSha256: request.profile.profileSha256, sourceSha256: request.asset.source.sha256,
            toolSchemaSha256: request.profile.toolSchemaSha256, geometry: [], visibility: [], artifacts: artifacts as RenderEvidence['artifacts'], checks: [],
            documentTracePath: 'document-trace.jsonl', toolTracePath: 'tool-trace.jsonl' };
          return { evidence, openedSourcePath: ownedSourcePath, openedTemplatePath: workingTemplatePath,
            quiescent: true as const, ownedDocumentsRemaining: 0 as const };
        },
        recoveryRuntime: async () => { throw Error('unused'); },
      });
      const prepared = await adapter.prepareOwnedInput(prepare, new AbortController().signal);
      expect(prepared.status).toBe('prepared');
      if (prepared.status !== 'prepared') return;
      await mkdir(join(stage, 'scratch/input'), { recursive: true });
      await copyFile(sourcePath, join(stage, 'scratch/input/source.png'));
      const request = await fixture<RenderRequestV2>('render-request.v2.valid.json');
      request.stagingDirectory = stage;
      request.profile = prepare.profile;
      request.asset = prepare.asset;
      request.ownedInput.source.sha256 = prepare.asset.source.sha256;
      request.ownedInput.source.bytes = prepare.asset.sourceBytes;
      request.ownedInput.dependencies = [];
      request.ownedInput.closureProof = prepared.closureProof;
      request.ownedInput.sourceRootIdentity = prepare.sourceRoot.identity;
      const ownedPath = join(stage, request.ownedInput.source.relativePath);
      await writeFile(ownedPath, 'tampered owned bytes');
      await expect(adapter.render(request, new AbortController().signal)).rejects.toThrow('source or owned copy differs');
      await copyFile(sourcePath, ownedPath);
      const closurePath = join(stage, prepared.closureProof.relativePath);
      const originalClosure = await readFile(closurePath);
      await writeFile(closurePath, 'tampered proof');
      await expect(adapter.render(request, new AbortController().signal)).rejects.toThrow('evidence digest differs');
      await writeFile(closurePath, originalClosure);
      const result = await adapter.render(request, new AbortController().signal);
      expect(result.released).toBe(true);
      expect(lock.journalMetadata).toBeNull();
      expect(hash(await readFile(join(stage, result.releaseProof.relativePath)))).toBe(result.releaseProof.sha256);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('recovers only exact persisted operation context and releases after journal reconciliation', async () => {
    const home = await realpath(await mkdtemp('/private/tmp/ne-psd-v2-recovery-'));
    try {
      const sourceRoot = join(home, 'input');
      const stage = join(home, 'stage');
      const contextRoot = join(home, 'contexts');
      const templateRoot = join(home, 'templates');
      await Promise.all([mkdir(sourceRoot), mkdir(join(stage, 'checks'), { recursive: true }), mkdir(contextRoot), mkdir(templateRoot)]);
      const operationId = 'job-1:asset-1:1';
      const lock = new SessionLock({ lockPath: join(home, 'photoshop.lock'), installationPath: join(home, 'Photoshop.app'), hostId: 'test-host', installationDigest: hash('installation'), processStartIdentity: 'test-process' });
      const acquired = await lock.acquire({ operationId });
      const context = { jobId: 'job-1', assetId: 'asset-1', attempt: 1 as const, operationId,
        stagingDirectory: stage, sourceRootPath: sourceRoot, sourceRootIdentity: (await sourceRootIdentity(sourceRoot)).identity,
        templateRoot, ownershipToken: acquired.ownershipToken, previousPid: process.pid, previousProcessStartIdentity: 'test-process' };
      await writeFile(join(contextRoot, `${hash(operationId)}.json`), JSON.stringify(context));
      await writeFile(join(stage, 'checks/recovery-context.json'), JSON.stringify(context));
      const journal = lock.operationJournal();
      await journal.issued({ operation: 'openDocument', requestId: 'late-open', mutation: true });
      await journal.unknown('late-open', 'transport timed out');
      await lock.markUnknownMutation();
      const adapter = new PhotoshopBackendV2Adapter({
        base: { capabilities: async () => { throw Error('unused'); }, inspect: async () => { throw Error('unused'); }, qualify: async () => { throw Error('unused'); } },
        lock, templateLinks: { readLinks: async () => [] }, templateRoot, templateRootId: 'fixture-root', contextRoot,
        renderOwned: async () => { throw Error('unused'); },
        recoveryRuntime: async () => ({
          journal: { read: () => journal.read(), filePath: lock.journalPath }, journalPath: lock.journalPath,
          operationJournal: journal, identity: { ...lock.journalIdentity!, jobRoot: stage },
          listDocuments: async () => [], isIdle: async () => true, safeCompletion: async () => true,
          verifyOriginals: async () => true, closeDiscard: async () => undefined, clearPendingOperations: async () => undefined,
        }),
      });
      const request = { schemaVersion: 2 as const, jobId: 'job-1', assetId: 'asset-1', attempt: 1 as const, operationId };
      expect((await adapter.recover({ ...request, assetId: 'wrong' }, new AbortController().signal)).safe).toBe(false);
      expect(lock.journalMetadata).not.toBeNull();
      const result = await adapter.recover(request, new AbortController().signal);
      expect(result.safe).toBe(true);
      expect(result.released).toBe(true);
      expect(lock.journalMetadata).toBeNull();
      expect(result.releaseProof).not.toBeNull();
      if (result.releaseProof) expect(hash(await readFile(join(stage, result.releaseProof.relativePath)))).toBe(result.releaseProof.sha256);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
