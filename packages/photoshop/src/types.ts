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
