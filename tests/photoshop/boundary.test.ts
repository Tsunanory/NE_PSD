import { describe, expect, it } from 'vitest';
import { parseRequest } from '../../packages/photoshop/src/index.js';
import { FakeSession } from './fake-session.js';
import { requestFixture, sceneFixture } from './fixture.js';

describe('Photoshop adapter boundary', () => {
  it('rejects staging paths that escape the trusted root', () => {
    expect(() => parseRequest({ ...requestFixture(), stagingDirectory: '../escape' })).toThrow();
  });

  it('parses a shared contract request and preserves the scene geometry', () => {
    const scene = sceneFixture();
    expect(parseRequest(requestFixture()).attempt).toBe(1);
    expect(scene.reference.bounds).toEqual({ left: 100, top: 200, right: 900, bottom: 600 });
  });

  it('opens independently identified fresh copies with one in-flight operation', async () => {
    const session = new FakeSession(sceneFixture());
    const unrelatedBefore = session.documents.find((document) => document.path?.endsWith('notes.psd'))!;
    const first = await session.openFreshCopy('attempt-1');
    const second = await session.openFreshCopy('attempt-2');
    expect(first.rootId).not.toBe(second.rootId);
    expect(session.maximumInFlight).toBe(1);
    expect(session.documents.find((document) => document.id === unrelatedBefore.id)).toEqual(unrelatedBefore);
  });

  it('completes delayed operations through the deterministic pending control surface', async () => {
    const session = new FakeSession(sceneFixture());
    const { rootId } = await session.openFreshCopy('attempt-1');
    const placedId = session.readScene().layers.find((layer) => layer.name === 'Placed')!.id;
    session.delay('place', 1);
    const pending = session.place(rootId, placedId, 'asset-delayed');
    await Promise.resolve();
    expect(session.calls.at(-1)?.state).toBe('issued');
    session.completePending();
    await pending;
    expect(session.readScene().layers.find((layer) => layer.id === placedId)?.contentKey).toBe('asset-delayed');
  });

  it('applies a place mutation once even when its acknowledgement is lost', async () => {
    const session = new FakeSession(sceneFixture());
    const { rootId } = await session.openFreshCopy('attempt-1');
    session.applyThenLoseReply('place');
    const placedId = session.readScene().layers.find((layer) => layer.name === 'Placed')?.id;
    await expect(session.place(rootId, placedId!, 'asset-1')).rejects.toThrow('acknowledgement');
    const placed = session.readScene().layers.find((layer) => layer.name === 'Placed');
    expect(placed?.contentKey).toBe('asset-1');
    expect(session.mutations.filter((mutation) => mutation.operation === 'place')).toHaveLength(1);
    expect(session.faults.at(-1)?.phase).toBe('after');
  });

  it('records a pre-mutation fault and leaves the layer unchanged', async () => {
    const session = new FakeSession(sceneFixture());
    const { rootId } = await session.openFreshCopy('attempt-1');
    const placedId = session.readScene().layers.find((layer) => layer.name === 'Placed')!.id;
    session.failBefore('place');
    await expect(session.place(rootId, placedId, 'asset-never-placed')).rejects.toThrow('before place');
    expect(session.readScene().layers.find((layer) => layer.id === placedId)?.contentKey).toBe('placed-content');
    expect(session.faults.at(-1)?.phase).toBe('before');
  });
});
