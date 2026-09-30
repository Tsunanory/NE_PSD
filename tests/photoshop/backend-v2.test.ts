import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { PrepareRequestV2, RenderEvidence, RenderRequestV2 } from '@ne-psd/contracts';
import { PhotoshopBackendV2Adapter } from '../../packages/photoshop/src/backend-v2.js';
import { sourceRootIdentity } from '../../packages/photoshop/src/prepare-v2.js';
import { SessionLock } from '../../packages/photoshop/src/session-lock.js';
import { CanonicalTraceWriter } from '../../packages/photoshop/src/trace.js';

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

  it.each([
    ['success', null],
    ['wrong-source-trace', 'PLACEMENT_TRACE_UNPROVEN'],
    ['wrong-template-trace', 'OPEN_TRACE_UNPROVEN'],
    ['wrong-operation-trace', 'another operation'],
    ['invalid-artifact', 'FILE_INVALID'],
    ['empty-qa', 'RENDER_QA_INCOMPLETE'],
    ['pending-journal', 'JOURNAL_UNSETTLED'],
    ['external-copy-link', 'TEMPLATE_LINK_ESCAPE'],
  ] as const)('binds owned raster render evidence: %s', async (mode, expectedError) => {
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
      let externalLinkAfterRender = false;
      const adapter = new PhotoshopBackendV2Adapter({
        base: { capabilities: async () => { throw Error('unused'); }, inspect: async () => { throw Error('unused'); }, qualify: async () => { throw Error('unused'); } },
        lock, templateLinks: { readLinks: async (path) => externalLinkAfterRender && path.startsWith(join(stage, 'scratch/template-v2')) ? [{ sourceKind: 'linked', path: templatePath }] : [] },
        templateRoot, templateRootId: 'fixture-root', contextRoot,
        renderOwned: async (request, ownedSourcePath, workingTemplatePath) => {
          expect(ownedSourcePath).toBe(await realpath(join(stage, 'scratch/input/source.png')));
          expect(workingTemplatePath).not.toBe(templatePath);
          const observedOperationId = mode === 'wrong-operation-trace' ? `${request.operationId}:old` : request.operationId;
          const document = new CanonicalTraceWriter(stage, join(stage, 'document-trace.jsonl'), { operationId: observedOperationId, requestId: 'document-lifecycle' });
          await document.file('pre', 'document-content', workingTemplatePath);
          await document.event('operation:openDocument', 'acknowledged', 'document-lifecycle', { type: 'operation', operation: 'openDocument', documentId: workingTemplatePath, state: 'issued', sequence: 1, timestamp: new Date().toISOString() });
          await document.event('state-transition:openDocument', 'acknowledged', 'document-lifecycle', { type: 'state-transition', operation: 'openDocument', documentId: workingTemplatePath, transition: 'acknowledged', sequence: 2, timestamp: new Date().toISOString() });
          await document.event('ownership-proof:new-document-after-open', 'acknowledged', 'document-lifecycle', { type: 'ownership-proof', documentId: 'doc-root', parentId: null, route: null, owned: true, ownershipKey: 'owned-doc-root', reason: 'new-document-after-open', beforeDocumentIds: [], afterDocumentIds: ['doc-root'], activeDocumentId: 'doc-root', expectedPath: mode === 'wrong-template-trace' ? templatePath : workingTemplatePath, expectedParentId: null, expectedRoute: null, provisional: false, sequence: 3, timestamp: new Date().toISOString() });
          await document.file('post', 'document-content', workingTemplatePath);
          const tool = new CanonicalTraceWriter(stage, join(stage, 'tool-trace.jsonl'), { operationId: observedOperationId, requestId: 'place-1' });
          await tool.bytes('pre', 'fixture_place', Buffer.from(JSON.stringify({ requestId: 'place-1', toolName: 'fixture_place', arguments: { documentId: 'doc-root', sourcePath: mode === 'wrong-source-trace' ? sourcePath : ownedSourcePath } })), 'place-1');
          await tool.bytes('post', 'fixture_place', Buffer.from('{}'), 'place-1');
          const journal = lock.operationJournal();
          await journal.issued({ operation: 'place', requestId: 'place-1', mutation: true });
          if (mode === 'pending-journal') await journal.unknown('place-1', 'lost reply');
          else await journal.acknowledged('place-1');
          await mkdir(join(stage, 'assets'));
          const artifacts = await Promise.all(request.profile.variants.map(async (variant, index) => {
            const path = `assets/${variant.id}.jpg`;
            const bytes = mode === 'invalid-artifact' ? Buffer.from(`not-an-image-${variant.id}`) : await sharp({ create: { width: request.profile.output.width, height: request.profile.output.height, channels: 3,
              background: ['#123456', '#345678', '#567890'][index]! } }).jpeg({ quality: 90 }).withIccProfile('srgb').toBuffer();
            await writeFile(join(stage, path), bytes);
            return { variantId: variant.id, path, sha256: hash(bytes), bytes: bytes.length, colorSpace: 'sRGB' as const,
              width: request.profile.output.width, height: request.profile.output.height, format: 'jpeg' as const };
          }));
          const evidence: RenderEvidence = { schemaVersion: 1, jobId: request.jobId, assetId: request.asset.assetId,
            attempt: request.attempt, profileSha256: request.profile.profileSha256, sourceSha256: request.asset.source.sha256,
            toolSchemaSha256: request.profile.toolSchemaSha256,
            geometry: mode === 'empty-qa' ? [] : request.profile.targets.map((target) => ({ target: target.target, reference: { left: 0, top: 0, right: 100, bottom: 100 },
              placed: { left: 0, top: 0, right: 100, bottom: 100 }, fitMode: request.profile.fitMode, clipped: true, adjacentToReference: true })),
            visibility: mode === 'empty-qa' ? [] : request.profile.variants.map((variant) => ({ variantId: variant.id, visibleVariantIds: [variant.id] })),
            artifacts: artifacts as RenderEvidence['artifacts'],
            checks: mode === 'empty-qa' ? [] : ['geometry-1', 'propagation', 'source-integrity'].map((id) => ({ id, passed: true, evidencePath: `checks/${id}.json` })),
            documentTracePath: 'document-trace.jsonl', toolTracePath: 'tool-trace.jsonl' };
          for (const check of evidence.checks) await writeFile(join(stage, check.evidencePath), JSON.stringify({ id: check.id, passed: true }));
          if (mode === 'external-copy-link') externalLinkAfterRender = true;
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
      if (mode === 'success') {
        const ownedPath = join(stage, request.ownedInput.source.relativePath);
        await writeFile(ownedPath, 'tampered owned bytes');
        await expect(adapter.render(request, new AbortController().signal)).rejects.toThrow('source or owned copy differs');
        await copyFile(sourcePath, ownedPath);
        const closurePath = join(stage, prepared.closureProof.relativePath);
        const originalClosure = await readFile(closurePath);
        await writeFile(closurePath, 'tampered proof');
        await expect(adapter.render(request, new AbortController().signal)).rejects.toThrow('evidence digest differs');
        await writeFile(closurePath, originalClosure);
      }
      if (expectedError) {
        await expect(adapter.render(request, new AbortController().signal)).rejects.toThrow(expectedError);
        expect(lock.journalMetadata).not.toBeNull();
        await expect(readFile(join(stage, 'checks/release-proof.json'))).rejects.toThrow();
        return;
      }
      const result = await adapter.render(request, new AbortController().signal);
      expect(result.released).toBe(true);
      expect(lock.journalMetadata).toBeNull();
      expect(hash(await readFile(join(stage, result.releaseProof.relativePath)))).toBe(result.releaseProof.sha256);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.each(['unchanged', 'changed-source', 'changed-dependency', 'changed-template'] as const)('recovers only exact persisted operation context: %s', async (mode) => {
    const home = await realpath(await mkdtemp('/private/tmp/ne-psd-v2-recovery-'));
    try {
      const sourceRoot = join(home, 'input');
      const stage = join(home, 'stage');
      const contextRoot = join(home, 'contexts');
      const templateRoot = join(home, 'templates');
      await Promise.all([mkdir(sourceRoot), mkdir(join(stage, 'checks'), { recursive: true }), mkdir(contextRoot), mkdir(templateRoot)]);
      const operationId = 'job-1:asset-1:1';
      await writeFile(join(sourceRoot, 'source.png'), 'immutable source');
      await writeFile(join(sourceRoot, 'dependency.psb'), 'immutable dependency');
      await writeFile(join(templateRoot, 'template.psd'), 'immutable template');
      const lock = new SessionLock({ lockPath: join(home, 'photoshop.lock'), installationPath: join(home, 'Photoshop.app'), hostId: 'test-host', installationDigest: hash('installation'), processStartIdentity: 'test-process' });
      const acquired = await lock.acquire({ operationId });
      const context = { jobId: 'job-1', assetId: 'asset-1', attempt: 1 as const, operationId,
        stagingDirectory: stage, sourceRootPath: sourceRoot, sourceRootIdentity: (await sourceRootIdentity(sourceRoot)).identity,
        templateRoot, ownershipToken: acquired.ownershipToken, previousPid: process.pid, previousProcessStartIdentity: 'test-process',
        originals: [
          { root: 'source' as const, relativePath: 'source.png', sha256: hash('immutable source'), bytes: Buffer.byteLength('immutable source') },
          { root: 'source' as const, relativePath: 'dependency.psb', sha256: hash('immutable dependency'), bytes: Buffer.byteLength('immutable dependency') },
          { root: 'template' as const, relativePath: 'template.psd', sha256: hash('immutable template'), bytes: Buffer.byteLength('immutable template') },
        ] };
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
      if (mode !== 'unchanged') {
        const target = mode === 'changed-template' ? join(templateRoot, 'template.psd') : join(sourceRoot, mode === 'changed-source' ? 'source.png' : 'dependency.psb');
        await writeFile(target, 'mutated original');
        const unsafe = await adapter.recover(request, new AbortController().signal);
        expect(unsafe).toMatchObject({ safe: false, released: false, releaseProof: null });
        expect(lock.journalMetadata).not.toBeNull();
        await expect(readFile(join(stage, 'checks/release-proof.json'))).rejects.toThrow();
        return;
      }
      const result = await adapter.recover(request, new AbortController().signal);
      expect(result.safe).toBe(true);
      expect(result.released).toBe(true);
      expect(lock.journalMetadata).toBeNull();
      expect(result.releaseProof).not.toBeNull();
      if (result.releaseProof) expect(hash(await readFile(join(stage, result.releaseProof.relativePath)))).toBe(result.releaseProof.sha256);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
