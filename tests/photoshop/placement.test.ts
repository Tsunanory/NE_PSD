import { describe, expect, it } from 'vitest';
import { PlacementError, placeAndFit, type PlacementAdapter, type TranslationCommand } from '../../packages/photoshop/src/placement.js';
import { buildToolMap, ToolMapError } from '../../packages/photoshop/src/tool-map.js';
import type { FitMode, Rect } from '../../packages/photoshop/src/types.js';

const referenceSelector = { documentRoute: [], layerPath: [{ name: 'Reference', kind: 'pixel' as const, fingerprint: 'ref' }] };
const smartSelector = { documentRoute: [], layerPath: [{ name: 'Target', kind: 'smartObject' as const, fingerprint: 'target' }] };
const pixelSelector = { documentRoute: [], layerPath: [{ name: 'Pixel Target', kind: 'pixel' as const, fingerprint: 'pixel-target' }] };
const approval = (input: string) => ({ approvedInputs: [input] });

type Call = { operation: string; args: Record<string, unknown> };
class Session {
  calls: Call[] = [];
  bounds: Rect = { left: 20, top: 30, right: 220, bottom: 430 };
  referenceBounds: Rect = { left: 100, top: 200, right: 900, bottom: 600 };
  afterScaleBounds: Rect | null = null;
  finalBounds: Rect | null = null;
  translateCount = 0;
  lose: 'place' | 'scale' | 'translate' | null = null;
  selectionFailure = false;
  unexpectedIdentity = false;
  boundsFailure = false;
  pixelTarget = false;
  rounding = false;
  malformedAck: 'void' | 'empty' | 'false' | null = null;
  capability = { liveQualified: true, supportedFitModes: ['cover', 'contain', 'stretch'] as FitMode[], independentAxisScale: false, scaleSemantics: 'uniform-percent' as const, translationSemantics: 'absolute' as const, translationRoundingPx: 0 };
  constructor(initial: Rect = { left: 20, top: 30, right: 220, bottom: 430 }) { this.bounds = { ...initial }; }
  adapter(): PlacementAdapter {
    return {
      capabilities: async () => this.capability,
      resolve: async (selector) => selector === referenceSelector
        ? { documentId: 'doc-1', layerId: 'reference', kind: 'pixel' }
        : selector === pixelSelector || this.pixelTarget
          ? { documentId: 'doc-1', layerId: 'pixel-target', kind: 'pixel' }
          : { documentId: 'doc-1', layerId: 'target', kind: 'smartObject' },
      existingLayerIds: async () => ['target', 'reference', 'unrelated'],
      readEffectiveBounds: async (identity) => {
        this.calls.push({ operation: 'readLayers', args: { ...identity } });
        if (this.boundsFailure) return null;
        return identity.layerId === 'reference' ? this.referenceBounds : this.bounds;
      },
      select: async (identity) => {
        this.calls.push({ operation: 'selectLayer', args: { ...identity } });
        if (this.selectionFailure) throw new PlacementError('SELECTION_FAILED', 'selection failed');
        return { acknowledged: true, ...identity };
      },
      replaceContents: async (identity, input) => {
        this.calls.push({ operation: 'replaceContents', args: { ...identity, input } });
        if (this.lose === 'place') throw Object.assign(new Error('lost acknowledgement'), { code: 'TRANSPORT_AMBIGUOUS' });
        return { acknowledged: true, documentId: identity.documentId, layerId: this.unexpectedIdentity ? 'wrong' : identity.layerId, kind: 'smartObject', bounds: this.bounds };
      },
      place: async (identity, input) => {
        this.calls.push({ operation: 'place', args: { ...identity, input } });
        if (this.lose === 'place') throw Object.assign(new Error('lost acknowledgement'), { code: 'TRANSPORT_AMBIGUOUS' });
        return { acknowledged: true, documentId: this.unexpectedIdentity ? 'wrong-doc' : identity.documentId, layerId: 'placed-1', kind: 'smartObject', bounds: this.bounds };
      },
      scale: async (identity, plan) => {
        this.calls.push({ operation: 'scale', args: { ...identity, ...plan } });
        if (this.afterScaleBounds) this.bounds = { ...this.afterScaleBounds };
        if (this.lose === 'scale') throw Object.assign(new Error('lost acknowledgement'), { code: 'TRANSPORT_AMBIGUOUS' });
        if (this.malformedAck === 'void') return undefined as never;
        if (this.malformedAck === 'empty') return {} as never;
        if (this.malformedAck === 'false') return { acknowledged: false };
        return { acknowledged: true };
      },
      translate: async (identity, command: TranslationCommand) => {
        this.calls.push({ operation: 'translate', args: { ...identity, command } });
        this.translateCount += 1;
        const payload = command.payload;
        const targetX = command.semantics === 'absolute' ? (payload as { x: number }).x : command.semantics === 'absolute-center' ? (payload as { centerX: number }).centerX : (this.bounds.left + this.bounds.right) / 2 + (payload as { dx: number }).dx;
        const targetY = command.semantics === 'absolute' ? (payload as { y: number }).y : command.semantics === 'absolute-center' ? (payload as { centerY: number }).centerY : (this.bounds.top + this.bounds.bottom) / 2 + (payload as { dy: number }).dy;
        const dx = command.compensation ? command.normalized.dx : targetX - (this.bounds.left + this.bounds.right) / 2;
        const dy = command.compensation ? command.normalized.dy : targetY - (this.bounds.top + this.bounds.bottom) / 2;
        this.bounds = { left: this.bounds.left + dx, top: this.bounds.top + dy, right: this.bounds.right + dx, bottom: this.bounds.bottom + dy };
        if (this.finalBounds && this.translateCount === 1) this.bounds = { ...this.finalBounds };
        if (this.lose === 'translate') throw Object.assign(new Error('lost acknowledgement'), { code: 'TRANSPORT_AMBIGUOUS' });
        if (this.malformedAck === 'void') return undefined as never;
        if (this.malformedAck === 'empty') return {} as never;
        if (this.malformedAck === 'false') return { acknowledged: false };
        return { acknowledged: true, rounding: this.rounding };
      },
    };
  }
}

describe('measured Photoshop placement', () => {
  it('uses measured post-place bounds, not 12000x8000 source metadata', async () => {
    const s = new Session({ left: 0, top: 0, right: 600, bottom: 400 }); s.referenceBounds = { left: 0, top: 0, right: 300, bottom: 200 }; s.afterScaleBounds = { left: 0, top: 0, right: 300, bottom: 200 }; s.finalBounds = s.afterScaleBounds;
    const input = '/approved/source.png';
    const result = await placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), sourceMetadata: { width: 12000, height: 8000 }, fitMode: 'cover' });
    expect(result.scale).toEqual({ percentX: 50, percentY: 50 }); expect(s.calls.filter((call) => call.operation === 'scale')).toHaveLength(1);
  });

  it('normalizes the mandated fractional negative cover translation', async () => {
    const s = new Session(); s.afterScaleBounds = { left: -279.75, top: -569.75, right: 520.25, bottom: 1030.25 }; s.finalBounds = { left: 100, top: -400, right: 900, bottom: 1200 }; const input = '/approved/input.png';
    const result = await placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'cover' });
    expect(result.translation).toEqual({ dx: 379.75, dy: 169.75 }); expect(result.checks.every((check) => check.passed)).toBe(true); expect(s.calls.filter((call) => call.operation === 'readLayers').length).toBeGreaterThanOrEqual(3);
    const translate = s.calls.find((call) => call.operation === 'translate')?.args.command as TranslationCommand; expect(translate.normalized).toEqual({ dx: 379.75, dy: 169.75 }); expect(translate.payload).toEqual({ x: 500, y: 400 });
  });

  it.each(['cover', 'contain'] as const)('supports qualified uniform %s', async (fitMode) => {
    const s = new Session(); s.afterScaleBounds = fitMode === 'cover' ? { left: 100, top: -400, right: 900, bottom: 1200 } : { left: 400, top: 200, right: 600, bottom: 600 }; s.finalBounds = s.afterScaleBounds; const input = '/approved/input.png';
    const result = await placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode }); expect(result.fitMode).toBe(fitMode);
  });

  it('supports stretch only with explicit independent scale capability', async () => {
    const s = new Session(); s.capability = { ...s.capability, independentAxisScale: true, scaleSemantics: 'independent-percent' }; s.afterScaleBounds = { left: 100, top: 200, right: 900, bottom: 600 }; s.finalBounds = s.afterScaleBounds; const input = '/approved/input.png';
    const result = await placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'stretch' }); expect(result.fitMode).toBe('stretch');
  });

  it('rejects absent, partial and unsupported capabilities before mutation', async () => {
    const s = new Session(); const input = '/approved/input.png';
    const cases: Array<Session['capability'] | undefined> = [undefined, { ...s.capability, supportedFitModes: [] }, { ...s.capability, translationSemantics: undefined as never }];
    for (const capability of cases) { const current = new Session(); (current as { capability: Session['capability'] | undefined }).capability = capability as Session['capability']; await expect(placeAndFit({ adapter: current.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'cover' })).rejects.toMatchObject({ code: 'CAPABILITY_MISSING' }); expect(current.calls.filter((call) => ['selectLayer', 'place', 'replaceContents', 'scale', 'translate'].includes(call.operation))).toHaveLength(0); }
    const unsupported = new Session(); unsupported.capability = { ...unsupported.capability, supportedFitModes: ['cover', 'contain'] }; await expect(placeAndFit({ adapter: unsupported.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'stretch' })).rejects.toMatchObject({ code: 'FIT_MODE_UNSUPPORTED' });
  });

  it('requires explicit approval and exact input identity before selection', async () => {
    const s = new Session(); await expect(placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input: '/alias/input.png', fitMode: 'cover' })).rejects.toMatchObject({ code: 'APPROVED_INPUT_REQUIRED' }); expect(s.calls).toHaveLength(0);
  });

  it('does not replay a scale after unknown acknowledgement', async () => {
    const s = new Session(); s.lose = 'scale'; s.afterScaleBounds = { left: 100, top: -400, right: 900, bottom: 1200 }; const input = '/approved/input.png';
    await expect(placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'cover' })).rejects.toMatchObject({ code: 'PLACEMENT_UNCERTAIN', restartRequired: true });
    expect(s.calls.filter((call) => call.operation === 'scale')).toHaveLength(1); expect(s.calls.filter((call) => call.operation === 'translate')).toHaveLength(0);
  });

  it('does not replay a translation after unknown acknowledgement', async () => {
    const s = new Session(); s.lose = 'translate'; s.afterScaleBounds = { left: 100, top: -400, right: 900, bottom: 1200 }; const input = '/approved/input.png';
    await expect(placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'cover' })).rejects.toMatchObject({ code: 'PLACEMENT_UNCERTAIN', restartRequired: true });
    expect(s.calls.filter((call) => call.operation === 'scale')).toHaveLength(1); expect(s.calls.filter((call) => call.operation === 'translate')).toHaveLength(1);
  });

  it.each(['void', 'empty', 'false'] as const)('rejects malformed %s mutation acknowledgement', async (malformedAck) => {
    const s = new Session(); s.malformedAck = malformedAck; s.afterScaleBounds = { left: 100, top: -400, right: 900, bottom: 1200 }; const input = '/approved/input.png';
    await expect(placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'cover' })).rejects.toMatchObject({ code: 'PLACEMENT_UNCERTAIN', restartRequired: true });
    expect(s.calls.filter((call) => call.operation === 'scale')).toHaveLength(1);
  });

  it('validates measured post-scale size before translation', async () => {
    for (const wrong of [{ left: 0, top: 0, right: 600, bottom: 400 }, { left: 0, top: 0, right: 300, bottom: 400 }, { left: 0, top: 0, right: 301, bottom: 200 }]) { const s = new Session({ left: 0, top: 0, right: 600, bottom: 400 }); s.referenceBounds = { left: 0, top: 0, right: 300, bottom: 200 }; s.afterScaleBounds = wrong; const input = '/approved/input.png'; await expect(placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'cover' })).rejects.toMatchObject({ code: 'SIZE_ERROR_UNEXPLAINED', restartRequired: true }); expect(s.calls.filter((call) => call.operation === 'translate')).toHaveLength(0); }
  });

  it('accepts a new pixel-target place identity and rejects wrong identity or kind', async () => {
    const s = new Session(); s.pixelTarget = true; const input = '/approved/input.png'; s.afterScaleBounds = { left: 100, top: -400, right: 900, bottom: 1200 }; s.finalBounds = s.afterScaleBounds;
    const result = await placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: pixelSelector, input, ...approval(input), expectedPlacedKind: 'smartObject', fitMode: 'cover' }); expect(result.layerId).toBe('placed-1'); expect(result.evidence.find((row) => row.operation === 'place')?.layerId).toBe('placed-1');
    const wrong = new Session(); wrong.pixelTarget = true; wrong.unexpectedIdentity = true; await expect(placeAndFit({ adapter: wrong.adapter(), reference: referenceSelector, target: pixelSelector, input, ...approval(input), fitMode: 'cover' })).rejects.toMatchObject({ code: 'UNEXPECTED_IDENTITY' });
  });

  it('allows exactly one acknowledged rounding correction with compensated command', async () => {
    const s = new Session(); s.afterScaleBounds = { left: -279.75, top: -569.75, right: 520.25, bottom: 1030.25 }; s.finalBounds = { left: 100.6, top: -399.4, right: 900.6, bottom: 1200.6 }; s.rounding = true; s.capability.translationRoundingPx = 1; const input = '/approved/input.png';
    const result = await placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'cover' }); expect(result.checks.every((check) => check.passed)).toBe(true); const calls = s.calls.filter((call) => call.operation === 'translate'); expect(calls).toHaveLength(2); expect(calls[0]?.args.command).not.toEqual(calls[1]?.args.command);
  });

  it('records fitMode and acknowledgement outcome only for issued operations', async () => {
    const s = new Session(); s.afterScaleBounds = { left: -279.75, top: -569.75, right: 520.25, bottom: 1030.25 }; s.lose = 'scale'; const input = '/approved/input.png';
    await expect(placeAndFit({ adapter: s.adapter(), reference: referenceSelector, target: smartSelector, input, ...approval(input), fitMode: 'cover' })).rejects.toMatchObject({ code: 'PLACEMENT_UNCERTAIN' });
  });

  it('rejects conflicting or semantically incompatible live tool bindings', () => {
    const inputSchema = { type: 'object', properties: { percent: { type: 'number' } }, required: ['percent'], additionalProperties: false };
    const tool = { name: 'qualified-scale', inputSchema };
    const binding = { operation: 'scale' as const, toolName: tool.name, inputSchema, semantics: { scale: 'uniform-percent' as const }, evidence: 'live-qualified' as const };
    expect(buildToolMap([tool], [binding]).get('scale')?.liveQualified).toBe(true);
    expect(() => buildToolMap([tool], [binding, binding])).toThrowError(ToolMapError);
    expect(() => buildToolMap([tool], [{ ...binding, semantics: { scale: 'independent-percent' as const } }])).toThrowError(ToolMapError);
  });
});
