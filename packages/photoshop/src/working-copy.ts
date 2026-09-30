import { createHash } from 'node:crypto';
import { copyFile as nativeCopyFile, mkdir as nativeMkdir, readFile as nativeReadFile, realpath as nativeRealpath, rm as nativeRm } from 'node:fs/promises';
import { basename as posixBasename, dirname as posixDirname, isAbsolute as posixIsAbsolute, join as posixJoin, relative as posixRelative, resolve as posixResolve } from 'node:path';

export type WorkingCopyErrorCode =
  | 'ATTEMPT_DIRECTORY_EXISTS'
  | 'WORKING_COPY_SOURCE_UNTRUSTED'
  | 'SOURCE_MISSING'
  | 'SOURCE_HASH_MISMATCH'
  | 'LINKED_SOURCE_UNISOLATED';

export type WorkingCopyEvidence = Readonly<Record<string, unknown>>;

export class WorkingCopyError extends Error {
  readonly name = 'WorkingCopyError';
  constructor(readonly code: WorkingCopyErrorCode, message: string, readonly evidence: WorkingCopyEvidence = {}) {
    super(message);
  }
}

export type LinkedResource = {
  path: string | null;
  sourceKind: 'linked' | 'embedded' | 'unknown';
  identity?: string;
  expectedSha256?: string;
};

export type PathSemantics = {
  canonical(path: string): Promise<string> | string;
  contains(root: string, target: string): boolean;
  resolve(parent: string, child: string): string;
  dirname(path: string): string;
  basename(path: string): string;
  join(parent: string, child: string): string;
  isAbsolute(path: string): boolean;
};

export type WorkingCopyFileSystem = {
  readFile(path: string): Promise<Uint8Array>;
  hash?(path: string): Promise<string>;
  copy(source: string, destination: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove?(path: string): Promise<void>;
};

export type QualifiedLinkOperation = {
  readLinks(path: string): Promise<readonly LinkedResource[]>;
  relink?(jobOwnedParent: string, originalSource: string, jobOwnedSource: string): Promise<void | { acknowledged: true; parentPath: string; originalSource: string; jobOwnedSource: string }>;
  embed?(jobOwnedParent: string): Promise<void | { acknowledged: true; parentPath: string }>;
  verifySelfContained?(path: string): Promise<boolean>;
  /** Test-only call trace is deliberately optional and never used for authorization. */
  calls?: Array<{ parent: string; original: string; copy: string }>;
};

export type PreparedTemplate = {
  path: string;
  sha256: string;
  selfContained: boolean;
};

export type WorkingCopyOptions = {
  masterPath: string;
  trustedRoot: string;
  attemptRoot: string;
  expectedHashes?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  expectedMasterSha256?: string;
  preparedTemplate?: PreparedTemplate;
  operation: QualifiedLinkOperation;
  pathSemantics?: PathSemantics;
  filesystem?: WorkingCopyFileSystem;
};

export type WorkingCopyClosureEntry = {
  originalPath: string;
  copyPath: string;
  sha256: string;
  sourceKind: LinkedResource['sourceKind'] | 'root';
  identity: string;
};

export type WritableTarget = { allowed: true } | { allowed: false; code: 'LINKED_SOURCE_UNISOLATED' };

export type WorkingCopy = {
  attemptRoot: string;
  masterPath: string;
  closure: readonly WorkingCopyClosureEntry[];
  originalHashes: ReadonlyMap<string, string>;
  assertWritableTarget(path: string): Promise<WritableTarget>;
};

const HEX_SHA256 = /^[a-f0-9]{64}$/;

const defaultFileSystem: WorkingCopyFileSystem = {
  readFile: async (path) => nativeReadFile(path),
  hash: async (path) => sha256(path),
  copy: async (source, destination) => nativeCopyFile(source, destination),
  mkdir: async (path, options) => { await nativeMkdir(path, options); },
  exists: async (path) => nativeReadFile(path).then(() => true, () => false),
  remove: async (path) => nativeRm(path, { recursive: true, force: true }),
};

const defaultPaths: PathSemantics = {
  canonical: async (path) => nativeRealpath(path),
  contains: (root, target) => {
    const relative = posixRelative(root, target);
    return relative === '' || (!relative.startsWith('..') && !posixIsAbsolute(relative));
  },
  dirname: (path) => posixDirname(path),
  basename: (path) => posixBasename(path),
  join: (parent, child) => posixJoin(parent, child),
  isAbsolute: (path) => posixIsAbsolute(path),
  resolve: (parent, child) => posixResolve(posixDirname(parent), child),
};

export async function sha256(path: string, fileSystem: Pick<WorkingCopyFileSystem, 'readFile'> = defaultFileSystem): Promise<string> {
  return createHash('sha256').update(await fileSystem.readFile(path)).digest('hex');
}

function mapExpected(input: WorkingCopyOptions['expectedHashes'], path: string, canonicalPath: string): string | undefined {
  if (!input) return undefined;
  if ('get' in input && typeof input.get === 'function') return input.get(path) ?? input.get(canonicalPath);
  const record = input as Readonly<Record<string, string>>;
  return record[path] ?? record[canonicalPath];
}

function safeName(path: string, hash: string, paths: PathSemantics): string {
  const name = paths.basename(path).replaceAll('\0', '').replaceAll('/', '_').replaceAll('\\', '_') || 'resource';
  return `${hash}-${name}`;
}

function linkedError(message: string, evidence: WorkingCopyEvidence): WorkingCopyError {
  return new WorkingCopyError('LINKED_SOURCE_UNISOLATED', message, evidence);
}

function expectedFor(options: WorkingCopyOptions, descriptor: LinkedResource | undefined, rawPath: string, canonicalPath: string): string | undefined {
  return descriptor?.expectedSha256 ?? mapExpected(options.expectedHashes, rawPath, canonicalPath);
}

async function canonicalExisting(path: string, paths: PathSemantics, fileSystem: WorkingCopyFileSystem): Promise<string> {
  if (!(await fileSystem.exists(path))) throw new WorkingCopyError('SOURCE_MISSING', `source does not exist: ${path}`, { path });
  return paths.canonical(path);
}

async function assertTrusted(path: string, trustedRoot: string, paths: PathSemantics, fileSystem: WorkingCopyFileSystem, evidence: WorkingCopyEvidence): Promise<string> {
  let canonical: string;
  try {
    canonical = await canonicalExisting(path, paths, fileSystem);
  } catch (error) {
    if (error instanceof WorkingCopyError) throw error;
    throw linkedError('source cannot be canonicalized', { ...evidence, path });
  }
  if (!paths.contains(trustedRoot, canonical)) throw linkedError('source escapes trusted root', { ...evidence, path, canonicalPath: canonical, trustedRoot });
  return canonical;
}

async function expectedHash(path: string, canonicalPath: string, expected: string | undefined, fileSystem: WorkingCopyFileSystem): Promise<string> {
  const actual = fileSystem.hash ? await fileSystem.hash(path) : await sha256(path, fileSystem);
  if (!HEX_SHA256.test(actual)) throw new WorkingCopyError('SOURCE_HASH_MISMATCH', 'source hash is not SHA-256', { path, actual });
  if (expected !== undefined && actual !== expected) throw new WorkingCopyError('SOURCE_HASH_MISMATCH', 'source hash differs from expected digest', { path, canonicalPath, expected, actual });
  return actual;
}

function identityOf(path: string, descriptor?: LinkedResource): string {
  return descriptor?.identity ?? path;
}

function targetPath(attemptRoot: string, hash: string, originalPath: string, paths: PathSemantics): string {
  return paths.join(attemptRoot, safeName(originalPath, hash, paths));
}

export async function assertWritableTarget(path: string, attemptRoot: string, pathSemantics: PathSemantics = defaultPaths): Promise<WritableTarget> {
  let canonicalTarget: string;
  try {
    canonicalTarget = await pathSemantics.canonical(path);
  } catch {
    canonicalTarget = path;
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await pathSemantics.canonical(attemptRoot);
  } catch {
    canonicalRoot = attemptRoot;
  }
  return pathSemantics.contains(canonicalRoot, canonicalTarget) ? { allowed: true } : { allowed: false, code: 'LINKED_SOURCE_UNISOLATED' };
}

export async function createWorkingCopy(options: WorkingCopyOptions): Promise<WorkingCopy> {
  const fileSystem = options.filesystem ?? defaultFileSystem;
  const paths = options.pathSemantics ?? defaultPaths;
  const trustedRoot = await paths.canonical(options.trustedRoot);
  const masterPath = await assertTrusted(options.masterPath, trustedRoot, paths, fileSystem, { role: 'master' });
  const masterExpected = options.expectedMasterSha256 ?? mapExpected(options.expectedHashes, options.masterPath, masterPath);
  const masterHash = await expectedHash(options.masterPath, masterPath, masterExpected, fileSystem);
  const prepared = options.preparedTemplate;
  let selectedPath = options.masterPath;
  let selectedCanonical = masterPath;
  let selectedHash = masterHash;
  if (prepared?.selfContained) {
    const preparedCanonical = await assertTrusted(prepared.path, trustedRoot, paths, fileSystem, { role: 'prepared' });
    if (!options.operation.verifySelfContained || !(await options.operation.verifySelfContained(prepared.path))) {
      throw linkedError('prepared template self-contained status is not qualified', { role: 'prepared', path: prepared.path, verifier: 'required' });
    }
    selectedHash = await expectedHash(prepared.path, preparedCanonical, prepared.sha256, fileSystem);
    selectedPath = prepared.path;
    selectedCanonical = preparedCanonical;
  }

  const attemptRoot = paths.canonical ? await Promise.resolve(paths.canonical(options.attemptRoot)).catch(() => options.attemptRoot) : options.attemptRoot;
  try {
    await fileSystem.mkdir(paths.dirname(attemptRoot), { recursive: true });
    await fileSystem.mkdir(attemptRoot, { recursive: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EEXIST') throw new WorkingCopyError('ATTEMPT_DIRECTORY_EXISTS', 'attempt directory must be fresh and exclusive', { attemptRoot });
    throw error;
  }

  const nodes = new Map<string, WorkingCopyClosureEntry>();
  const canonicalAliases = new Map<string, string>();
  const identityToCanonical = new Map<string, string>();
  const edges = new Map<string, Array<{ descriptor: LinkedResource; originalPath: string; identity: string }>>();
  const originalHashes = new Map<string, string>([[masterPath, masterHash]]);
  if (selectedCanonical !== masterPath) originalHashes.set(selectedCanonical, selectedHash);
  const queue: Array<{ rawPath: string; canonicalPath: string; hash: string; sourceKind: LinkedResource['sourceKind'] | 'root'; descriptor?: LinkedResource; ancestors: readonly string[] }> = [{ rawPath: selectedPath, canonicalPath: selectedCanonical, hash: selectedHash, sourceKind: 'root', ancestors: [] }];

  try {
    while (queue.length) {
      const node = queue.shift()!;
      const nodeIdentity = identityOf(node.canonicalPath, node.descriptor);
      if (node.ancestors.includes(node.canonicalPath) || node.ancestors.includes(nodeIdentity)) throw linkedError('linked resource cycle detected', { path: node.canonicalPath, identity: nodeIdentity });
      const identityOwner = identityToCanonical.get(nodeIdentity);
      if (identityOwner && identityOwner !== node.canonicalPath) {
        canonicalAliases.set(node.canonicalPath, identityOwner);
        continue;
      }
      if (nodes.has(node.canonicalPath)) continue;
      identityToCanonical.set(nodeIdentity, node.canonicalPath);
      const entry: WorkingCopyClosureEntry = { originalPath: node.canonicalPath, copyPath: targetPath(attemptRoot, node.hash, node.canonicalPath, paths), sha256: node.hash, sourceKind: node.sourceKind, identity: identityOf(node.canonicalPath, node.descriptor) };
      nodes.set(node.canonicalPath, entry);
      originalHashes.set(node.canonicalPath, node.hash);
      const links = await options.operation.readLinks(node.rawPath);
      const nodeEdges: Array<{ descriptor: LinkedResource; originalPath: string; identity: string }> = [];
      for (const descriptor of links) {
        if (descriptor.sourceKind === 'embedded') continue;
        if (descriptor.sourceKind !== 'linked' || descriptor.path === null) throw linkedError('linkage is unknown or not mutable', { parentPath: node.canonicalPath, path: descriptor.path, sourceKind: descriptor.sourceKind });
        const rawLinkedPath = paths.isAbsolute(descriptor.path) ? descriptor.path : paths.resolve(node.rawPath, descriptor.path);
        let linkedCanonical: string;
        try {
          linkedCanonical = await assertTrusted(rawLinkedPath, trustedRoot, paths, fileSystem, { parentPath: node.canonicalPath, path: rawLinkedPath });
        } catch (error) {
          if (error instanceof WorkingCopyError && error.code === 'SOURCE_MISSING') throw linkedError('linked source is missing or cannot be resolved', { parentPath: node.canonicalPath, path: rawLinkedPath });
          throw error;
        }
        const identity = identityOf(linkedCanonical, descriptor);
        if (node.canonicalPath === linkedCanonical || nodeIdentity === identity || node.ancestors.includes(identity) || node.ancestors.includes(linkedCanonical)) throw linkedError('linked resource cycle detected', { parentPath: node.canonicalPath, path: linkedCanonical, identity });
        const linkedHash = await expectedHash(rawLinkedPath, linkedCanonical, expectedFor(options, descriptor, rawLinkedPath, linkedCanonical), fileSystem);
        nodeEdges.push({ descriptor, originalPath: linkedCanonical, identity });
        queue.push({ rawPath: rawLinkedPath, canonicalPath: linkedCanonical, hash: linkedHash, sourceKind: descriptor.sourceKind, descriptor, ancestors: [...node.ancestors, node.canonicalPath, identityOf(node.canonicalPath, node.descriptor)] });
      }
      edges.set(node.canonicalPath, nodeEdges);
    }

    const byteSourceHashes = new Map<string, string>();
    for (const entry of nodes.values()) { byteSourceHashes.set(entry.originalPath, createHash('sha256').update(await fileSystem.readFile(entry.originalPath)).digest('hex')); await fileSystem.copy(entry.originalPath, entry.copyPath); }
    const copiedByCanonicalPath = new Map<string, WorkingCopyClosureEntry>();
    for (const entry of nodes.values()) copiedByCanonicalPath.set(await Promise.resolve(paths.canonical(entry.copyPath)).catch(() => entry.copyPath), entry);
    const mutationProofs = new Map<string, boolean>();
    for (const entry of nodes.values()) {
      const nodeEdges = edges.get(entry.originalPath) ?? [];
      if (!nodeEdges.length) continue;
      const writable = await assertWritableTarget(entry.copyPath, attemptRoot, paths);
      if (!writable.allowed) throw linkedError('parent copy is not job-owned', { parentPath: entry.copyPath });
      if (options.operation.relink) {
        for (const edge of nodeEdges) {
          const target = nodes.get(edge.originalPath) ?? nodes.get(canonicalAliases.get(edge.originalPath) ?? '');
          if (!target) throw linkedError('linked dependency was not copied', { parentPath: entry.copyPath, path: edge.originalPath });
          const proof = await options.operation.relink(entry.copyPath, edge.originalPath, target.copyPath);
          const exact = proof?.acknowledged === true && proof.parentPath === entry.copyPath && proof.originalSource === edge.originalPath && proof.jobOwnedSource === target.copyPath;
          mutationProofs.set(entry.originalPath, (mutationProofs.get(entry.originalPath) ?? true) && exact);
        }
      } else if (options.operation.embed) {
        const proof = await options.operation.embed(entry.copyPath);
        mutationProofs.set(entry.originalPath, proof?.acknowledged === true && proof.parentPath === entry.copyPath);
      } else {
        throw linkedError('no qualified embed or relink operation is available', { parentPath: entry.copyPath, path: entry.originalPath });
      }
    }

    for (const entry of nodes.values()) {
      // Relinking can mutate the copied file in place. Re-read and hash the
      // bytes of every copied node. A declared/semantic digest never replaces
      // this independent byte-level comparison.
      const rawSourceHash = byteSourceHashes.get(entry.originalPath)!;
      const copiedHash = createHash('sha256').update(await fileSystem.readFile(entry.copyPath)).digest('hex');
      if (copiedHash !== rawSourceHash && mutationProofs.get(entry.originalPath) !== true) throw new WorkingCopyError('SOURCE_HASH_MISMATCH', 'copied parent changed without an acknowledged relink or embed bound to the exact copied closure', { path: entry.copyPath, expected: rawSourceHash, actual: copiedHash, declared: entry.sha256, phase: 'copied-resource' });
      const remaining = await options.operation.readLinks(entry.copyPath);
      for (const descriptor of remaining) {
        if (descriptor.sourceKind === 'embedded') continue;
        if (descriptor.sourceKind !== 'linked' || descriptor.path === null) throw linkedError('re-read linkage is unknown', { parentPath: entry.copyPath, path: descriptor.path });
        const remainingPath = paths.isAbsolute(descriptor.path) ? descriptor.path : paths.resolve(entry.copyPath, descriptor.path);
        const remainingCanonical = await Promise.resolve(paths.canonical(remainingPath)).catch(() => remainingPath);
        if (!paths.contains(attemptRoot, remainingCanonical)) throw linkedError('re-read closure escapes attempt root', { parentPath: entry.copyPath, path: remainingCanonical, attemptRoot });
        const known = copiedByCanonicalPath.get(remainingCanonical);
        if (!known) throw linkedError('re-read closure references an unknown internal resource', { parentPath: entry.copyPath, path: remainingCanonical, attemptRoot });
        const knownCopyCanonical = await Promise.resolve(paths.canonical(known.copyPath)).catch(() => known.copyPath);
        if (knownCopyCanonical !== remainingCanonical) throw linkedError('re-read closure resource identity differs from copied closure', { parentPath: entry.copyPath, path: remainingCanonical, expected: knownCopyCanonical });
        if (descriptor.identity !== undefined && descriptor.identity !== known.identity) throw linkedError('re-read closure resource identity differs from copied closure', { parentPath: entry.copyPath, path: remainingCanonical, expected: known.identity, actual: descriptor.identity });
        if (descriptor.expectedSha256 !== undefined && descriptor.expectedSha256 !== known.sha256) throw new WorkingCopyError('SOURCE_HASH_MISMATCH', 're-read closure digest differs from copied closure', { parentPath: entry.copyPath, path: remainingCanonical, expected: known.sha256, actual: descriptor.expectedSha256 });
      }
    }

    const unchangedEvidence = Object.fromEntries([...originalHashes.entries()].sort(([left], [right]) => left.localeCompare(right)));
    for (const [originalPath, before] of originalHashes) {
      const after = await expectedHash(originalPath, originalPath, undefined, fileSystem);
      if (after !== before) throw new WorkingCopyError('SOURCE_HASH_MISMATCH', 'original source changed during isolation', { path: originalPath, expected: before, actual: after, phase: 'post-isolation', originalHashes: unchangedEvidence });
    }

    const rootEntry = nodes.get(selectedCanonical)!;
    const writable = (path: string): Promise<WritableTarget> => assertWritableTarget(path, attemptRoot, paths);
    return { attemptRoot, masterPath: rootEntry.copyPath, closure: [...nodes.values()], originalHashes, assertWritableTarget: writable };
  } catch (error) {
    try { await fileSystem.remove?.(attemptRoot); } catch { /* best-effort cleanup */ }
    throw error;
  }
}
