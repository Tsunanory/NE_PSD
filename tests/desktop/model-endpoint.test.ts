import { describe, expect, it } from 'vitest';
import { assertLoopbackEndpoint, endpointUrl } from '../../apps/desktop/src/main/model-endpoint.js';
describe('desktop model endpoint boundary', () => {
  it('allows only literal loopback endpoints', () => { expect(endpointUrl()).toBe('http://127.0.0.1:8080'); expect(() => assertLoopbackEndpoint('http://127.0.0.1:8080')).not.toThrow(); expect(() => assertLoopbackEndpoint('http://localhost:8080')).not.toThrow(); expect(() => assertLoopbackEndpoint('http://192.168.1.5:8080')).toThrow(); expect(() => assertLoopbackEndpoint('https://localhost:8080')).toThrow(); });
  it('rejects redirects leaving loopback', () => { expect(() => assertLoopbackEndpoint('http://127.0.0.1:8080')).not.toThrow(); expect(() => assertLoopbackEndpoint('http://evil.example:8080')).toThrow(); });
});
