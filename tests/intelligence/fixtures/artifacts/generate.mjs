import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = dirname(fileURLToPath(import.meta.url));
const width = 16;
const height = 12;
const canvas = (paint) => {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const rgba = paint(x, y);
    for (let channel = 0; channel < 4; channel++) pixels[i + channel] = rgba[channel];
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } });
};
const fixtures = {
  'reference.png': () => canvas(() => [255, 255, 255, 255]).png().toBuffer(),
  'correct.jpg': () => canvas((x, y) => x >= 4 && x < 12 && y >= 3 && y < 9 ? [255, 0, 0, 255] : [255, 255, 255, 255]).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer(),
  'disguised.jpg': () => canvas(() => [0, 255, 0, 255]).png().toBuffer(),
  'transparent.png': () => canvas(() => [0, 0, 0, 0]).png().toBuffer(),
  'blank.png': () => canvas(() => [255, 255, 255, 255]).png().toBuffer(),
  'flat.png': () => canvas((x, y) => x >= 4 && x < 12 && y >= 3 && y < 9 ? [0, 0, 255, 255] : [255, 255, 255, 255]).png().toBuffer(),
  'misplaced.png': () => canvas((x, y) => x < 8 && y >= 6 ? [0, 0, 255, 255] : [255, 255, 255, 255]).png().toBuffer(),
  'background-changed.png': () => canvas((x, y) => x >= 4 && x < 12 && y >= 3 && y < 9 ? [0, 0, 255, 255] : [0, 0, 0, 255]).png().toBuffer(),
  'variant-2.png': () => canvas((x, y) => x >= 4 && x < 12 && y >= 3 && y < 9 ? [0, 255, 0, 255] : [255, 255, 255, 255]).png().toBuffer(),
  'variant-3.png': () => canvas((x, y) => x >= 4 && x < 12 && y >= 3 && y < 9 ? [255, 0, 0, 255] : [255, 255, 255, 255]).png().toBuffer(),
  'wrong-width.png': () => sharp({ create: { width: 17, height, channels: 4, background: '#ff0000' } }).png().toBuffer(),
};
const hashes = {};
for (const [name, build] of Object.entries(fixtures)) {
  const bytes = await build();
  await writeFile(join(dir, name), bytes);
  hashes[name] = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const truncated = (await fixtures['correct.jpg']()).subarray(0, 90);
await writeFile(join(dir, 'truncated.jpg'), truncated);
hashes['truncated.jpg'] = { bytes: truncated.byteLength, sha256: createHash('sha256').update(truncated).digest('hex') };
const bomb = Buffer.from(await fixtures['blank.png']());
bomb.writeUInt32BE(100000, 16);
bomb.writeUInt32BE(100000, 20);
let crc = 0xffffffff;
for (const byte of bomb.subarray(12, 29)) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
}
bomb.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
await writeFile(join(dir, 'bomb.png'), bomb);
hashes['bomb.png'] = { bytes: bomb.byteLength, sha256: createHash('sha256').update(bomb).digest('hex') };
const empty = Buffer.alloc(0);
await writeFile(join(dir, 'empty.png'), empty);
hashes['empty.png'] = { bytes: 0, sha256: createHash('sha256').update(empty).digest('hex') };
await writeFile(join(dir, 'digests.json'), JSON.stringify(hashes, null, 2) + '\n');
