import { foundationPackage, RenderRequestSchema, type RenderRequest } from '@ne-psd/contracts';

export type { RenderRequest } from '@ne-psd/contracts';
export * from './types.js';

export function parseRequest(input: unknown): RenderRequest {
  const request = RenderRequestSchema.parse(input);
  const path = request.stagingDirectory.replaceAll('\\', '/');
  if (path.split('/').some((segment) => segment === '..') || path.includes('\0')) {
    throw new Error('stagingDirectory escapes its trusted root');
  }
  return request;
}

export function photoshopFoundation(): ReturnType<typeof foundationPackage> {
  return foundationPackage('@ne-psd/photoshop');
}
