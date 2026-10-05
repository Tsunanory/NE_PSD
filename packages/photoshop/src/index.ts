import { foundationPackage, RenderRequestSchema, type RenderRequest } from '@ne-psd/contracts';

export type { RenderRequest } from '@ne-psd/contracts';
export * from './types.js';
export * from './session-lock.js';
export * from './selectors.js';
export * from './inspection.js';
export * from './backend.js';
export * from './backend-v2.js';
export * from './recovery.js';
export type { AssetLinkScan, AssetLinkScanner } from './prepare-v2.js';
export type { LinkedResource, QualifiedLinkOperation } from './working-copy.js';
export {
  McpClient,
  McpClientError,
  buildPinnedLaunchParameters,
  createPinnedSdkTransport,
} from './mcp-client.js';
export type { PinnedLaunchParameters, ToolCall, ToolTransport } from './mcp-client.js';
export { buildToolMap, toolSchemaDigest } from './tool-map.js';
export type {
  JsonSchema,
  QualifiedToolBinding,
  SemanticOperation,
  ToolDefinition,
  ToolMapEntry,
  ToolSemantics,
} from './tool-map.js';
export {
  createProductionPhotoshopRuntime,
  ProductionRuntimeError,
} from './production.js';
export type {
  ProductionPhotoshopRuntime,
  ProductionPhotoshopRuntimeOptions,
  ProductionPhotoshopComposition,
  ProductionPhotoshopCompositionFactory,
  ProductionRuntimeErrorCode,
} from './production.js';

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
