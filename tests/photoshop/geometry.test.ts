import { describe, expect, it } from 'vitest';
import { checkFit, centerTranslation, scaleFor } from '../../packages/photoshop/src/geometry.js';
import type { FitMode, Rect } from '../../packages/photoshop/src/types.js';

const reference: Rect = { left: 100, top: 200, right: 900, bottom: 600 };
const placed: Rect = { left: 20, top: 30, right: 220, bottom: 430 };

function expectAllPassed(checks: ReturnType<typeof checkFit>): void {
  expect(checks.every((check) => check.passed)).toBe(true);
}

describe('measured geometry', () => {
  it('uses measured placed bounds for the mandated numeric examples', () => {
    expect(scaleFor(reference, placed, 'cover')).toEqual({ percentX: 400, percentY: 400 });
    expect(scaleFor(reference, placed, 'contain')).toEqual({ percentX: 100, percentY: 100 });
    expect(scaleFor(reference, placed, 'stretch')).toEqual({ percentX: 400, percentY: 100 });
    expect(centerTranslation(reference, { left: -280, top: -570, right: 520, bottom: 1030 }))
      .toEqual({ dx: 380, dy: 170 });
  });

  it('proves each fit mode after measured scaling and centering', () => {
    const scaled = {
      cover: { left: 100, top: -400, right: 900, bottom: 1200 },
      contain: { left: 400, top: 200, right: 600, bottom: 600 },
      stretch: reference,
    } satisfies Record<FitMode, Rect>;

    for (const mode of ['cover', 'contain', 'stretch'] as const) {
      expectAllPassed(checkFit(reference, scaled[mode], placed, mode));
    }
  });

  it('handles non-origin, negative, fractional, portrait, landscape and square rectangles', () => {
    const cases: Array<{ reference: Rect; placed: Rect; expected: ReturnType<typeof scaleFor> }> = [
      {
        reference: { left: -12.5, top: 3.25, right: 7.5, bottom: 43.25 },
        placed: { left: -5.25, top: 8.25, right: 4.75, bottom: 18.25 },
        expected: { percentX: 400, percentY: 400 },
      },
      {
        reference: { left: 10, top: -50, right: 410, bottom: 50 },
        placed: { left: 0, top: 0, right: 100, bottom: 200 },
        expected: { percentX: 400, percentY: 400 },
      },
      {
        reference: { left: -100, top: -100, right: 0, bottom: 300 },
        placed: { left: 10, top: 20, right: 210, bottom: 120 },
        expected: { percentX: 400, percentY: 400 },
      },
      {
        reference: { left: 0.5, top: 0.5, right: 1.5, bottom: 1.5 },
        placed: { left: -1.5, top: -1.5, right: -0.5, bottom: -0.5 },
        expected: { percentX: 100, percentY: 100 },
      },
      {
        reference: { left: 2, top: 4, right: 3, bottom: 5 },
        placed: { left: 0, top: 0, right: 1, bottom: 1 },
        expected: { percentX: 100, percentY: 100 },
      },
    ];

    for (const testCase of cases) {
      expect(scaleFor(testCase.reference, testCase.placed, 'cover')).toEqual(testCase.expected);
    }
  });

  it('accepts one-pixel dimensions', () => {
    expect(scaleFor(
      { left: -2, top: 3, right: -1, bottom: 4 },
      { left: 10, top: 10, right: 11, bottom: 11 },
      'cover',
    )).toEqual({ percentX: 100, percentY: 100 });
  });

  it('uses measured post-placement bounds rather than source metadata', () => {
    const sourceMetadata = { width: 12000, height: 8000 };
    expect(sourceMetadata).toEqual({ width: 12000, height: 8000 });
    expect(scaleFor(
      { left: 0, top: 0, right: 300, bottom: 200 },
      { left: 0, top: 0, right: 600, bottom: 400 },
      'cover',
    )).toEqual({ percentX: 50, percentY: 50 });
  });

  it('supports fixed-seed generated positive rectangles in every mode', () => {
    let seed = 0x12345678;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let index = 0; index < 100; index += 1) {
      const left = next() * 2000 - 1000;
      const top = next() * 2000 - 1000;
      const width = next() * 999 + 1;
      const height = next() * 999 + 1;
      const referenceRect = { left, top, right: left + width, bottom: top + height };
      const placedLeft = next() * 2000 - 1000;
      const placedTop = next() * 2000 - 1000;
      const placedWidth = next() * 999 + 1;
      const placedHeight = next() * 999 + 1;
      const placedRect = {
        left: placedLeft,
        top: placedTop,
        right: placedLeft + placedWidth,
        bottom: placedTop + placedHeight,
      };

      for (const mode of ['cover', 'contain', 'stretch'] as const) {
        const plan = scaleFor(referenceRect, placedRect, mode);
        expect(Number.isFinite(plan.percentX)).toBe(true);
        expect(Number.isFinite(plan.percentY)).toBe(true);
        const scaleX = plan.percentX / 100;
        const scaleY = plan.percentY / 100;
        const finalWidth = placedWidth * scaleX;
        const finalHeight = placedHeight * scaleY;
        const centerX = (referenceRect.left + referenceRect.right) / 2;
        const centerY = (referenceRect.top + referenceRect.bottom) / 2;
        const finalRect = {
          left: centerX - finalWidth / 2,
          top: centerY - finalHeight / 2,
          right: centerX + finalWidth / 2,
          bottom: centerY + finalHeight / 2,
        };
        expectAllPassed(checkFit(referenceRect, finalRect, placedRect, mode));
      }
    }
  });

  it('rejects zero, negative, non-finite, unsupported and numerically overflowing rectangles', () => {
    const invalidRectangles: Rect[] = [
      { left: 0, top: 0, right: 0, bottom: 1 },
      { left: 0, top: 0, right: -1, bottom: 1 },
      { left: Number.NaN, top: 0, right: 1, bottom: 1 },
      { left: 0, top: Number.POSITIVE_INFINITY, right: 1, bottom: 2 },
      { left: Number.MAX_VALUE, top: 0, right: -Number.MAX_VALUE, bottom: 1 },
    ];

    for (const invalid of invalidRectangles) {
      expect(() => scaleFor(invalid, placed, 'cover')).toThrow();
      expect(() => centerTranslation(invalid, placed)).toThrow();
    }

    expect(() => scaleFor(reference, placed, 'invalid' as FitMode)).toThrow();
    expect(() => checkFit(reference, reference, placed, 'cover', -0.01)).toThrow();
    expect(() => checkFit(reference, reference, placed, 'cover', Number.NaN)).toThrow();
    expect(() => checkFit(reference, reference, placed, 'cover', Number.POSITIVE_INFINITY)).toThrow();
  });

  it('does not mutate any input rectangle', () => {
    const beforeReference = structuredClone(reference);
    const beforePlaced = structuredClone(placed);
    scaleFor(reference, placed, 'cover');
    centerTranslation(reference, placed);
    checkFit(reference, reference, placed, 'stretch');
    expect(reference).toEqual(beforeReference);
    expect(placed).toEqual(beforePlaced);
  });

  it('returns deterministic named checks with inclusive tolerance boundaries', () => {
    const finalPlaced = { left: 100.5, top: 200, right: 900.5, bottom: 600 };
    const checks = checkFit(reference, finalPlaced, placed, 'stretch', 0.5);
    expect(checks.map((check) => check.name)).toEqual([
      'dimensions',
      'stretchEdges',
      'centered',
    ]);
    expect(checks.every((check) => check.passed)).toBe(true);
    expect(checkFit(reference, { ...finalPlaced, right: 900.500001 }, placed, 'stretch', 0.5)
      .find((check) => check.name === 'stretchEdges')?.passed).toBe(false);
  });

  it('uses final-pixel residuals for uniform aspect checks at large scales', () => {
    const unitPlaced: Rect = { left: 0, top: 0, right: 1, bottom: 1 };
    const exactlyAtTolerance: Rect = { left: 0, top: 0, right: 1_000_000, bottom: 1_000_000.5 };
    const justOverTolerance: Rect = { left: 0, top: 0, right: 1_000_000, bottom: 1_000_000.500001 };
    expect(checkFit(exactlyAtTolerance, exactlyAtTolerance, unitPlaced, 'cover', 0.5)
      .find((check) => check.name === 'aspectRatio')?.passed).toBe(true);
    expect(checkFit(exactlyAtTolerance, justOverTolerance, unitPlaced, 'cover', 0.5)
      .find((check) => check.name === 'aspectRatio')?.passed).toBe(false);

    const downscaleOriginal: Rect = { left: 0, top: 0, right: 1_000_000, bottom: 1_000_000 };
    const downscaleExact: Rect = { left: 0, top: 0, right: 1, bottom: 1.5 };
    const downscaleOver: Rect = { left: 0, top: 0, right: 1, bottom: 1.500001 };
    expect(checkFit(downscaleOriginal, downscaleExact, downscaleOriginal, 'cover', 0.5)
      .find((check) => check.name === 'aspectRatio')?.passed).toBe(true);
    expect(checkFit(downscaleOriginal, downscaleOver, downscaleOriginal, 'cover', 0.5)
      .find((check) => check.name === 'aspectRatio')?.passed).toBe(false);
  });

  it('accepts extreme finite and tiny positive dimensions without ratio-tolerance overflow', () => {
    const extreme: Rect = {
      left: -Number.MAX_VALUE / 2,
      top: -Number.MAX_VALUE / 4,
      right: Number.MAX_VALUE / 2,
      bottom: Number.MAX_VALUE / 4,
    };
    expect(scaleFor(extreme, extreme, 'cover')).toEqual({ percentX: 100, percentY: 100 });
    expectAllPassed(checkFit(extreme, extreme, extreme, 'cover'));

    const tiny: Rect = { left: 0, top: 0, right: Number.MIN_VALUE, bottom: Number.MIN_VALUE };
    expect(scaleFor(tiny, tiny, 'contain')).toEqual({ percentX: 100, percentY: 100 });
    expectAllPassed(checkFit(tiny, tiny, tiny, 'contain'));
  });

  it('checks aspect-ratio drift, containment and centering independently', () => {
    const containmentAndCenteringPassAspectFails = checkFit(
      reference,
      { left: 100, top: -400.5, right: 900, bottom: 1200.5 },
      placed,
      'cover',
    );
    expect(containmentAndCenteringPassAspectFails.find((check) => check.name === 'containment')?.passed)
      .toBe(true);
    expect(containmentAndCenteringPassAspectFails.find((check) => check.name === 'centered')?.passed)
      .toBe(true);
    expect(containmentAndCenteringPassAspectFails.find((check) => check.name === 'aspectRatio')?.passed)
      .toBe(false);

    const aspectPassContainmentAndCenteringFail = checkFit(
      reference,
      { left: 101, top: -400, right: 901, bottom: 1200 },
      placed,
      'cover',
    );
    expect(aspectPassContainmentAndCenteringFail.find((check) => check.name === 'aspectRatio')?.passed)
      .toBe(true);
    expect(aspectPassContainmentAndCenteringFail.find((check) => check.name === 'containment')?.passed)
      .toBe(false);
    expect(aspectPassContainmentAndCenteringFail.find((check) => check.name === 'centered')?.passed)
      .toBe(false);

    expect(checkFit(reference, { left: 99, top: 200, right: 901, bottom: 600 }, placed, 'contain')
      .find((check) => check.name === 'containment')?.passed).toBe(false);
    expect(checkFit(reference, { left: 300, top: 200, right: 700, bottom: 600 }, placed, 'cover')
      .find((check) => check.name === 'containment')?.passed).toBe(false);
    expect(checkFit(reference, { left: 101, top: 200, right: 901, bottom: 600 }, placed, 'stretch')
      .find((check) => check.name === 'centered')?.passed).toBe(false);
  });

  it('rejects invalid final or original measured bounds in checkFit', () => {
    expect(() => checkFit(reference, { left: 0, top: 0, right: 0, bottom: 1 }, placed, 'cover')).toThrow();
    expect(() => checkFit(reference, reference, { left: 0, top: 0, right: 0, bottom: 1 }, 'cover')).toThrow();
  });
});
