import { describe, expect, it } from 'vitest';
import { ensureClipping, QualificationError, type ClippingRelation } from '../../packages/photoshop/src/qualification.js';

const base = (): ClippingRelation => ({ inputId: 'input', referenceId: 'reference', parentId: 'parent', inputIndex: 0, referenceIndex: 1, clipped: true, baseId: 'reference', kind: 'smartObject', mask: { alpha: 'holes' }, effects: { shadow: true }, maskSemantics: 'alpha', layerCount: 2 });

describe('qualified clipping preparation', () => {
  it('does not toggle an already-correct prepared relation', async () => {
    const relation = base(); let reads = 0; let sets = 0; const result = await ensureClipping({ inspectClipping: async () => { reads += 1; return relation; }, setClipping: async () => { sets += 1; return { acknowledged: true }; } }, 'input', 'reference');
    expect(result).toEqual({ clipped: true, adjacentToReference: true }); const second = await ensureClipping({ inspectClipping: async () => { reads += 1; return relation; }, setClipping: async () => { sets += 1; return { acknowledged: true }; } }, 'input', 'reference'); expect(second).toEqual({ clipped: true, adjacentToReference: true }); expect(reads).toBe(2); expect(sets).toBe(0);
  });

  it('prepares a pixel input exactly once and preserves mask/effects', async () => {
    const relation = base(); relation.kind = 'pixel'; relation.requiresPreparation = true; relation.clipped = false; relation.baseId = null; relation.inputIndex = 2; relation.referenceIndex = 3; let prepares = 0; let sets = 0;
    const result = await ensureClipping({ inspectClipping: async () => ({ ...relation }), preparePixelInput: async () => { prepares += 1; return { acknowledged: true }; }, setClipping: async () => { sets += 1; relation.clipped = true; relation.baseId = 'reference'; return { acknowledged: true }; } }, 'input', 'reference');
    expect(result.prepared).toBe(true); expect(prepares).toBe(1); expect(sets).toBe(1);
  });

  it('moves an intervening layer before setting clipping', async () => {
    const relation = base(); relation.inputIndex = 2; relation.referenceIndex = 4; relation.clipped = false; relation.baseId = null; const operations: string[] = [];
    await ensureClipping({ inspectClipping: async () => ({ ...relation }), moveAbove: async () => { operations.push('move'); relation.inputIndex = 3; return { acknowledged: true }; }, setClipping: async () => { operations.push('clip'); relation.clipped = true; relation.baseId = 'reference'; return { acknowledged: true }; } }, 'input', 'reference');
    expect(operations).toEqual(['move', 'clip']);
  });

  it('fails closed on a wrong base, unknown mask semantics, and accumulation', async () => {
    const wrong = base(); wrong.baseId = 'other'; await expect(ensureClipping({ inspectClipping: async () => wrong }, 'input', 'reference')).rejects.toMatchObject({ code: 'CLIPPING_WRONG_BASE' });
    const unknown = base(); unknown.clipped = false; unknown.maskSemantics = 'unknown'; await expect(ensureClipping({ inspectClipping: async () => unknown, setClipping: async () => ({ acknowledged: true }) }, 'input', 'reference')).rejects.toMatchObject({ code: 'CLIPPING_MASK_UNPROVEN' });
    const accumulating = base(); accumulating.clipped = false; accumulating.layerCount = 2; let mutated = false; await expect(ensureClipping({ inspectClipping: async () => ({ ...accumulating, clipped: mutated, baseId: mutated ? 'reference' : null, layerCount: mutated ? 3 : 2 }), setClipping: async () => { mutated = true; return { acknowledged: true }; } }, 'input', 'reference')).rejects.toMatchObject({ code: 'CLIPPING_LAYER_ACCUMULATION' });
    await expect(ensureClipping({ inspectClipping: async () => ({ ...accumulating, clipped: false, baseId: null }), setClipping: async () => undefined }, 'input', 'reference')).rejects.toMatchObject({ code: 'SETCLIPPING_UNCERTAIN' });
  });

  it('retains vector-mask semantics and rejects unproven vector holes', async () => {
    const relation = base(); relation.kind = 'shape'; relation.clipped = false; relation.maskSemantics = 'vector'; relation.mask = { holes: [[0, 0], [10, 10]] }; relation.baseId = null;
    await expect(ensureClipping({ inspectClipping: async () => ({ ...relation, clipped: true, baseId: 'reference' }) }, 'input', 'reference')).resolves.toEqual({ clipped: true, adjacentToReference: true });
    const unproven = { ...relation, maskSemantics: 'unknown' as const }; await expect(ensureClipping({ inspectClipping: async () => unproven }, 'input', 'reference')).rejects.toMatchObject({ code: 'CLIPPING_MASK_UNPROVEN' });
  });
});
