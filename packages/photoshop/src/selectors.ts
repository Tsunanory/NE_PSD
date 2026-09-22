import { sha256Json } from '@ne-psd/contracts';
import type { LayerSelector, LayerSegment } from '@ne-psd/contracts';
import type { DocumentState, LayerState } from './types.js';

export type SelectorLayer = LayerState & {
  mask?: unknown;
  typeMetadata?: unknown;
  childDocument?: SelectorDocument;
  document?: SelectorDocument;
};

export type SelectorDocument = DocumentState & {
  layers: SelectorLayer[];
  childDocuments?: SelectorDocument[];
};

export type SelectorErrorCode =
  | 'SELECTOR_AMBIGUOUS'
  | 'SELECTOR_MISSING'
  | 'SELECTOR_KIND_MISMATCH'
  | 'SELECTOR_FINGERPRINT_MISMATCH'
  | 'SELECTOR_DOCUMENT_ROUTE_MISMATCH'
  | 'TARGET_SELECTION_UNSUPPORTED';

export class SelectorError extends Error {
  readonly code: SelectorErrorCode;
  constructor(code: SelectorErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'SelectorError';
    this.code = code;
  }
}

type StructuralLayer = Pick<SelectorLayer, 'name' | 'kind' | 'children'> & {
  mask?: unknown;
  typeMetadata?: unknown;
};

function layerShape(layer: StructuralLayer): unknown {
  return {
    name: layer.name,
    kind: layer.kind,
    mask: layer.mask ?? null,
    typeMetadata: layer.typeMetadata ?? null,
    children: layer.children.map((child) => layerShape(child as StructuralLayer)),
  };
}

/** Stable identity for a layer's qualified position; excludes id, visibility and content. */
export function structuralFingerprint(layer: SelectorLayer, siblings: readonly SelectorLayer[], treePath: readonly number[] = []): string {
  const structure = {
    treePath: [...treePath],
    layer: layerShape(layer),
    siblings: siblings.map((sibling) => layerShape(sibling)),
  };
  return sha256Json(structure);
}

function childrenOf(layer: SelectorLayer): SelectorLayer[] {
  return layer.children as SelectorLayer[];
}

function resolveSegment(layers: readonly SelectorLayer[], segment: LayerSegment, basePath: readonly number[]): SelectorLayer {
  const named = layers.filter((layer) => layer.name === segment.name);
  if (named.length === 0) throw new SelectorError('SELECTOR_MISSING', `layer ${segment.name}`);
  const typed = named.filter((layer) => layer.kind === segment.kind);
  if (typed.length === 0) throw new SelectorError('SELECTOR_KIND_MISMATCH', `layer ${segment.name}`);
  const matching = typed.filter((layer) => structuralFingerprint(layer, layers, [...basePath, layers.indexOf(layer)]) === segment.fingerprint);
  // Ambiguity is relative to the candidate proved by the selector, never to
  // the first same-name candidate. The first candidate may be a different
  // structural sibling and must not influence the result.
  const selected = matching[0];
  const equivalent = selected
    ? typed.filter((layer) => sha256Json(layerShape(layer)) === sha256Json(layerShape(selected)))
    : [];
  if (matching.length === 1 && equivalent.length > 1) throw new SelectorError('SELECTOR_AMBIGUOUS', `layer ${segment.name}`);
  if (matching.length > 1) throw new SelectorError('SELECTOR_AMBIGUOUS', `layer ${segment.name}`);
  if (matching.length === 0) throw new SelectorError('SELECTOR_FINGERPRINT_MISMATCH', `layer ${segment.name}`);
  return matching[0]!;
}

function resolvePath(layers: readonly SelectorLayer[], path: readonly LayerSegment[], basePath: readonly number[] = []): SelectorLayer {
  let siblings = layers;
  let current: SelectorLayer | undefined;
  let currentPath = [...basePath];
  for (const [index, segment] of path.entries()) {
    current = resolveSegment(siblings, segment, currentPath);
    currentPath = [...currentPath, siblings.indexOf(current)];
    siblings = childrenOf(current);
  }
  if (!current) throw new SelectorError('SELECTOR_MISSING', 'empty layer path');
  return current;
}

function childDocument(parent: SelectorDocument, via: SelectorLayer): SelectorDocument {
  const direct = via.childDocument ?? via.document;
  const listed = parent.childDocuments?.filter((candidate) => candidate.parentId === parent.id);
  if (direct && direct.parentId === parent.id && (!listed || listed.some((candidate) => candidate.id === direct.id))) return direct;
  const linked = listed?.find((candidate) => (candidate as SelectorDocument & { viaLayerId?: string }).viaLayerId === via.id);
  if (linked) return linked;
  throw new SelectorError('SELECTOR_DOCUMENT_ROUTE_MISMATCH', `child of ${via.name}`);
}

export function resolveLayer(document: SelectorDocument, selector: LayerSelector): SelectorLayer {
  let current = document;
  for (const routePath of selector.documentRoute) {
    const via = resolvePath(current.layers, routePath);
    current = childDocument(current, via);
  }
  return resolvePath(current.layers, selector.layerPath);
}

/** A name-only upstream cannot safely select duplicate names. */
export function assertNameSelectionSupported(document: SelectorDocument, name: string): void {
  const matches: SelectorLayer[] = [];
  const visit = (layers: readonly SelectorLayer[]): void => {
    for (const layer of layers) {
      if (layer.name === name) matches.push(layer);
      visit(childrenOf(layer));
    }
  };
  visit(document.layers);
  if (matches.length !== 1) throw new SelectorError('TARGET_SELECTION_UNSUPPORTED', `name-only selection is not unique: ${name}`);
}
