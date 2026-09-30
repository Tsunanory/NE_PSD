import { sha256Bytes, type VisionInput } from '@ne-psd/contracts';
import sharp from 'sharp';
import type { RegisteredProfile } from '../profiles/profile-registry.js';
import type { MessageContent } from '../transport/model-transport.js';
import { ReviewGateError } from './decision-validator.js';

export type SealedVisionImage = VisionInput & { bytes: Uint8Array };
const ids = ['1', '2', '3'] as const;
const fail = (code: string, reason: string): never => { throw new ReviewGateError(code, reason); };
const positive = (value: string | undefined) => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

/** Only a registry-admitted image runtime with recorded packet limits can receive pixels. */
export async function prepareVisionPayload(images: readonly SealedVisionImage[], record: RegisteredProfile, userText: string): Promise<{ content: MessageContent; imageIds: readonly string[] }> {
  const profile = record.profile;
  const settings = record.qualification?.artifact?.runtimeSettings;
  const maxImages = positive(settings?.visionMaxImages), maxWidth = positive(settings?.visionMaxWidth), maxHeight = positive(settings?.visionMaxHeight), maxPixels = positive(settings?.visionMaxPixels), maxTotalBytes = positive(settings?.visionMaxTotalBytes), maxDecodedBytes = positive(settings?.visionMaxDecodedBytes), maxTotalDecodedBytes = positive(settings?.visionMaxTotalDecodedBytes);
  if (!record.selectable || !record.qualification?.runtimeQualified || !profile.capabilities.vision || settings?.visionInputQualified !== 'true' || !maxImages || !maxWidth || !maxHeight || !maxPixels || !maxTotalBytes || !maxDecodedBytes || !maxTotalDecodedBytes) fail('REVIEW_VISION_UNQUALIFIED', 'selected reviewer lacks measured image-input limits');
  if (images.length === 0 || images.length > maxImages) fail('REVIEW_IMAGE_LIMIT', 'complete image packet exceeds qualified image count');
  if (new Set(images.map((image) => image.id)).size !== images.length) fail('REVIEW_IMAGE_ID_DUPLICATE', 'image IDs must be unique');
  if (images.filter((image) => image.role === 'source').length < 1 || ids.some((id) => images.filter((image) => image.role === 'reference' && image.variantId === id).length < 1 || images.filter((image) => image.role === 'output' && image.variantId === id).length !== 1 || images.filter((image) => image.role === 'detail' && image.variantId === id).length < 1)) fail('REVIEW_IMAGE_COVERAGE', 'source and every reference, output and detail image are required');
  let total = 0, totalDecoded = 0;
  const decoded = new Map<string, Uint8Array>();
  for (const image of images) {
    total += image.bytes.byteLength;
    if (image.bytes.byteLength === 0 || total > maxTotalBytes || image.width > maxWidth || image.height > maxHeight || image.width * image.height > maxPixels || sha256Bytes(image.bytes) !== image.sha256) fail('REVIEW_IMAGE_INVALID', `image ${image.id} exceeds qualification or digest binding`);
    try {
      const bounded = sharp(image.bytes, { limitInputPixels: maxPixels, failOn: 'error' });
      const metadata = await bounded.metadata();
      if (!metadata.width || !metadata.height || metadata.width !== image.width || metadata.height !== image.height || !['jpeg', 'png'].includes(metadata.format ?? '') || metadata.width * metadata.height * 4 > maxDecodedBytes) fail('REVIEW_IMAGE_INVALID', `image ${image.id} actual media disagrees with sealed index`);
      const raster = await bounded.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      totalDecoded += raster.data.byteLength;
      if (raster.info.width !== image.width || raster.info.height !== image.height || raster.data.byteLength > maxDecodedBytes || totalDecoded > maxTotalDecodedBytes) fail('REVIEW_IMAGE_INVALID', `image ${image.id} decoded bytes exceed qualification`);
      decoded.set(image.id, raster.data);
    } catch (error) { if (error instanceof ReviewGateError) throw error; fail('REVIEW_IMAGE_INVALID', `image ${image.id} cannot be fully decoded`); }
  }
  for (const image of images) {
    if (image.role === 'detail') {
      const origin = images.find((candidate) => candidate.role === 'output' && candidate.variantId === image.variantId && candidate.sha256 === image.derivedFromSha256);
      const crop = image.crop;
      if (!origin || !crop) throw new ReviewGateError('REVIEW_DETAIL_CROP_INVALID', `detail ${image.id} is not bound to a full image`);
      if (origin.variantId !== image.variantId || ![crop.left, crop.top, crop.right, crop.bottom].every(Number.isSafeInteger) || crop.left < 0 || crop.top < 0 || crop.right > origin.width || crop.bottom > origin.height || crop.right - crop.left !== image.width || crop.bottom - crop.top !== image.height) throw new ReviewGateError('REVIEW_DETAIL_CROP_INVALID', `detail ${image.id} has invalid crop bounds`);
      const width = crop.right - crop.left, height = crop.bottom - crop.top;
      const parentPixels = decoded.get(origin.id), detailPixels = decoded.get(image.id);
      if (!parentPixels || !detailPixels) throw new ReviewGateError('REVIEW_DETAIL_CROP_INVALID', `detail ${image.id} lacks decoded parent pixels`);
      let matches = true;
      for (let y = 0; y < height && matches; y++) for (let x = 0; x < width && matches; x++) for (let channel = 0; channel < 4; channel++) if (parentPixels[((crop.top + y) * origin.width + crop.left + x) * 4 + channel] !== detailPixels[(y * width + x) * 4 + channel]) { matches = false; break; }
      if (!matches) fail('REVIEW_DETAIL_CROP_MISMATCH', `detail ${image.id} pixels differ from declared origin crop`);
    } else if (image.crop !== null) fail('REVIEW_IMAGE_CROP_INVALID', `full image ${image.id} cannot claim a crop`);
  }
  const content: MessageContent = [{ type: 'text', text: userText }, ...images.map((image) => ({ type: 'image' as const, id: image.id, bytes: image.bytes.slice() }))];
  return { content, imageIds: images.map((image) => image.id) };
}
