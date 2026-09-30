import type { CallRecord, DocumentState, FaultRecord, LayerState, MutationRecord, OperationKind } from '../../packages/photoshop/src/types.js';
import type { FakeScene } from './fixtures/scenes.js';
import type { Rect } from '@ne-psd/contracts';

function copyLayer(layer: LayerState, id: string, parentId: string | null): LayerState {
  return { ...layer, id, parentId, bounds: layer.bounds === null ? null : { ...layer.bounds }, children: [] };
}

function copyScene(scene: FakeScene, serial: number): FakeScene {
  const documents = scene.documents.map((document, index) => ({
    ...document,
    id: `doc-${serial}-${index + 1}`,
    parentId: document.parentId === null ? null : `doc-${serial}-1`,
  }));
  const layers = scene.layers.map((layer, index) => copyLayer(layer, `layer-${serial}-${index + 1}`, null));
  const reference = layers.find((layer) => layer.name === scene.reference.name)!;
  const placed = layers.find((layer) => layer.name === scene.placed.name)!;
  return { root: documents[0]!, documents, unrelated: { ...scene.unrelated }, layers, reference, placed };
}

function snapshotScene(scene: FakeScene): FakeScene {
  const documents = scene.documents.map((document) => ({ ...document }));
  const layers = scene.layers.map((layer) => ({ ...layer, bounds: layer.bounds === null ? null : { ...layer.bounds }, children: [] }));
  const reference = layers.find((layer) => layer.name === scene.reference.name)!;
  const placed = layers.find((layer) => layer.name === scene.placed.name)!;
  return { root: documents[0]!, documents, unrelated: { ...scene.unrelated }, layers, reference, placed };
}

export class FakeSession {
  readonly calls: CallRecord[] = [];
  readonly mutations: MutationRecord[] = [];
  readonly faults: FaultRecord[] = [];
  private scene: FakeScene;
  private serial = 0;
  private requestSerial = 0;
  private active = 0;
  private maxActive = 0;
  private readonly delays = new Map<OperationKind, number>();
  private readonly beforeFaults = new Map<OperationKind, Error>();
  private readonly lostReplies = new Set<OperationKind>();

  constructor(scene: FakeScene) { this.scene = copyScene(scene, 0); }

  get documents(): readonly DocumentState[] { return [...this.scene.documents, this.scene.unrelated].map((document) => ({ ...document })); }
  get maximumInFlight(): number { return this.maxActive; }

  seed(scene: FakeScene): void { this.scene = copyScene(scene, ++this.serial); }
  delay(operation: OperationKind, milliseconds: number): void { this.delays.set(operation, milliseconds); }
  failBefore(operation: OperationKind, error = new Error(`fake failure before ${operation}`)): void { this.beforeFaults.set(operation, error); }
  applyThenLoseReply(operation: OperationKind): void { this.lostReplies.add(operation); }
  private readonly pending: Array<() => void> = [];
  completePending(): void { const pending = this.pending.splice(0); for (const resolve of pending) resolve(); }
  readScene(): FakeScene { return snapshotScene(this.scene); }
  setLayerBounds(layerId: string, bounds: Rect): void {
    const layer = this.scene.layers.find((candidate) => candidate.id === layerId);
    if (!layer) throw new Error(`unknown layer: ${layerId}`);
    layer.bounds = { ...bounds };
  }
  setVisibleVariant(variantId: '1' | '2' | '3'): void {
    for (const layer of this.scene.layers) if (/^[123] картинка$/.test(layer.name)) layer.visible = layer.name.startsWith(variantId);
  }

  async openFreshCopy(_attemptId: string): Promise<{ rootId: string }> {
    this.scene = copyScene(this.scene, ++this.serial);
    await this.run('openDocument', this.scene.root.id, null, () => undefined);
    return { rootId: this.scene.root.id };
  }

  async place(documentId: string, layerId: string, contentKey: string): Promise<void> {
    return this.run('place', documentId, layerId, () => {
      const layer = this.scene.layers.find((candidate) => candidate.id === layerId);
      if (!layer) throw new Error(`unknown layer: ${layerId}`);
      const before = layer.contentKey;
      layer.contentKey = contentKey;
      const document = this.scene.documents.find((candidate) => candidate.id === documentId);
      if (document) document.dirty = true;
      this.mutations.push({ operation: 'place', documentId, layerId, before, after: contentKey, fault: this.lostReplies.has('place') ? 'after' : 'none' });
    });
  }

  async execute(operation: OperationKind, documentId: string | null, layerId: string | null, mutate: () => void = () => undefined): Promise<void> {
    await this.run(operation, documentId, layerId, mutate);
  }

  async closeOwned(): Promise<void> {
    for (const document of [...this.scene.documents].reverse()) {
      await this.run('closeDiscard', document.id, null, () => {
        this.scene.documents = this.scene.documents.filter((candidate) => candidate.id !== document.id);
      });
    }
  }

  private async run(operation: OperationKind, documentId: string | null, layerId: string | null, mutate: () => void): Promise<void> {
    const requestId = `request-${++this.requestSerial}`;
    const startedAt = new Date().toISOString();
    const call: CallRecord = { sequence: this.calls.length + 1, operation, requestId, documentId, layerId, state: 'issued', startedAt, finishedAt: null, evidencePath: `calls/${requestId}.json` };
    this.calls.push(call);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const before = this.beforeFaults.get(operation);
      if (before) {
        this.beforeFaults.delete(operation);
        this.faults.push({ operation, phase: 'before', requestId });
        call.state = 'failedSafe';
        throw before;
      }
      if ((this.delays.get(operation) ?? 0) > 0) await new Promise<void>((resolve) => this.pending.push(resolve));
      mutate();
      if (this.lostReplies.delete(operation)) {
        this.faults.push({ operation, phase: 'after', requestId });
        call.state = 'unknown';
        throw new Error(`${operation} acknowledgement was lost`);
      }
      call.state = 'acknowledged';
    } finally {
      call.finishedAt = new Date().toISOString();
      this.active -= 1;
    }
  }
}
