import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { RenderRequestSchema } from '@ne-psd/contracts';
import { createPhotoshopBackend, type BackendAdapter, type RenderSession } from '../../packages/photoshop/src/backend.js';

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

function session(events: string[], failVariant?: string): RenderSession {
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
    openRoot: async () => { events.push('open-root'); },
    verifyGraph: async () => { events.push('verify-graph'); },
    renderResource: async () => { events.push('render-resource'); return { target, reference, placed: reference, fitMode: 'cover', clipped: true, adjacentToReference: true }; },
    verifyPropagation: async () => { events.push('verify-propagation'); },
    verifyOriginals: async () => { events.push('verify-originals'); return true; },
    discard: async () => { events.push('discard'); },
  };
}

function adapter(events: string[], makeSession: () => RenderSession): BackendAdapter {
  return {
    lock: { runExclusive: async (_id, fn) => fn() },
    capabilities: async () => capability,
    inspect: async () => { throw new Error('not used'); },
    createWorkingCopy: async () => { events.push('working-copy'); return makeSession(); },
  };
}

describe('B12 PhotoshopBackend transaction boundary', () => {
  it('isolates, renders and discards each asset transaction before returning strict evidence', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'b12-first-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'b12-second-'));
    const events: string[] = [];
    const backend = createPhotoshopBackend(adapter(events, () => session(events)));
    const first = await backend.render(await request(firstRoot), new AbortController().signal);
    const second = await backend.render(await request(secondRoot), new AbortController().signal);
    expect(first.artifacts).toHaveLength(3);
    expect(second.artifacts).toHaveLength(3);
    expect(events.filter((event) => event === 'working-copy')).toHaveLength(2);
    expect(events.indexOf('discard')).toBeLessThan(events.lastIndexOf('working-copy'));
    expect(events).toContain('verify-originals');
  });

  it('does not return evidence after a variant failure and still discards the owned copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b12-failure-'));
    const events: string[] = [];
    const backend = createPhotoshopBackend(adapter(events, () => session(events, '2')));
    await expect(backend.render(await request(root), new AbortController().signal)).rejects.toMatchObject({ code: 'EXPORT_UNACKNOWLEDGED' });
    expect(events).toContain('discard');
    expect(events).not.toContain('verify-originals');
  });
});
