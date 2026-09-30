import { describe, expect, it } from 'vitest';
import { parseStrictJson, parseStrictJsonValue, parseAndValidateStrictJson } from '@ne-psd/intelligence';
describe('strict model JSON', () => {
  it('rejects duplicate keys including nested objects', () => {
    expect(() => parseStrictJson('{"verdict":"blocked","verdict":"pass"}')).toThrow(/duplicate/i);
    expect(() => parseStrictJson('{"check":{"id":"a","id":"b"}}')).toThrow(/duplicate/i);
  });
  it('rejects fences and trailing prose without repair', () => {
    expect(() => parseStrictJson('```json\n{}\n```')).toThrow();
    expect(() => parseStrictJson('{} trailing')).toThrow();
  });
  it('enforces response byte limits', () => { expect(() => parseStrictJson('{}', 1)).toThrow(/byte/i); });
  it('rejects malformed UTF-8 bytes and escaped-equivalent duplicate keys', () => { expect(() => parseStrictJsonValue(new Uint8Array([0xc3, 0x28]))).toThrow(/UTF-8/i); expect(() => parseStrictJson('{"a":1,"\\u0061":2}')).toThrow(/duplicate/i); });
  it('applies the supplied strict schema validator once without coercion', () => { expect(() => parseAndValidateStrictJson(new TextEncoder().encode('{"kind":"bad","extra":1}'), (value) => { const record = value as Record<string, unknown>; if (record.kind !== 'good' || Object.keys(record).length !== 1) throw new Error('schema invalid'); return record; })).toThrow(/schema/i); });
  it('normalizes malformed nested scanner input to StrictJsonError', () => { expect(() => parseStrictJson('{"x":"\\uZZZZ"}')).toThrow(/invalid JSON/i); expect(() => parseStrictJson('{"x":"unterminated}')).toThrow(/invalid JSON/i); });
});
