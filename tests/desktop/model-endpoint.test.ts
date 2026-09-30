import { describe, expect, it, vi } from 'vitest';
import { assertLoopbackEndpoint, endpointUrl, requestModelEndpoint } from '../../apps/desktop/src/main/model-endpoint.js';

const json = (body: string, init?: ResponseInit) => new Response(body, init);
const asFetch = (fn: (url: URL, init: RequestInit) => Promise<Response>): typeof fetch => fn as typeof fetch;

describe('main-only model endpoint', () => {
  it('accepts literal loopback and rejects other authority forms', () => {
    expect(endpointUrl()).toBe('http://127.0.0.1:8080');
    for (const url of ['http://127.0.0.1:8080', 'http://[::1]:8080', 'http://localhost:8080']) expect(() => assertLoopbackEndpoint(url)).not.toThrow();
    for (const url of ['http://192.168.1.5:8080', 'http://127.0.0.2:8080', 'http://127.1:8080', 'http://0177.0.0.1:8080', 'http://evil.example:8080', 'https://localhost:8080', 'http://user:pass@localhost:8080', 'http://localhost:8080/path', 'http://localhost:8080/?x=1']) expect(() => assertLoopbackEndpoint(url)).toThrow();
  });
  it('uses only fixed paths and strict JSON', async () => {
    const fetchImpl = vi.fn(asFetch(async (url, init) => { expect(url.href).toBe('http://127.0.0.1:8080/v1/models'); expect(init.redirect).toBe('manual'); return json('{"data":[]}'); }));
    expect((await requestModelEndpoint(endpointUrl(), '/v1/models', { fetchImpl })).body).toEqual({ data: [] });
    await expect(requestModelEndpoint(endpointUrl(), '/v1/chat/completions' as '/health', { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(requestModelEndpoint(endpointUrl(), '/health', { fetchImpl: asFetch(async () => json('[]')) })).rejects.toThrow(/object/);
  });
  it('rejects redirects without following them', async () => {
    const fetchImpl = vi.fn(asFetch(async () => json('', { status: 302, headers: { location: 'http://evil.example/' } })));
    await expect(requestModelEndpoint(endpointUrl(), '/health', { fetchImpl })).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('limits bytes while streaming and times out stalled responses', async () => {
    await expect(requestModelEndpoint(endpointUrl(), '/health', { maxBytes: 100, fetchImpl: asFetch(async () => json('x'.repeat(5000))) })).rejects.toThrow(/size limit/);
    const fetchImpl = asFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
    await expect(requestModelEndpoint(endpointUrl(), '/health', { timeoutMs: 30, fetchImpl })).rejects.toThrow(/timed out/);
  });
  it('resolves localhost to numeric loopback before fetch', async () => {
    const lookupImpl = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const fetchImpl = asFetch(async (url) => { expect(url.hostname).toBe('127.0.0.1'); return json('{}'); });
    await requestModelEndpoint('http://localhost:8080', '/health', { lookupImpl: lookupImpl as typeof import('node:dns/promises').lookup, fetchImpl });
    expect(lookupImpl).toHaveBeenCalledTimes(1);
    await expect(requestModelEndpoint('http://localhost:8080', '/health', { lookupImpl: (async () => [{ address: '192.168.1.5', family: 4 }]) as typeof import('node:dns/promises').lookup, fetchImpl })).rejects.toThrow(/loopback/);
  });
});
