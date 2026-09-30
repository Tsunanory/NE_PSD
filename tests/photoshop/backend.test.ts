import { access, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { RenderRequestSchema } from '@ne-psd/contracts';
import { createPhotoshopBackend, validateCanonicalTrace, type BackendAdapter, type LifecycleAcknowledgement, type RenderSession } from '../../packages/photoshop/src/backend.js';
import { CanonicalTraceWriter, renderTraceOperationId } from '../../packages/photoshop/src/trace.js';

const capability = {
  backendId: 'alisaitteke' as const,
  version: 'fake',
  sourceCommit: 'fake',
  toolSchemaSha256: '9c9073a076825a775ae8ca3a8fd31a4cd083762112fc752d2a6ffade64e55d35',
  supportedFitModes: ['cover', 'contain', 'stretch'] as const,
  platform: 'darwin' as const,
  photoshopVersion: 'fake',
  evidencePaths: ['assets/capabilities.json'],
};

async function request(stagingDirectory: string) {
  const input = JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/contracts/render-request.valid.json'), 'utf8')) as Record<string, unknown>;
  const profile = input.profile as Record<string, unknown>;
  profile.output = { ...(profile.output as object), format: 'png' };
  return RenderRequestSchema.parse({ ...input, stagingDirectory, profile });
}

function session(events: string[], failVariant?: string, overrides: Partial<RenderSession> = {}): RenderSession {
  let visible: '1' | '2' | '3' = '1';
  const target = { documentRoute: [], layerPath: [{ name: 'Target', kind: 'smartObject' as const, fingerprint: 'target-fp' }] };
  const reference = { left: 100, top: 200, right: 900, bottom: 600 };
  const root = { workingTemplatePath: '/job/template.psd', resources: [{ resourceId: 'shared', target, reference: { documentRoute: [], layerPath: [{ name: 'Reference', kind: 'pixel' as const, fingerprint: 'reference-fp' }] }, input: null }] };
  const exporter = {
    restoreQualifiedState: async () => { events.push('restore'); return { acknowledged: true }; },
    hideVariant: async () => { events.push('hide'); return { acknowledged: true }; },
    showVariant: async (variantId: '1' | '2' | '3') => { visible = variantId; events.push('show'); return { acknowledged: true }; },
    readVisibility: async () => ({ acknowledged: true, ancestorVisible: true, visibleVariantIds: [visible] }),
    prepareExport: async () => ({ acknowledged: true, disposable: true, documentId: 'export-copy', convertedPixels: true, renderingIntent: 'relative-colorimetric' as const, mode: 'RGB' as const, bitDepth: 8 as const, embeddedProfile: 'sRGB' as const, flattened: false, alpha: 'preserve' as const }),
    exportVariant: async ({ variantId, destination }: { variantId: '1' | '2' | '3'; destination: string }) => {
      events.push(`export-${variantId}`);
      if (variantId === failVariant) return { acknowledged: false, path: destination };
      await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: Number(variantId) * 50, g: 120, b: 200, alpha: 1 } } }).png().withMetadata({ icc: 'srgb' }).toFile(destination);
      return { acknowledged: true, path: destination };
    },
    cleanupDisposable: async () => { events.push('cleanup-export'); return { acknowledged: true }; },
  };
  return {
    ...root,
    exporter,
    openRoot: async (): Promise<LifecycleAcknowledgement> => { events.push('open-root'); return { acknowledged: true }; },
    verifyGraph: async (): Promise<LifecycleAcknowledgement> => { events.push('verify-graph'); return { acknowledged: true }; },
    renderResource: async () => { events.push('render-resource'); return { target, reference, placed: reference, fitMode: 'cover', clipped: true, adjacentToReference: true }; },
    verifyPropagation: async (): Promise<LifecycleAcknowledgement> => { events.push('verify-propagation'); return { acknowledged: true }; },
    verifyOriginals: async () => { events.push('verify-originals'); return { acknowledged: true, unchanged: true, dependenciesUnchanged: true }; },
    discard: async () => { events.push('discard'); return { acknowledged: true, quiescent: true }; },
    ...overrides,
  };
}

function adapter(events: string[], makeSession: () => RenderSession, markUnknownMutation?: () => Promise<void>): BackendAdapter {
  return {
    lock: { runExclusive: async (_id, fn) => fn(), ...(markUnknownMutation ? { markUnknownMutation } : {}) },
    capabilities: async () => capability,
    inspect: async () => { throw new Error('not used'); },
    createWorkingCopy: async (request) => {
      events.push('working-copy'); const created = makeSession();
      const documentTracePath = join(request.stagingDirectory, 'document-trace.jsonl'); const toolTracePath = join(request.stagingDirectory, 'tool-trace.jsonl');
      for (const [kind, path] of [['document', documentTracePath], ['tool', toolTracePath]] as const) {
        try { await access(path); } catch {
          const trace = new CanonicalTraceWriter(request.stagingDirectory, path, { operationId: renderTraceOperationId(request), requestId: kind });
          await trace.bytes('pre', kind, Buffer.from('pre-trace-content'));
          await trace.bytes('post', kind, Buffer.from('post-trace-content'));
        }
      }
      return { ...created, documentTracePath, toolTracePath };
    },
  };
}

describe('B12 PhotoshopBackend transaction boundary', () => {
  it('isolates, renders and discards each asset transaction before returning strict evidence', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'b12-first-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'b12-second-'));
    const sourcePath = join(firstRoot, 'source.png');
    const dependencyPath = join(firstRoot, 'dependency.psb');
    await writeFile(sourcePath, 'immutable-source');
    await writeFile(dependencyPath, 'immutable-dependency');
    const sourceBefore = await readFile(sourcePath);
    const dependencyBefore = await readFile(dependencyPath);
    const events: string[] = [];
    const backend = createPhotoshopBackend(adapter(events, () => session(events)));
    const first = await backend.render(await request(firstRoot), new AbortController().signal);
    const second = await backend.render(await request(secondRoot), new AbortController().signal);
    expect(first.artifacts).toHaveLength(3);
    expect(second.artifacts).toHaveLength(3);
    expect(events.filter((event) => event === 'working-copy')).toHaveLength(2);
    expect(events.indexOf('discard')).toBeLessThan(events.lastIndexOf('working-copy'));
    expect(events).toContain('verify-originals');
    expect(events.filter((event) => event === 'render-resource')).toHaveLength(2);
    for (const artifact of first.artifacts) await access(join(firstRoot, artifact.path));
    await access(join(firstRoot, first.documentTracePath));
    await access(join(firstRoot, first.toolTracePath));
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
    expect(await readFile(dependencyPath)).toEqual(dependencyBefore);
  });

  it('does not return evidence after an ambiguous variant failure or discard the owned copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b12-failure-'));
    const events: string[] = [];
    const backend = createPhotoshopBackend(adapter(events, () => session(events, '2'), async () => undefined));
    await expect(backend.render(await request(root), new AbortController().signal)).rejects.toMatchObject({ code: 'EXPORT_UNACKNOWLEDGED' });
    expect(events).not.toContain('discard');
    expect(events).not.toContain('verify-originals');
  });

  it('rejects malformed lifecycle acknowledgements without sealing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b12-ack-'));
    const events: string[] = [];
    const broken = session(events, undefined, { openRoot: async () => undefined as never });
    let marked = false;
    const backend = createPhotoshopBackend(adapter(events, () => broken, async () => { marked = true; }));
    await expect(backend.render(await request(root), new AbortController().signal)).rejects.toMatchObject({ code: 'OPENROOT_UNACKNOWLEDGED', category: 'ambiguousState', retryable: false, evidencePaths: [] });
    expect(marked).toBe(true);
    expect(events).not.toContain('discard');
  });

  it('preserves the recovery barrier after an ambiguous mutation and retains existing traces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b12-ambiguous-'));
    const trace = join(root, 'document-trace.json');
    await writeFile(trace, 'prior-trace');
    const events: string[] = [];
    let marked = false;
    const ambiguous = session(events, undefined, {
      documentTracePath: trace,
      renderResource: async () => { events.push('render-resource'); throw Object.assign(new Error('lost reply'), { code: 'TRANSPORT_AMBIGUOUS' }); },
    });
    const backend = createPhotoshopBackend(adapter(events, () => ambiguous, async () => { marked = true; }));
    await expect(backend.render(await request(root), new AbortController().signal)).rejects.toMatchObject({ category: 'ambiguousState', retryable: false });
    expect(marked).toBe(true);
    expect(events).not.toContain('discard');
    expect(await readFile(trace, 'utf8')).toBe('prior-trace');
  });

  it('fails closed without discarding when an ambiguous mutation cannot persist the barrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b15-no-barrier-'));
    const events: string[] = [];
    const ambiguous = session(events, undefined, { renderResource: async () => { events.push('render-resource'); throw Object.assign(new Error('lost reply'), { code: 'TRANSPORT_AMBIGUOUS' }); } });
    const backend = createPhotoshopBackend(adapter(events, () => ambiguous));
    await expect(backend.render(await request(root), new AbortController().signal)).rejects.toMatchObject({ code: 'RECOVERY_BARRIER_UNAVAILABLE', category: 'ambiguousState', retryable: false });
    expect(events).not.toContain('discard');
  });

  it('fails closed without discarding when barrier persistence fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b15-barrier-fails-'));
    const events: string[] = [];
    const ambiguous = session(events, undefined, { renderResource: async () => { events.push('render-resource'); throw Object.assign(new Error('lost reply'), { code: 'TRANSPORT_AMBIGUOUS' }); } });
    const backend = createPhotoshopBackend(adapter(events, () => ambiguous, async () => { throw new Error('lock metadata unavailable'); }));
    await expect(backend.render(await request(root), new AbortController().signal)).rejects.toMatchObject({ code: 'RECOVERY_BARRIER_PERSIST_FAILED', category: 'ambiguousState', retryable: false });
    expect(events).not.toContain('discard');
  });

  it('rejects fabricated trace placeholders and accepts independently hashed pre/post records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b15-traces-'));
    const events: string[] = [];
    const original = adapter(events, () => session(events));
    const invalid = { ...original, createWorkingCopy: async (request: Parameters<BackendAdapter['createWorkingCopy']>[0], signal: AbortSignal) => { const created = await original.createWorkingCopy(request, signal); await writeFile(join(request.stagingDirectory, 'document-trace.jsonl'), JSON.stringify({ preSha256: 'a'.repeat(64), postSha256: 'b'.repeat(64) })); return created; } };
    await expect(createPhotoshopBackend(invalid).render(await request(root), new AbortController().signal)).rejects.toMatchObject({ code: 'TRACE_INVALID' });
  });

  it('rejects missing, reordered, wrong-identity, changed-hash, changed-byte and escaped snapshot evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b15-validator-'));
    const tracePath = join(root, 'document-trace.jsonl');
    const writer = new CanonicalTraceWriter(root, tracePath, { operationId: 'job:asset:1', requestId: 'document' });
    await writer.bytes('pre', 'document-content', Buffer.from('before'));
    await writer.bytes('post', 'document-content', Buffer.from('after'));
    const original = await readFile(tracePath, 'utf8');
    const records = original.trim().split('\n').map((line) => JSON.parse(line) as { path: string; sha256: string; operationId: string });
    const writeRecords = async (value: typeof records) => writeFile(tracePath, `${value.map((record) => JSON.stringify(record)).join('\n')}\n`);
    await expect(validateCanonicalTrace(root, 'missing.jsonl', 'job:asset:1')).rejects.toMatchObject({ code: 'TRACE_MISSING' });
    await expect(validateCanonicalTrace(root, 'document-trace.jsonl', 'job:other:1')).rejects.toMatchObject({ code: 'TRACE_INVALID' });
    await writeRecords([...records].reverse());
    await expect(validateCanonicalTrace(root, 'document-trace.jsonl', 'job:asset:1')).rejects.toMatchObject({ code: 'TRACE_INVALID' });
    records[1]!.sha256 = '0'.repeat(64);
    await writeRecords(records);
    await expect(validateCanonicalTrace(root, 'document-trace.jsonl', 'job:asset:1')).rejects.toMatchObject({ code: 'TRACE_INVALID' });
    await writeFile(tracePath, original);
    await writeFile(join(root, records[0]!.path), 'tampered');
    await expect(validateCanonicalTrace(root, 'document-trace.jsonl', 'job:asset:1')).rejects.toMatchObject({ code: 'TRACE_INVALID' });
    await unlink(join(root, records[0]!.path));
    const outside = join(await mkdtemp(join(tmpdir(), 'b15-escape-')), 'outside.bin');
    await writeFile(outside, 'before');
    await symlink(outside, join(root, records[0]!.path));
    await expect(validateCanonicalTrace(root, 'document-trace.jsonl', 'job:asset:1')).rejects.toMatchObject({ code: 'TRACE_INVALID' });
  });

  it('rejects an unsealed profile before opening a working copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b12-unsealed-'));
    const events: string[] = [];
    const backend = createPhotoshopBackend(adapter(events, () => session(events)));
    const unsealed = await request(root);
    unsealed.profile.profileSha256 = '0'.repeat(64);
    unsealed.profile.qualificationId = '';
    await expect(backend.render(unsealed, new AbortController().signal)).rejects.toMatchObject({ code: 'RENDER_REQUEST_INVALID', category: 'validation', retryable: false, evidencePaths: [] });
    expect(events).not.toContain('working-copy');
  });
});
