import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PATHS = new Set(['/health', '/v1/models']);
export const endpointUrl = (): string => 'http://127.0.0.1:8080';
export function assertLoopbackEndpoint(value: string): URL {
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}\/?$/.test(value)) throw new Error('model endpoint must be literal loopback HTTP origin');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('model endpoint URL is invalid'); }
  if (url.protocol !== 'http:' || !HOSTS.has(url.hostname) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !url.port) throw new Error('model endpoint must be literal loopback HTTP origin');
  return url;
}
export type EndpointResponse = { status: number; body: Record<string, unknown> };
export type EndpointOptions = {
  timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch;
  lookupImpl?: typeof lookup;
};
export async function requestModelEndpoint(endpoint: string, path: '/health' | '/v1/models', options: EndpointOptions = {}): Promise<EndpointResponse> {
  const base = assertLoopbackEndpoint(endpoint);
  if (!PATHS.has(path)) throw new Error('model endpoint path is not qualified');
  const timeoutMs = options.timeoutMs ?? 2000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('model endpoint limits are invalid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('model endpoint timed out')), timeoutMs);
  try {
    if (base.hostname === 'localhost') {
      const addresses = await Promise.race([
        (options.lookupImpl ?? lookup)('localhost', { all: true }),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      ]);
      if (addresses.length === 0 || addresses.some(({ address }) => address !== '127.0.0.1' && address !== '::1')) throw new Error('localhost must resolve only to loopback');
      const address = addresses.find(({ address }) => address === '127.0.0.1')?.address ?? addresses[0]!.address;
      base.hostname = isIP(address) === 6 ? `[${address}]` : address;
    }
    const url = new URL(path, base);
    const response = await (options.fetchImpl ?? fetch)(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) throw new Error('model endpoint redirect is forbidden');
    if (!response.ok) throw new Error(`model endpoint HTTP ${response.status}`);
    if (!response.body) throw new Error('model endpoint response has no body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('model endpoint response exceeds size limit'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('model endpoint response is not valid JSON'); }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('model endpoint response must be an object');
    return { status: response.status, body: body as Record<string, unknown> };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('model endpoint timed out', { cause: error });
    throw error;
  } finally { clearTimeout(timer); }
}
