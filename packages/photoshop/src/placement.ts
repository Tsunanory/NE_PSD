import type { FitMode, LayerSelector, Rect, ScalePlan } from './types.js';
import { checkFit, centerTranslation, scaleFor, type FitCheck } from './geometry.js';

export type PlacementIdentity = {
  documentId: string;
  layerId: string;
  kind?: 'group' | 'smartObject' | 'pixel' | 'shape';
};

export type PlacementObservation = PlacementIdentity & { bounds: Rect | null | undefined };
export type AbsoluteCenter = { x: number; y: number };
export type PlacementCapabilities = {
  liveQualified: boolean;
  supportedFitModes: readonly FitMode[];
  independentAxisScale: boolean;
  scaleSemantics: 'uniform-percent' | 'independent-percent';
  translationSemantics: 'absolute' | 'absolute-center' | 'delta';
  translationRoundingPx: number;
};
export type PlacementAcknowledgement = {
  acknowledged: boolean;
  rounding?: boolean;
  roundingPx?: number;
};
export type TranslationCommand = {
  semantics: PlacementCapabilities['translationSemantics'];
  normalized: { dx: number; dy: number };
  payload: AbsoluteCenter | { centerX: number; centerY: number } | { dx: number; dy: number };
  compensation?: { dx: number; dy: number };
};

/** Only qualified, semantic primitives are accepted by the placement algorithm. */
export type PlacementAdapter = {
  capabilities?: () => Promise<PlacementCapabilities> | PlacementCapabilities;
  resolve: (selector: LayerSelector) => Promise<PlacementIdentity>;
  existingLayerIds?: (documentId: string) => Promise<readonly string[]>;
  readEffectiveBounds: (identity: PlacementIdentity) => Promise<PlacementObservation | Rect | null | undefined>;
  select?: (identity: PlacementIdentity) => Promise<PlacementAcknowledgement | PlacementIdentity | void>;
  place?: (identity: PlacementIdentity, approvedInput: string) => Promise<PlacementObservation | (PlacementAcknowledgement & PlacementIdentity)>;
  replaceContents?: (identity: PlacementIdentity, approvedInput: string) => Promise<PlacementObservation | (PlacementAcknowledgement & PlacementIdentity)>;
  scale: (identity: PlacementIdentity, plan: ScalePlan) => Promise<PlacementAcknowledgement | void>;
  translate: (identity: PlacementIdentity, command: TranslationCommand) => Promise<PlacementAcknowledgement | void>;
};

export type PlacementRequest = {
  adapter: PlacementAdapter;
  reference: LayerSelector;
  target: LayerSelector;
  input: string;
  fitMode: FitMode;
  tolerancePx?: number;
  signal?: AbortSignal;
  approvedInputs?: readonly string[];
  approveInput?: (input: string) => boolean | Promise<boolean>;
  expectedPlacedKind?: PlacementIdentity['kind'];
  /** Metadata is deliberately accepted only as evidence input; geometry never reads it. */
  sourceMetadata?: { width: number; height: number };
};

export type PlacementEvidenceRow = {
  operation: 'resolve' | 'readLayers' | 'selectLayer' | 'place' | 'replaceContents' | 'scale' | 'translate';
  fitMode: FitMode;
  documentId?: string;
  layerId?: string;
  bounds?: Rect;
  scale?: ScalePlan;
  normalized?: { dx: number; dy: number };
  acknowledgement?: 'acknowledged' | 'unknown' | 'failed-safe';
  payload?: unknown;
};

export type PlacementResult = {
  documentId: string;
  layerId: string;
  fitMode: FitMode;
  scale: ScalePlan;
  translation: { dx: number; dy: number };
  originalPlaced: Rect;
  afterScale: Rect;
  finalPlaced: Rect;
  checks: FitCheck[];
  evidence: PlacementEvidenceRow[];
};

export type PlacementErrorCode =
  | 'FIT_MODE_UNSUPPORTED'
  | 'CAPABILITY_MISSING'
  | 'APPROVED_INPUT_REQUIRED'
  | 'EFFECTIVE_BOUNDS_UNKNOWN'
  | 'INVALID_EFFECTIVE_BOUNDS'
  | 'SELECTION_FAILED'
  | 'UNEXPECTED_IDENTITY'
  | 'PLACEMENT_UNCERTAIN'
  | 'SIZE_ERROR_UNEXPLAINED'
  | 'FIT_VALIDATION_FAILED'
  | 'CANCELLED';

export class PlacementError extends Error {
  readonly code: PlacementErrorCode;
  readonly restartRequired: boolean;
  readonly outcome: 'failed-safe' | 'uncertain' | 'blocked' | 'cancelled';
  constructor(code: PlacementErrorCode, message: string, options: { restartRequired?: boolean; outcome?: PlacementError['outcome'] } = {}) {
    super(message);
    this.name = 'PlacementError';
    this.code = code;
    this.restartRequired = options.restartRequired ?? false;
    this.outcome = options.outcome ?? (code === 'PLACEMENT_UNCERTAIN' ? 'uncertain' : code === 'CANCELLED' ? 'cancelled' : 'failed-safe');
  }
}

const MODES: readonly FitMode[] = ['cover', 'contain', 'stretch'];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PlacementError('CANCELLED', 'placement cancelled before the next mutation', { outcome: 'cancelled' });
}

function ensureRect(value: Rect | null | undefined, code: PlacementErrorCode, name: string): Rect {
  if (!value || !isFiniteNumber(value.left) || !isFiniteNumber(value.top) || !isFiniteNumber(value.right) || !isFiniteNumber(value.bottom)) {
    throw new PlacementError(code, `${name} effective bounds are missing or non-finite`);
  }
  if (value.right <= value.left || value.bottom <= value.top) throw new PlacementError(code, `${name} effective bounds are empty`);
  return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
}

function sameIdentity(actual: PlacementIdentity, expected: PlacementIdentity): boolean {
  return actual.documentId === expected.documentId && actual.layerId === expected.layerId;
}

function observation(value: PlacementObservation | Rect | null | undefined, expected: PlacementIdentity, name: string): Rect {
  if (isRecord(value) && 'bounds' in value) {
    const identity = value as Partial<PlacementObservation>;
    if ((identity.documentId !== undefined || identity.layerId !== undefined)
      && (identity.documentId !== expected.documentId || identity.layerId !== expected.layerId)) {
      throw new PlacementError('UNEXPECTED_IDENTITY', `${name} returned an unexpected document or layer identity`);
    }
    return ensureRect(identity.bounds, 'EFFECTIVE_BOUNDS_UNKNOWN', name);
  }
  return ensureRect(value as Rect | null | undefined, 'EFFECTIVE_BOUNDS_UNKNOWN', name);
}

function parseIdentity(value: unknown): PlacementIdentity {
  if (!isRecord(value) || typeof value.documentId !== 'string' || typeof value.layerId !== 'string') {
    throw new PlacementError('UNEXPECTED_IDENTITY', 'placement did not return the actual document and layer identity');
  }
  const kind = value.kind;
  const actual: PlacementIdentity = kind === 'group' || kind === 'pixel' || kind === 'shape' || kind === 'smartObject'
    ? { documentId: value.documentId, layerId: value.layerId, kind }
    : { documentId: value.documentId, layerId: value.layerId };
  return actual;
}

function returnedIdentity(value: unknown, expected: PlacementIdentity): PlacementIdentity {
  const actual = parseIdentity(value);
  if (!sameIdentity(actual, expected)) throw new PlacementError('UNEXPECTED_IDENTITY', 'placement returned an unexpected document or layer identity');
  return actual;
}

function isUnknownMutation(error: unknown): boolean {
  if (isRecord(error) && (error.acknowledged === false || error.outcome === 'uncertain')) return true;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message = error instanceof Error ? error.message : String(error);
  return ['TRANSPORT_AMBIGUOUS', 'ACK_UNKNOWN', 'TIMEOUT', 'TRANSPORT_ERROR'].includes(code)
    || /lost|unknown|timeout|ambiguous|acknowledg/i.test(message);
}

function uncertain(operation: string, error: unknown): PlacementError {
  const detail = error instanceof Error ? error.message : String(error);
  return new PlacementError('PLACEMENT_UNCERTAIN', `${operation} acknowledgement is unknown; restart from a fresh copy: ${detail}`, { restartRequired: true, outcome: 'uncertain' });
}

async function acknowledge<T>(operation: string, action: () => Promise<T>): Promise<T> {
  try {
    const result = await action();
    if (!isRecord(result) || result.acknowledged !== true) throw uncertain(operation, new Error('missing positive acknowledgement'));
    return result;
  } catch (error) {
    if (error instanceof PlacementError && error.code === 'PLACEMENT_UNCERTAIN') throw error;
    if (isUnknownMutation(error)) throw uncertain(operation, error);
    throw error;
  }
}

function assertCapabilities(capabilities: PlacementCapabilities | undefined, mode: FitMode): PlacementCapabilities {
  if (!capabilities || capabilities.liveQualified !== true || !Array.isArray(capabilities.supportedFitModes) || capabilities.supportedFitModes.length === 0
    || (capabilities.scaleSemantics !== 'uniform-percent' && capabilities.scaleSemantics !== 'independent-percent')
    || (capabilities.translationSemantics !== 'absolute' && capabilities.translationSemantics !== 'absolute-center' && capabilities.translationSemantics !== 'delta')
    || typeof capabilities.independentAxisScale !== 'boolean'
    || !Number.isFinite(capabilities.translationRoundingPx) || capabilities.translationRoundingPx < 0) {
    throw new PlacementError('CAPABILITY_MISSING', 'qualified fit, scale, and translation capabilities are required', { outcome: 'blocked' });
  }
  if (!MODES.includes(mode) || !capabilities.supportedFitModes.includes(mode)) {
    throw new PlacementError('FIT_MODE_UNSUPPORTED', `fit mode ${mode} is not qualified`, { outcome: 'blocked' });
  }
  if (mode === 'stretch' && (capabilities.independentAxisScale !== true || capabilities.scaleSemantics !== 'independent-percent')) {
    throw new PlacementError('FIT_MODE_UNSUPPORTED', 'independent-axis stretch is not qualified', { outcome: 'blocked' });
  }
  return capabilities;
}

function fitModeEvidence(evidence: PlacementEvidenceRow[], row: PlacementEvidenceRow): void {
  evidence.push(row);
}

async function issueWithEvidence<T>(
  operation: PlacementEvidenceRow['operation'],
  fitMode: FitMode,
  evidence: PlacementEvidenceRow[],
  row: Omit<PlacementEvidenceRow, 'operation' | 'fitMode'>,
  action: () => Promise<T>,
): Promise<T> {
  try {
    const result = await acknowledge(operation, action);
    fitModeEvidence(evidence, { ...row, operation, fitMode, acknowledgement: 'acknowledged' });
    return result;
  } catch (error) {
    fitModeEvidence(evidence, {
      ...row,
      operation,
      fitMode,
      acknowledgement: error instanceof PlacementError && error.code === 'PLACEMENT_UNCERTAIN' ? 'unknown' : 'failed-safe',
    });
    throw error;
  }
}

function boundsFromRead(adapter: PlacementAdapter, identity: PlacementIdentity, evidence: PlacementEvidenceRow[], fitMode: FitMode, name: string): Promise<Rect> {
  return adapter.readEffectiveBounds(identity).then((value) => {
    const bounds = observation(value, identity, name);
    fitModeEvidence(evidence, { operation: 'readLayers', fitMode, documentId: identity.documentId, layerId: identity.layerId, bounds, acknowledgement: 'acknowledged' });
    return bounds;
  });
}

function residual(reference: Rect, placed: Rect): { dx: number; dy: number } {
  return centerTranslation(reference, placed);
}

function assertMeasuredScale(original: Rect, measured: Rect, scale: ScalePlan): void {
  const expectedWidth = (original.right - original.left) * scale.percentX / 100;
  const expectedHeight = (original.bottom - original.top) * scale.percentY / 100;
  const actualWidth = measured.right - measured.left;
  const actualHeight = measured.bottom - measured.top;
  if (!Number.isFinite(expectedWidth) || !Number.isFinite(expectedHeight)
    || Math.abs(actualWidth - expectedWidth) > 0.5 || Math.abs(actualHeight - expectedHeight) > 0.5) {
    throw new PlacementError('SIZE_ERROR_UNEXPLAINED', 'post-scale effective size does not match the acknowledged measured scale', { restartRequired: true, outcome: 'uncertain' });
  }
}

function translationCommand(capabilities: PlacementCapabilities, normalized: { dx: number; dy: number }, referenceCenter: AbsoluteCenter, compensation?: { dx: number; dy: number }): TranslationCommand {
  const semantics = capabilities.translationSemantics;
  const compensatedCenter = compensation ? { x: referenceCenter.x + compensation.dx, y: referenceCenter.y + compensation.dy } : referenceCenter;
  const payload = semantics === 'delta'
    // Delta commands already carry the measured residual.  Applying the
    // residual once as a payload and once as compensation moves twice.
    ? { dx: normalized.dx, dy: normalized.dy }
    : semantics === 'absolute-center'
      ? { centerX: compensatedCenter.x, centerY: compensatedCenter.y }
      : { x: compensatedCenter.x, y: compensatedCenter.y };
  return { semantics, normalized, payload, ...(compensation ? { compensation } : {}) };
}

function correctionAllowed(checks: FitCheck[], delta: { dx: number; dy: number }, acknowledgement: PlacementAcknowledgement | void, capabilities: PlacementCapabilities, tolerancePx: number): boolean {
  // Containment/edge checks include position and may fail for the same
  // documented rounding residual that the correction removes.
  if (checks.filter((check) => check.id === 'dimensions' || check.id === 'aspectRatio').some((check) => !check.passed)) return false;
  const documented = isRecord(acknowledgement) && isFiniteNumber(acknowledgement.roundingPx)
    ? acknowledgement.roundingPx
    : capabilities.translationRoundingPx;
  const declared = (isRecord(acknowledgement) && acknowledgement.rounding === true) || documented !== undefined;
  const bound = documented ?? tolerancePx;
  // A qualified tool may round to more than the final acceptance tolerance;
  // keep the correction bounded relative to that tolerance and never accept
  // an unbounded or unexplained residual.
  const maxBound = capabilities.translationSemantics === 'delta' ? Math.max(tolerancePx * 4, capabilities.translationRoundingPx) : tolerancePx * 4;
  return declared && Number.isFinite(bound) && bound >= 0 && bound <= maxBound
    && Math.abs(delta.dx) <= bound && Math.abs(delta.dy) <= bound;
}

async function runPlacement(request: PlacementRequest): Promise<PlacementResult> {
  const { adapter, reference: referenceSelector, target: targetSelector, input, fitMode, tolerancePx = 0.5, signal, approvedInputs, approveInput, expectedPlacedKind } = request;
  const approved = typeof input === 'string' && ((approvedInputs?.includes(input) ?? false) || (approveInput ? await approveInput(input) : false));
  if (!approved) throw new PlacementError('APPROVED_INPUT_REQUIRED', 'input is not an explicitly approved trusted asset');
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0) throw new PlacementError('FIT_VALIDATION_FAILED', 'tolerance must be finite and non-negative');

  const capabilities = assertCapabilities(adapter.capabilities ? await adapter.capabilities() : undefined, fitMode);
  abortIfNeeded(signal);

  const evidence: PlacementEvidenceRow[] = [];
  const referenceIdentity = await adapter.resolve(referenceSelector);
  fitModeEvidence(evidence, { operation: 'resolve', fitMode, documentId: referenceIdentity.documentId, layerId: referenceIdentity.layerId, acknowledgement: 'acknowledged' });
  const targetIdentity = await adapter.resolve(targetSelector);
  fitModeEvidence(evidence, { operation: 'resolve', fitMode, documentId: targetIdentity.documentId, layerId: targetIdentity.layerId, acknowledgement: 'acknowledged' });
  if (referenceIdentity.documentId !== targetIdentity.documentId) throw new PlacementError('UNEXPECTED_IDENTITY', 'reference and target are not in the same document');
  const referenceBounds = await boundsFromRead(adapter, referenceIdentity, evidence, fitMode, 'reference');

  abortIfNeeded(signal);
  if (adapter.select) {
    const selected = await issueWithEvidence('selectLayer', fitMode, evidence, { documentId: targetIdentity.documentId, layerId: targetIdentity.layerId }, () => adapter.select!(targetIdentity));
    const selectedRecord = selected as unknown as Record<string, unknown>;
    if (typeof selectedRecord.documentId === 'string' && typeof selectedRecord.layerId === 'string') returnedIdentity(selectedRecord, targetIdentity);
  }

  const mutation = targetIdentity.kind === 'smartObject' && adapter.replaceContents ? adapter.replaceContents : adapter.place;
  const operation = targetIdentity.kind === 'smartObject' && adapter.replaceContents ? 'replaceContents' : 'place';
  if (!mutation) throw new PlacementError('CAPABILITY_MISSING', 'no qualified place or replace operation is available', { outcome: 'blocked' });
  if (operation === 'place' && !adapter.existingLayerIds) {
    throw new PlacementError('CAPABILITY_MISSING', 'ordinary place requires a preexisting layer-ID inventory', { outcome: 'blocked' });
  }
  const existingIds = operation === 'place' ? new Set(await adapter.existingLayerIds!(targetIdentity.documentId)) : undefined;
  abortIfNeeded(signal);
  const placedResponse = await issueWithEvidence(operation, fitMode, evidence, { documentId: targetIdentity.documentId, layerId: targetIdentity.layerId }, () => mutation(targetIdentity, input));
  const placedIdentity = operation === 'replaceContents' ? returnedIdentity(placedResponse, targetIdentity) : parseIdentity(placedResponse);
  const placementEvidence = evidence.at(-1);
  if (placementEvidence?.operation === operation) {
    placementEvidence.documentId = placedIdentity.documentId;
    placementEvidence.layerId = placedIdentity.layerId;
  }
  if (operation === 'place') {
    if (placedIdentity.documentId !== targetIdentity.documentId || placedIdentity.layerId === targetIdentity.layerId || existingIds?.has(placedIdentity.layerId)) {
      throw new PlacementError('UNEXPECTED_IDENTITY', 'place returned a missing, colliding, or wrong-document layer identity');
    }
    if (!expectedPlacedKind) throw new PlacementError('CAPABILITY_MISSING', 'ordinary place requires an expected placed layer kind', { outcome: 'blocked' });
    if (placedIdentity.kind !== expectedPlacedKind) throw new PlacementError('UNEXPECTED_IDENTITY', 'place returned a layer with an unexpected kind');
  } else if (placedIdentity.layerId !== targetIdentity.layerId || placedIdentity.documentId !== targetIdentity.documentId) {
    throw new PlacementError('UNEXPECTED_IDENTITY', 'replaceContents changed the target identity');
  }
  const originalPlaced = await boundsFromRead(adapter, placedIdentity, evidence, fitMode, 'placed');

  const scale = scaleFor(referenceBounds, originalPlaced, fitMode);
  abortIfNeeded(signal);
  await issueWithEvidence('scale', fitMode, evidence, { documentId: placedIdentity.documentId, layerId: placedIdentity.layerId, scale }, () => adapter.scale(placedIdentity, scale));
  const afterScale = await boundsFromRead(adapter, placedIdentity, evidence, fitMode, 'after-scale');
  assertMeasuredScale(originalPlaced, afterScale, scale);

  const translation = residual(referenceBounds, afterScale);
  const referenceCenter = { x: (referenceBounds.left + referenceBounds.right) / 2, y: (referenceBounds.top + referenceBounds.bottom) / 2 };
  const firstCommand = translationCommand(capabilities, translation, referenceCenter);
  abortIfNeeded(signal);
  const firstTranslationAck = await issueWithEvidence('translate', fitMode, evidence, { documentId: placedIdentity.documentId, layerId: placedIdentity.layerId, normalized: translation, payload: firstCommand }, () => adapter.translate(placedIdentity, firstCommand));
  let finalPlaced = await boundsFromRead(adapter, placedIdentity, evidence, fitMode, 'final');
  let checks = checkFit(referenceBounds, finalPlaced, originalPlaced, fitMode, tolerancePx);
  if (!checks.every((check) => check.passed)) {
    const correction = residual(referenceBounds, finalPlaced);
    if (!correctionAllowed(checks, correction, firstTranslationAck, capabilities, tolerancePx)) throw new PlacementError('FIT_VALIDATION_FAILED', 'measured placement failed post-transform checks');
    abortIfNeeded(signal);
    const correctionCommand = translationCommand(capabilities, correction, referenceCenter, correction);
    await issueWithEvidence('translate', fitMode, evidence, { documentId: placedIdentity.documentId, layerId: placedIdentity.layerId, normalized: correction, payload: correctionCommand }, () => adapter.translate(placedIdentity, correctionCommand));
    finalPlaced = await boundsFromRead(adapter, placedIdentity, evidence, fitMode, 'corrected-final');
    checks = checkFit(referenceBounds, finalPlaced, originalPlaced, fitMode, tolerancePx);
  }
  if (!checks.every((check) => check.passed)) throw new PlacementError('FIT_VALIDATION_FAILED', 'measured placement failed post-transform checks');
  return { documentId: placedIdentity.documentId, layerId: placedIdentity.layerId, fitMode, scale, translation, originalPlaced, afterScale, finalPlaced, checks, evidence };
}

export function placeAndFit(request: PlacementRequest): Promise<PlacementResult>;
export function placeAndFit(adapter: PlacementAdapter, request: Omit<PlacementRequest, 'adapter'>): Promise<PlacementResult>;
export function placeAndFit(first: PlacementRequest | PlacementAdapter, second?: Omit<PlacementRequest, 'adapter'>): Promise<PlacementResult> {
  const request = 'adapter' in first ? first : { ...second!, adapter: first };
  return runPlacement(request);
}
