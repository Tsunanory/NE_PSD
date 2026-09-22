import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RenderRequestSchema, type RenderRequest } from '@ne-psd/contracts';
import { sceneFixture, type FakeScene } from './fixtures/scenes.js';

export function requestFixture(): RenderRequest {
  const path = resolve(process.cwd(), 'tests/fixtures/contracts/render-request.valid.json');
  return RenderRequestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export { sceneFixture };
export type { FakeScene };
