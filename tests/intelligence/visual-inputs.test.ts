import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { sha256Bytes, ModelProfileSchema } from '@ne-psd/contracts';
import { prepareVisionPayload } from '@ne-psd/intelligence';

const sha = 'a'.repeat(64);
const profile = ModelProfileSchema.parse({ profileId: 'vision-qualified', provider: 'local-vision', modelId: 'vision-test', provenance: { kind: 'local', artifactSha256: sha, runtimeVersion: 'runtime', chatTemplateSha256: sha }, endpoint: 'http://127.0.0.1:1', quantization: 'Q8_0', contextTokens: 8192, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: true, tools: false } });
const record: any = { profile, selectable: true, qualification: { runtimeQualified: true, artifact: { runtimeSettings: { visionInputQualified: 'true', visionMaxImages: '10', visionMaxWidth: '10', visionMaxHeight: '10', visionMaxPixels: '100', visionMaxTotalBytes: '100000', visionMaxDecodedBytes: '400', visionMaxTotalDecodedBytes: '4000' } } } };
const png = (red: number, width = 10, height = 10) => sharp({ create: { width, height, channels: 4, background: { r: red, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
const item = (id: string, role: 'source'|'reference'|'output'|'detail', bytes: Uint8Array, variantId: '1'|'2'|'3'|null, derivedFromSha256: string, crop: any = null, width = 10, height = 10) => ({ id, role, relativePath: `${id}.png`, sha256: sha256Bytes(bytes), width, height, variantId, derivedFromSha256, crop, bytes });
async function images(distinct = false) {
  const base = await png(50);
  const outputBytes = await Promise.all([1,2,3].map((n) => distinct ? png(n * 50) : Promise.resolve(base)));
  const list: ReturnType<typeof item>[] = [item('source', 'source', base, null, sha256Bytes(base))];
  for (const n of [1,2,3] as const) {
    const bytes = outputBytes[n-1]!;
    const detail = await sharp(bytes).extract({ left: 1, top: 1, width: 4, height: 4 }).png().toBuffer();
    list.push(item(`reference-${n}`, 'reference', base, String(n) as '1'|'2'|'3', sha256Bytes(base)));
    list.push(item(`output-${n}`, 'output', bytes, String(n) as '1'|'2'|'3', sha256Bytes(bytes)));
    list.push(item(`detail-${n}`, 'detail', detail, String(n) as '1'|'2'|'3', sha256Bytes(bytes), { left: 1, top: 1, right: 5, bottom: 5 }, 4, 4));
  }
  return list;
}

describe('bounded multimodal image packet', () => {
  it('accepts three identical valid outputs with distinct per-variant detail bindings', async () => { const value = await prepareVisionPayload(await images(), record, '{}'); expect(value.imageIds).toHaveLength(10); expect((value.content as any[]).filter((part) => part.type === 'image')).toHaveLength(10); });
  it('rejects corrupt source and reference bytes even when the digest is updated', async () => { for (const id of ['source','reference-2']) { const value = await images(); const image = value.find((entry) => entry.id === id)!; image.bytes = new Uint8Array([0,1,2]); image.sha256 = sha256Bytes(image.bytes); await expect(prepareVisionPayload(value, record, '{}')).rejects.toThrow(/decode|media|image/i); } });
  it('rejects forged dimensions and oversized actual header before transport', async () => { const value = await images(); value[0]!.width = 9; await expect(prepareVisionPayload(value, record, '{}')).rejects.toThrow(/media|image/i); const oversized = await images(); oversized[0]!.bytes = await png(50, 11, 10); oversized[0]!.sha256 = sha256Bytes(oversized[0]!.bytes); await expect(prepareVisionPayload(oversized, record, '{}')).rejects.toThrow(/media|image/i); });
  it('rejects missing detail and wrong-variant derivative', async () => { const missing = (await images()).filter((entry) => entry.id !== 'detail-3'); await expect(prepareVisionPayload(missing, record, '{}')).rejects.toMatchObject({ code: 'REVIEW_IMAGE_COVERAGE' }); const wrong = await images(true); wrong.find((entry) => entry.id === 'detail-1')!.derivedFromSha256 = wrong.find((entry) => entry.id === 'output-2')!.sha256; await expect(prepareVisionPayload(wrong, record, '{}')).rejects.toMatchObject({ code: 'REVIEW_DETAIL_CROP_INVALID' }); });
  it('rejects absent qualified image limits', async () => { await expect(prepareVisionPayload(await images(), { ...record, qualification: { runtimeQualified: true, artifact: { runtimeSettings: {} } } }, '{}')).rejects.toMatchObject({ code: 'REVIEW_VISION_UNQUALIFIED' }); });
});
