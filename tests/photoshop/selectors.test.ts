import { describe, expect, it } from 'vitest';
import type { LayerSelector } from '@ne-psd/contracts';
import { assertNameSelectionSupported, resolveLayer, structuralFingerprint, type SelectorDocument } from '../../packages/photoshop/src/selectors.js';
import { sceneFixture } from './fixtures/scenes.js';

const segment = (name: string, kind: 'group' | 'smartObject' | 'pixel' | 'shape', fingerprint: string) => ({ name, kind, fingerprint });

function selectorFor(name: string, kind: 'group' | 'smartObject' | 'pixel' | 'shape', fingerprint: string): LayerSelector {
  return { documentRoute: [], layerPath: [segment(name, kind, fingerprint)] };
}

function documentFromScene(): SelectorDocument {
  const scene = sceneFixture();
  return { ...scene.root, layers: scene.layers };
}

describe('qualified structural selectors', () => {
  it('resolves an exact qualified variant while ignoring mutable state', () => {
    const document = documentFromScene();
    const layer = document.layers[2]!;
    const fingerprint = structuralFingerprint(layer, document.layers, [2]);
    const selector = selectorFor('1 картинка', 'group', fingerprint);
    expect(resolveLayer(document, selector).name).toBe('1 картинка');
    layer.visible = !layer.visible;
    layer.contentKey = 'changed-content';
    expect(resolveLayer(document, selector).name).toBe('1 картинка');
  });

  it('rejects duplicate matching siblings as ambiguous', () => {
    const document = documentFromScene();
    const original = document.layers[2]!;
    document.layers.push({ ...original, id: 'duplicate', visible: false });
    const fingerprint = structuralFingerprint(original, document.layers, [2]);
    expect(() => resolveLayer(document, selectorFor('1 картинка', 'group', fingerprint))).toThrow('SELECTOR_AMBIGUOUS');
  });

  it('rejects missing, kind-changed, moved, and changed-fingerprint segments precisely', () => {
    const document = documentFromScene();
    const layer = document.layers[2]!;
    const fingerprint = structuralFingerprint(layer, document.layers, [2]);
    expect(() => resolveLayer(document, selectorFor('missing', 'group', fingerprint))).toThrow('SELECTOR_MISSING');
    expect(() => resolveLayer(document, selectorFor('1 картинка', 'pixel', fingerprint))).toThrow('SELECTOR_KIND_MISMATCH');
    expect(() => resolveLayer(document, selectorFor('1 картинка', 'group', 'changed'))).toThrow('SELECTOR_FINGERPRINT_MISMATCH');
    document.layers.splice(2, 1);
    document.layers.push({ ...layer, id: 'moved' });
    expect(() => resolveLayer(document, selectorFor('1 картинка', 'group', fingerprint))).toThrow('SELECTOR_FINGERPRINT_MISMATCH');
  });

  it('resolves reopened IDs and verifies a child route parent relationship', () => {
    const scene = sceneFixture();
    const first = documentFromScene();
    const firstFingerprint = structuralFingerprint(first.layers[2]!, first.layers, [2]);
    const reopened: SelectorDocument = { ...scene.root, id: 'reopened-root', layers: first.layers.map((layer, index) => ({ ...layer, id: `reopened-${index}` })) };
    const selector = selectorFor('1 картинка', 'group', firstFingerprint);
    expect(resolveLayer(reopened, selector).id).not.toBe(resolveLayer(first, selector).id);
  });

  it('resolves a qualified root smart-object route into a reopened child', () => {
    const root = documentFromScene();
    const via = { ...root.layers[1]!, name: 'МЕНЯТЬ ЗДЕСЬ!', kind: 'smartObject' as const };
    const childLayer = { ...root.layers[2]!, id: 'child-target', name: '1 картинка' };
    const child = { ...root, id: 'child-document', parentId: root.id, layers: [childLayer] };
    via.childDocument = child;
    root.layers[1] = via;
    root.childDocuments = [child];
    const routeFingerprint = structuralFingerprint(via, root.layers, [1]);
    const childFingerprint = structuralFingerprint(childLayer, child.layers, [0]);
    const selector: LayerSelector = {
      documentRoute: [[segment(via.name, via.kind, routeFingerprint)]],
      layerPath: [segment(childLayer.name, childLayer.kind, childFingerprint)],
    };
    const reopened = { ...root, id: 'reopened-root', layers: root.layers.map((layer, index) => ({ ...layer, id: `reopened-${index}` })) };
    const reopenedChild = { ...child, id: 'reopened-child', parentId: reopened.id, layers: child.layers.map((layer) => ({ ...layer, id: 'reopened-child-layer' })) };
    const reopenedVia = reopened.layers[1]!;
    reopenedVia.childDocument = reopenedChild;
    reopened.childDocuments = [reopenedChild];
    expect(resolveLayer(reopened, selector).id).toBe('reopened-child-layer');
  });

  it('rejects an unbound child and wrong via-layer association', () => {
    const root = documentFromScene();
    const via = { ...root.layers[1]!, name: 'МЕНЯТЬ ЗДЕСЬ!', kind: 'smartObject' as const };
    const child = { ...root, id: 'child-document', parentId: root.id, layers: [root.layers[2]!] };
    root.layers[1] = via;
    root.childDocuments = [child];
    const routeFingerprint = structuralFingerprint(via, root.layers, [1]);
    const childFingerprint = structuralFingerprint(child.layers[0]!, child.layers, [0]);
    const selector: LayerSelector = { documentRoute: [[segment(via.name, via.kind, routeFingerprint)]], layerPath: [segment(child.layers[0]!.name, child.layers[0]!.kind, childFingerprint)] };
    expect(() => resolveLayer(root, selector)).toThrow('SELECTOR_DOCUMENT_ROUTE_MISMATCH');
    via.childDocument = { ...child, parentId: 'wrong-parent' };
    expect(() => resolveLayer(root, selector)).toThrow('SELECTOR_DOCUMENT_ROUTE_MISMATCH');
  });

  it('requires global uniqueness for name-only selection, including nested groups', () => {
    const document = documentFromScene();
    const groupA = { ...document.layers[2]!, id: 'group-a', children: [{ ...document.layers[2]!, id: 'nested-a', name: 'Target' }] };
    const groupB = { ...document.layers[3]!, id: 'group-b', children: [{ ...document.layers[3]!, id: 'nested-b', name: 'Target' }] };
    document.layers.push(groupA, groupB);
    expect(() => assertNameSelectionSupported(document, 'Target')).toThrow('TARGET_SELECTION_UNSUPPORTED');
  });

  it('resolves same-named layers under different groups by parent path', () => {
    const document = documentFromScene();
    const first = { ...document.layers[2]!, id: 'first-group', children: [{ ...document.layers[2]!, id: 'first-target', name: 'Target' }] };
    const second = { ...document.layers[3]!, id: 'second-group', children: [{ ...document.layers[3]!, id: 'second-target', name: 'Target' }] };
    document.layers = [first, second];
    const groupFingerprint = structuralFingerprint(second, document.layers, [1]);
    const targetFingerprint = structuralFingerprint(second.children[0]!, second.children, [1, 0]);
    const resolved = resolveLayer(document, { documentRoute: [], layerPath: [segment(second.name, second.kind, groupFingerprint), segment('Target', second.children[0]!.kind, targetFingerprint)] });
    expect(resolved.id).toBe('second-target');
  });
});
