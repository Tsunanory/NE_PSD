import type { Rect } from '@ne-psd/contracts';
import type { DocumentState, LayerState } from '../../../packages/photoshop/src/types.js';

export type FakeScene = {
  root: DocumentState;
  documents: DocumentState[];
  unrelated: DocumentState;
  layers: LayerState[];
  reference: LayerState;
  placed: LayerState;
};

const bounds = (value: Rect): Rect => ({ ...value });

export function sceneFixture(): FakeScene {
  const reference: LayerState = {
    id: 'reference-static', parentId: null, name: 'Reference', kind: 'pixel',
    bounds: bounds({ left: 100, top: 200, right: 900, bottom: 600 }), visible: true,
    clipped: false, contentKey: 'reference-content', children: [],
  };
  const placed: LayerState = {
    id: 'placed-static', parentId: null, name: 'Placed', kind: 'smartObject',
    bounds: bounds({ left: 20, top: 30, right: 220, bottom: 430 }), visible: true,
    clipped: false, contentKey: 'placed-content', children: [],
  };
  const variants = ['1', '2', '3'].map((id) => ({
    id: `variant-${id}-static`, parentId: null, name: `${id} картинка`, kind: 'group' as const,
    bounds: null, visible: id === '1', clipped: false, contentKey: null, children: [],
  }));
  const root: DocumentState = {
    id: 'root-static', path: '/fixtures/template.psd', parentId: null,
    width: 1500, height: 2000, dirty: false, sourceKind: 'root',
  };
  const child: DocumentState = {
    id: 'child-static', path: null, parentId: root.id,
    width: 3190, height: 1418, dirty: false, sourceKind: 'embedded',
  };
  const unrelated: DocumentState = {
    id: 'user-document-static', path: '/Users/owner/notes.psd', parentId: null,
    width: 640, height: 480, dirty: false, sourceKind: 'unknown',
  };
  return { root, documents: [root, child], unrelated, layers: [reference, placed, ...variants], reference, placed };
}
