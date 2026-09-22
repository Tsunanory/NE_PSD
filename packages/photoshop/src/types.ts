import { RenderRequestSchema, type FitMode, type LayerSelector, type Rect, type RenderRequest } from '@ne-psd/contracts';
import type { SelectorDocument } from './selectors.js';

export type DocumentId = string;
export type LayerId = string;

export type DocumentState = {
  id: DocumentId;
  path: string | null;
  parentId: DocumentId | null;
  width: number;
  height: number;
  dirty: boolean;
  sourceKind: 'root' | 'embedded' | 'linked' | 'unknown';
};

/** Lifecycle observations are adapter-normalized; Photoshop IDs are runtime-only. */
export type DocumentContentType = 'psd' | 'psb' | 'unknown';
export type DocumentTraceState = 'issued' | 'acknowledged' | 'failedSafe' | 'unknown';
export type DocumentTraceRecord = {
  sequence: number;
  type: 'operation' | 'ownership-proof' | 'state-transition';
  operation?: Extract<OperationKind, 'openDocument' | 'openContents' | 'saveChild' | 'closeDiscard'>;
  documentId?: DocumentId;
  parentId?: DocumentId | null;
  route?: string | null;
  state?: DocumentTraceState | string;
  transition?: string;
  owned?: boolean;
  ownershipKey?: string;
  reason?: string;
  beforeDocumentIds?: string[];
  afterDocumentIds?: string[];
  activeDocumentId?: string | null;
  expectedPath?: string | null;
  expectedParentId?: string | null;
  expectedRoute?: string | null;
  provisional?: boolean;
  authorization?: 'allowed' | 'denied' | 'not-checked';
  timestamp: string;
};

export type LayerState = {
  id: LayerId;
  parentId: LayerId | null;
  name: string;
  kind: 'group' | 'smartObject' | 'pixel' | 'shape';
  bounds: Rect | null;
  visible: boolean;
  clipped: boolean;
  contentKey: string | null;
  children: LayerState[];
  /** Optional observed geometry from Photoshop's DOM, distinct from raster bounds. */
  rawBounds?: Rect | null;
  effectiveBounds?: Rect | null;
  mask?: unknown;
  typeMetadata?: unknown;
  childDocument?: SelectorDocument;
};

export type ScalePlan = { percentX: number; percentY: number };
export type Translation = { dx: number; dy: number };
export type OperationKind =
  | 'listDocuments' | 'readDocument' | 'readLayers' | 'readLinkage'
  | 'openDocument' | 'activateDocument' | 'selectLayer' | 'openContents'
  | 'place' | 'replaceContents' | 'scale' | 'translate' | 'moveAbove'
  | 'setClipping' | 'setVisibility' | 'saveChild' | 'closeDiscard'
  | 'export' | 'convertProfile' | 'embedLink' | 'relink';

export type CallRecord = {
  sequence: number;
  operation: OperationKind;
  requestId: string;
  documentId: string | null;
  layerId: string | null;
  state: 'issued' | 'acknowledged' | 'failedSafe' | 'unknown';
  startedAt: string;
  finishedAt: string | null;
  evidencePath: string;
};

export type MutationRecord = {
  operation: OperationKind;
  documentId: string | null;
  layerId: string | null;
  before: unknown;
  after: unknown;
  fault: 'none' | 'before' | 'after';
};

export type FaultRecord = {
  operation: OperationKind;
  phase: 'before' | 'after';
  requestId: string;
};

export type PhotoshopRequest = RenderRequest;
export type { FitMode, LayerSelector, Rect, RenderRequest };
export { RenderRequestSchema };
