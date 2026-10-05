import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { PhotoshopBackendV2 } from '@ne-psd/contracts';
import { createPhotoshopBackendV2, type BackendV2Options } from './backend-v2.js';
import { McpClient, buildPinnedLaunchParameters, createPinnedSdkTransport, type ToolTransport } from './mcp-client.js';
import { buildToolMap, type QualifiedToolBinding, type ToolDefinition } from './tool-map.js';
import { SessionLock } from './session-lock.js';

const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_OPERATIONS = [
  'scale', 'translate', 'place', 'replaceContents', 'setClipping', 'setVisibility',
  'export', 'convertProfile', 'resize', 'flatten',
] as const;

export type ProductionPhotoshopRuntimeOptions = {
  nodeExecutable: string;
  serverEntry: string;
  explicitArgs: readonly string[];
  installationId: string;
  installationDigest: string;
  processStartIdentity: string;
  lockRoot: string;
  toolSchemaDigest: string;
  templateRoots: readonly string[];
  sourceRoots: readonly string[];
  evidenceRoots: readonly string[];
};

export type ProductionPhotoshopRuntime = {
  lock: SessionLock;
  backend: PhotoshopBackendV2;
  schemaDigest: string;
  close(): Promise<void>;
};

export type ProductionRuntimeErrorCode =
  | 'PRODUCTION_OPTIONS_INVALID'
  | 'PRODUCTION_ROOT_INVALID'
  | 'PRODUCTION_ROOT_OVERLAP'
  | 'PRODUCTION_COMPOSITION_INVALID'
  | 'LIVE_TOOL_BINDINGS_UNAVAILABLE'
  | 'LINK_SCAN_UNAVAILABLE'
  | 'TRANSPORT_CLOSE_FAILED';

export class ProductionRuntimeError extends Error {
  readonly name = 'ProductionRuntimeError';
  readonly category = 'capability' as const;
  readonly retryable = false;
  constructor(readonly code: ProductionRuntimeErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

function fail(code: ProductionRuntimeErrorCode, message: string): never {
  throw new ProductionRuntimeError(code, message);
}

function inside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

async function canonicalDirectory(value: string, name: string): Promise<string> {
  if (!value || !isAbsolute(value) || value.includes('\0')) fail('PRODUCTION_ROOT_INVALID', `${name} must be an absolute path`);
  let canonical: string;
  try {
    const info = await lstat(value);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('PRODUCTION_ROOT_INVALID', `${name} must be a real directory`);
    // macOS commonly exposes /tmp through a /private/tmp alias. The
    // canonical identity is the realpath; requiring lexical equality would
    // reject a valid root before the containment checks can use that identity.
    canonical = await realpath(value);
    const lexical = resolve(value);
    const anchor = parse(lexical).root;
    let current = anchor;
    for (const component of relative(anchor, lexical).split(sep).filter(Boolean)) {
      current = resolve(current, component);
      const part = await lstat(current);
      if (part.isSymbolicLink()) fail('PRODUCTION_ROOT_INVALID', `${name} traverses a symlink`);
    }
  } catch (error) {
    if (error instanceof ProductionRuntimeError) throw error;
    fail('PRODUCTION_ROOT_INVALID', `${name} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return canonical;
}

type ValidatedRoots = { lockRoot: string; templateRoots: string[]; sourceRoots: string[]; evidenceRoots: string[] };

async function validateRoots(options: ProductionPhotoshopRuntimeOptions): Promise<ValidatedRoots> {
  const groups: Array<[string, readonly string[]]> = [
    ['templateRoots', options.templateRoots],
    ['sourceRoots', options.sourceRoots],
    ['evidenceRoots', options.evidenceRoots],
  ];
  const validated: Record<string, string[]> = { templateRoots: [], sourceRoots: [], evidenceRoots: [] };
  const roots: string[] = [];
  for (const [name, values] of groups) {
    if (!Array.isArray(values) || values.length === 0) fail('PRODUCTION_ROOT_INVALID', `${name} must not be empty`);
    for (const [index, value] of values.entries()) {
      const canonical = await canonicalDirectory(value, `${name}[${index}]`);
      roots.push(canonical);
      validated[name]!.push(canonical);
    }
  }
  const unique = new Set(roots);
  if (unique.size !== roots.length) fail('PRODUCTION_ROOT_OVERLAP', 'configured roots overlap');
  for (let left = 0; left < roots.length; left += 1) for (let right = left + 1; right < roots.length; right += 1) {
    if (inside(roots[left]!, roots[right]!) || inside(roots[right]!, roots[left]!)) fail('PRODUCTION_ROOT_OVERLAP', 'configured roots overlap');
  }
  const lockRoot = await canonicalDirectory(options.lockRoot, 'lockRoot');
  if (roots.some((root) => inside(root, lockRoot) || inside(lockRoot, root))) fail('PRODUCTION_ROOT_OVERLAP', 'lockRoot overlaps a configured root');
  return { lockRoot, templateRoots: validated.templateRoots!, sourceRoots: validated.sourceRoots!, evidenceRoots: validated.evidenceRoots! };
}

function validateOptions(options: ProductionPhotoshopRuntimeOptions): void {
  if (!options || typeof options !== 'object') fail('PRODUCTION_OPTIONS_INVALID', 'options are required');
  if (!options.installationId || !options.processStartIdentity) fail('PRODUCTION_OPTIONS_INVALID', 'installation identity is required');
  if (!SHA256.test(options.installationDigest)) fail('PRODUCTION_OPTIONS_INVALID', 'installationDigest must be lowercase SHA-256');
  if (!SHA256.test(options.toolSchemaDigest)) fail('PRODUCTION_OPTIONS_INVALID', 'toolSchemaDigest must be lowercase SHA-256');
  if (!Array.isArray(options.explicitArgs)) fail('PRODUCTION_OPTIONS_INVALID', 'explicitArgs must be an array');
  buildPinnedLaunchParameters({ nodeExecutable: options.nodeExecutable, serverEntry: options.serverEntry, explicitArgs: options.explicitArgs });
}

function assertLiveBindings(tools: readonly ToolDefinition[], bindings: readonly QualifiedToolBinding[]): ReadonlyMap<import('./tool-map.js').SemanticOperation, import('./tool-map.js').ToolMapEntry> {
  const map = buildToolMap(tools, bindings);
  const missing = REQUIRED_OPERATIONS.filter((operation) => {
    const entry = map.get(operation);
    return !entry || entry.status !== 'qualified' || entry.liveQualified !== true || entry.evidence !== 'live-qualified';
  });
  if (missing.length) fail('LIVE_TOOL_BINDINGS_UNAVAILABLE', `no code-supplied live-qualified bindings for: ${missing.join(', ')}`);
  return map;
}

type TransportFactory = (launch: ReturnType<typeof buildPinnedLaunchParameters>) => Promise<ToolTransport>;
export type ProductionPhotoshopComposition = Omit<BackendV2Options, 'lock'> & {
  assetLinks: NonNullable<BackendV2Options['assetLinks']>;
};
export type ProductionPhotoshopCompositionFactory = ((input: {
  client: McpClient;
  lock: SessionLock;
  toolMap: ReadonlyMap<import('./tool-map.js').SemanticOperation, import('./tool-map.js').ToolMapEntry>;
}) => Promise<ProductionPhotoshopComposition>) & { bindings: readonly QualifiedToolBinding[] };
type ProductionCompositionFactory = ProductionPhotoshopCompositionFactory;

async function assertComposition(value: ProductionPhotoshopComposition, roots: ValidatedRoots): Promise<ProductionPhotoshopComposition> {
  if (!value || typeof value !== 'object') fail('PRODUCTION_COMPOSITION_INVALID', 'composition must return an object');
  if (!value.base || typeof value.base !== 'object' ||
      typeof value.base.capabilities !== 'function' || typeof value.base.inspect !== 'function' || typeof value.base.qualify !== 'function') {
    fail('PRODUCTION_COMPOSITION_INVALID', 'composition base capabilities, inspect and qualify methods are required');
  }
  if (!value.assetLinks || typeof value.assetLinks.readLinks !== 'function') fail('LINK_SCAN_UNAVAILABLE', 'qualified PSD/PSB link scanner is unavailable');
  if (!value.templateLinks || typeof value.templateLinks.readLinks !== 'function') fail('PRODUCTION_COMPOSITION_INVALID', 'qualified template link reader is required');
  if (typeof value.renderOwned !== 'function') fail('PRODUCTION_COMPOSITION_INVALID', 'owned renderer is required');
  if (typeof value.recoveryRuntime !== 'function') fail('PRODUCTION_COMPOSITION_INVALID', 'recovery runtime is required');
  if (typeof value.templateRoot !== 'string' || !isAbsolute(value.templateRoot) || typeof value.templateRootId !== 'string' || !value.templateRootId) {
    fail('PRODUCTION_COMPOSITION_INVALID', 'canonical template root and identity are required');
  }
  if (typeof value.contextRoot !== 'string' || !isAbsolute(value.contextRoot)) fail('PRODUCTION_COMPOSITION_INVALID', 'canonical recovery context root is required');
  const templateRoot = await canonicalDirectory(value.templateRoot, 'composition.templateRoot');
  const contextRoot = await canonicalDirectory(value.contextRoot, 'composition.contextRoot');
  if (!roots.templateRoots.some((root) => inside(root, templateRoot))) fail('PRODUCTION_COMPOSITION_INVALID', 'composition.templateRoot is outside configured template roots');
  if (!roots.evidenceRoots.some((root) => inside(root, contextRoot))) fail('PRODUCTION_COMPOSITION_INVALID', 'composition.contextRoot is outside configured evidence roots');
  if (roots.sourceRoots.some((root) => inside(root, templateRoot) || inside(templateRoot, root)) ||
      roots.sourceRoots.some((root) => inside(root, contextRoot) || inside(contextRoot, root)) ||
      inside(templateRoot, contextRoot) || inside(contextRoot, templateRoot)) {
    fail('PRODUCTION_ROOT_OVERLAP', 'composition roots overlap configured source/template roots');
  }
  return value;
}

async function createRuntime(options: ProductionPhotoshopRuntimeOptions, transportFactory: TransportFactory, compose?: ProductionCompositionFactory): Promise<ProductionPhotoshopRuntime> {
  validateOptions(options);
  const roots = await validateRoots(options);
  const { lockRoot } = roots;
  const launch = buildPinnedLaunchParameters({ nodeExecutable: options.nodeExecutable, serverEntry: options.serverEntry, explicitArgs: options.explicitArgs });
  const lock = new SessionLock({
    lockPath: join(lockRoot, 'installation.lock'),
    installationPath: options.installationId,
    hostId: `${process.platform}:${process.env.HOSTNAME ?? 'unknown'}`,
    installationDigest: options.installationDigest,
    processStartIdentity: options.processStartIdentity,
  });
  const transport = await transportFactory(launch);
  try {
    const bootstrap = new McpClient({ transport, toolMap: new Map(), schemaDigest: options.toolSchemaDigest, sessionLock: lock });
    const observedDigest = await lock.runExclusive('production-bootstrap', () => bootstrap.listSchemaDigest());
    const listed = bootstrap.listedTools;
    const toolMap = assertLiveBindings(listed, compose?.bindings ?? []);
    if (!compose) fail('LIVE_TOOL_BINDINGS_UNAVAILABLE', 'qualified Photoshop document adapter composition is unavailable');
    const client = new McpClient({ transport, toolMap, schemaDigest: observedDigest, sessionLock: lock });
    const composed = await assertComposition(await compose({ client, lock, toolMap }), roots);
    const backend = createPhotoshopBackendV2({ ...composed, lock });
    return {
      lock,
      backend,
      schemaDigest: observedDigest,
      close: async () => {
        if (lock.journalMetadata) {
          if (lock.journalMetadata.unknownMutation || lock.journalMetadata.unsettledOperations !== 0) throw new ProductionRuntimeError('LIVE_TOOL_BINDINGS_UNAVAILABLE', 'cannot close while the installation recovery barrier is active');
          const release = await lock.release();
          if (!release.released) throw new ProductionRuntimeError('LIVE_TOOL_BINDINGS_UNAVAILABLE', `installation release was not confirmed: ${release.reason}`);
        }
        try { await transport.close?.(); } catch (error) { throw new ProductionRuntimeError('TRANSPORT_CLOSE_FAILED', error instanceof Error ? error.message : String(error)); }
      },
    };
  } catch (error) {
    const retainBarrier = Boolean(lock.journalMetadata?.unknownMutation || lock.journalMetadata?.unsettledOperations);
    if (!retainBarrier && lock.journalMetadata) {
      try { await lock.reconcile(); } catch { /* preserve a failed release barrier */ }
    }
    try { await transport.close?.(); } catch { /* preserve the original capability/error boundary */ }
    throw error;
  }
}

export function createProductionPhotoshopRuntime(options: ProductionPhotoshopRuntimeOptions, compose: ProductionPhotoshopCompositionFactory): Promise<ProductionPhotoshopRuntime> {
  return createRuntime(options, createPinnedSdkTransport, compose);
}

/** Test seam: injects a fake transport; never exported from the package entrypoint. */
export function createProductionPhotoshopRuntimeForTransport(options: ProductionPhotoshopRuntimeOptions, transport: ToolTransport, compose?: ProductionCompositionFactory): Promise<ProductionPhotoshopRuntime> {
  return createRuntime(options, async () => transport, compose);
}
