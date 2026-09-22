import type { FitMode, Rect, ScalePlan, Translation } from './types.js';

export type FitCheckName = 'dimensions' | 'aspectRatio' | 'containment' | 'stretchEdges' | 'centered';

export type FitCheck = {
  id: FitCheckName;
  name: FitCheckName;
  passed: boolean;
};

const DEFAULT_TOLERANCE_PX = 0.5;
const FIT_MODES: readonly FitMode[] = ['cover', 'contain', 'stretch'];

function assertMode(mode: FitMode): asserts mode is FitMode {
  if (!FIT_MODES.includes(mode)) {
    throw new RangeError(`unsupported fit mode: ${String(mode)}`);
  }
}

function assertFiniteCoordinate(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

function positiveDifference(end: number, start: number, name: string): number {
  assertFiniteCoordinate(end, `${name}.end`);
  assertFiniteCoordinate(start, `${name}.start`);
  const value = end - start;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and strictly positive`);
  }
  return value;
}

function assertRect(rect: Rect, name: string): { width: number; height: number } {
  if (rect === null || typeof rect !== 'object') {
    throw new TypeError(`${name} must be a rectangle`);
  }
  assertFiniteCoordinate(rect.left, `${name}.left`);
  assertFiniteCoordinate(rect.top, `${name}.top`);
  assertFiniteCoordinate(rect.right, `${name}.right`);
  assertFiniteCoordinate(rect.bottom, `${name}.bottom`);
  return {
    width: positiveDifference(rect.right, rect.left, `${name}.width`),
    height: positiveDifference(rect.bottom, rect.top, `${name}.height`),
  };
}

function assertTolerance(tolerancePx: number): void {
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0) {
    throw new RangeError('tolerancePx must be finite and greater than or equal to zero');
  }
}

function finitePositiveProduct(value: number, multiplier: number, name: string): number {
  const result = value * multiplier;
  if (!Number.isFinite(result) || result <= 0) {
    throw new RangeError(`${name} must be finite and strictly positive`);
  }
  return result;
}

function midpoint(start: number, end: number, name: string): number {
  const width = positiveDifference(end, start, `${name}.width`);
  const result = start + width / 2;
  if (!Number.isFinite(result)) {
    throw new RangeError(`${name} midpoint must be finite`);
  }
  return result;
}

function differenceWithin(actual: number, expected: number, tolerancePx: number): boolean {
  const difference = actual - expected;
  if (!Number.isFinite(difference)) {
    return false;
  }
  return Math.abs(difference) <= tolerancePx;
}

function lessThanOrEqualWithTolerance(actual: number, expected: number, tolerancePx: number): boolean {
  const difference = actual - expected;
  if (difference === Number.NEGATIVE_INFINITY) {
    return true;
  }
  if (!Number.isFinite(difference)) {
    return false;
  }
  return difference <= tolerancePx;
}

function scaledDimension(base: number, target: number, source: number): number {
  const ratio = target / source;
  const direct = base * ratio;
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  // Recompute through logarithms only when direct arithmetic underflows or
  // overflows. This preserves a finite result without accepting an overflow.
  const logResult = Math.log(base) + Math.log(target) - Math.log(source);
  if (!Number.isFinite(logResult) || logResult > Math.log(Number.MAX_VALUE)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.exp(logResult);
}

function pixelResidualWithin(actual: number, expected: number, tolerancePx: number): boolean {
  if (!Number.isFinite(expected)) {
    return false;
  }
  const residual = actual - expected;
  return Number.isFinite(residual) && Math.abs(residual) <= tolerancePx;
}

function aspectRatioPreserved(
  originalWidth: number,
  originalHeight: number,
  finalWidth: number,
  finalHeight: number,
  tolerancePx: number,
): boolean {
  // Check both axes against a single uniform scale. Residuals stay in final
  // Photoshop pixels; no percentage tolerance is substituted.
  const expectedHeight = scaledDimension(originalHeight, finalWidth, originalWidth);
  const expectedWidth = scaledDimension(originalWidth, finalHeight, originalHeight);
  return pixelResidualWithin(finalHeight, expectedHeight, tolerancePx)
    && pixelResidualWithin(finalWidth, expectedWidth, tolerancePx);
}

export function scaleFor(reference: Rect, measuredPlaced: Rect, mode: FitMode): ScalePlan {
  assertMode(mode);
  const referenceSize = assertRect(reference, 'reference');
  const placedSize = assertRect(measuredPlaced, 'measuredPlaced');
  const scaleX = referenceSize.width / placedSize.width;
  const scaleY = referenceSize.height / placedSize.height;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    throw new RangeError('derived scale must be finite and strictly positive');
  }

  if (mode === 'stretch') {
    return {
      percentX: finitePositiveProduct(scaleX, 100, 'percentX'),
      percentY: finitePositiveProduct(scaleY, 100, 'percentY'),
    };
  }

  const scale = mode === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError('derived uniform scale must be finite and strictly positive');
  }
  const percent = finitePositiveProduct(scale, 100, 'percent');
  return { percentX: percent, percentY: percent };
}

export function centerTranslation(reference: Rect, afterScale: Rect): Translation {
  assertRect(reference, 'reference');
  assertRect(afterScale, 'afterScale');
  const referenceCenterX = midpoint(reference.left, reference.right, 'reference.x');
  const referenceCenterY = midpoint(reference.top, reference.bottom, 'reference.y');
  const placedCenterX = midpoint(afterScale.left, afterScale.right, 'afterScale.x');
  const placedCenterY = midpoint(afterScale.top, afterScale.bottom, 'afterScale.y');
  const dx = referenceCenterX - placedCenterX;
  const dy = referenceCenterY - placedCenterY;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new RangeError('derived translation must be finite');
  }
  return { dx, dy };
}

export function checkFit(
  reference: Rect,
  finalPlaced: Rect,
  originalPlaced: Rect,
  mode: FitMode,
  tolerancePx = DEFAULT_TOLERANCE_PX,
): FitCheck[] {
  assertMode(mode);
  assertTolerance(tolerancePx);
  const referenceSize = assertRect(reference, 'reference');
  const finalSize = assertRect(finalPlaced, 'finalPlaced');
  const originalSize = assertRect(originalPlaced, 'originalPlaced');
  const centered = centerTranslation(reference, finalPlaced);
  const checks: FitCheck[] = [{
    id: 'dimensions',
    name: 'dimensions',
    passed: Number.isFinite(finalSize.width)
      && Number.isFinite(finalSize.height)
      && finalSize.width > 0
      && finalSize.height > 0,
  }];

  if (mode !== 'stretch') {
    checks.push({
      id: 'aspectRatio',
      name: 'aspectRatio',
      passed: aspectRatioPreserved(
        originalSize.width,
        originalSize.height,
        finalSize.width,
        finalSize.height,
        tolerancePx,
      ),
    });
  }

  if (mode === 'stretch') {
    checks.push({
      id: 'stretchEdges',
      name: 'stretchEdges',
      passed: [
        differenceWithin(finalPlaced.left, reference.left, tolerancePx),
        differenceWithin(finalPlaced.top, reference.top, tolerancePx),
        differenceWithin(finalPlaced.right, reference.right, tolerancePx),
        differenceWithin(finalPlaced.bottom, reference.bottom, tolerancePx),
      ].every(Boolean),
    });
  } else {
    const contains = mode === 'cover'
      ? [
        lessThanOrEqualWithTolerance(finalPlaced.left, reference.left, tolerancePx),
        lessThanOrEqualWithTolerance(reference.right, finalPlaced.right, tolerancePx),
        lessThanOrEqualWithTolerance(finalPlaced.top, reference.top, tolerancePx),
        lessThanOrEqualWithTolerance(reference.bottom, finalPlaced.bottom, tolerancePx),
      ]
      : [
        lessThanOrEqualWithTolerance(reference.left, finalPlaced.left, tolerancePx),
        lessThanOrEqualWithTolerance(finalPlaced.right, reference.right, tolerancePx),
        lessThanOrEqualWithTolerance(reference.top, finalPlaced.top, tolerancePx),
        lessThanOrEqualWithTolerance(finalPlaced.bottom, reference.bottom, tolerancePx),
      ];
    checks.push({ id: 'containment', name: 'containment', passed: contains.every(Boolean) });
  }

  checks.push({
    id: 'centered',
    name: 'centered',
    passed: differenceWithin(centered.dx, 0, tolerancePx)
      && differenceWithin(centered.dy, 0, tolerancePx),
  });
  return checks;
}

export { DEFAULT_TOLERANCE_PX };
