import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import {
  canonicalize, bundleDigest, EvidenceBundleManifestSchema, JobSpecSchema,
  RenderEvidenceSchema, ReviewPolicySchema, sha256Bytes, sha256Json,
  type EvidenceBundleManifest, type JobSpec, type RenderEvidence, type ReviewPolicy,
} from '@ne-psd/contracts';

export type TrustedAttemptState = {
  job: JobSpec;
  currentAttempt: 1 | 2;
  sealed: true;
  sealedEvidenceSha256: string;
};
export type TrustedAttemptReader = (jobId: string, assetId: string, attempt: 1 | 2) => Promise<TrustedAttemptState | null>;
export type EvidenceReadLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
export type EvidenceSnapshot = {
  readonly evidenceSha256: string;
  readonly job: JobSpec;
  readonly manifest: EvidenceBundleManifest;
  readonly evidence: RenderEvidence;
  readonly policy: ReviewPolicy;
  getBytes(relativePath: string): Uint8Array;
  assertUnchanged(): Promise<void>;
};

const fail = (reason: string): never => { throw new Error(`EVIDENCE_INVALID: ${reason}`); };
const key = (path: string) => path.normalize('NFKC').toLocaleLowerCase('en-US');
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function validatePortablePath(path: string): void {
  if (!path || path !== path.normalize('NFC') || isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || path.includes('\0')) fail(`unsafe path: ${path}`);
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) fail(`unsafe path: ${path}`);
  }
}

async function readBoundFile(root: string, path: string, declaredBytes: number, maxFileBytes: number): Promise<Uint8Array> {
  validatePortablePath(path);
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) fail(`path escapes bundle: ${path}`);
  let current = candidate;
  while (current !== root) {
    const info = await lstat(current).catch(() => fail(`missing path: ${path}`));
    if (info.isSymbolicLink()) fail(`symlink in path: ${path}`);
    current = dirname(current);
  }
  const physical = await realpath(candidate).catch(() => fail(`missing path: ${path}`));
  if (physical !== root && !physical.startsWith(`${root}${sep}`)) fail(`path escapes bundle: ${path}`);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail(`open failed: ${path}`));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== declaredBytes || before.size > maxFileBytes) fail(`file size before read: ${path}`);
    const bytes = new Uint8Array(declaredBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) fail(`file shortened during read: ${path}`);
      offset += bytesRead;
    }
    const probe = await handle.read(new Uint8Array(1), 0, 1, offset);
    const after = await handle.stat();
    if (probe.bytesRead !== 0 || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
        (await realpath(candidate)) !== physical || (await realpath(root)) !== root) fail(`file changed during read: ${path}`);
    return bytes;
  } finally { await handle.close(); }
}

function assertFileRoles(manifest: EvidenceBundleManifest, evidence: RenderEvidence, policy: ReviewPolicy, sourceSha256: string): void {
  const files = new Map(manifest.files.map((file) => [file.relativePath, file]));
  const requireFile = (path: string, role: typeof manifest.files[number]['role']) => {
    const entry = files.get(path);
    if (!entry || entry.role !== role) fail(`missing ${role} file: ${path}`);
    return entry!;
  };
  const renderFiles = manifest.files.filter((file) => file.role === 'renderEvidence');
  if (renderFiles.length !== 1 || renderFiles[0]?.relativePath !== 'render-evidence.json') fail('render-evidence.json missing or duplicated');
  const artifacts = manifest.files.filter((file) => file.role === 'artifact');
  if (artifacts.length !== 3 || evidence.artifacts.length !== 3) fail('exactly three artifacts required');
  for (const artifact of evidence.artifacts) {
    const file = requireFile(artifact.path, 'artifact');
    if (file.sha256 !== artifact.sha256 || file.bytes !== artifact.bytes) fail(`artifact binding: ${artifact.path}`);
  }
  requireFile(evidence.documentTracePath, 'trace'); requireFile(evidence.toolTracePath, 'trace');
  if (evidence.documentTracePath === evidence.toolTracePath) fail('trace files must be distinct');
  const tracePaths = new Set([evidence.documentTracePath, evidence.toolTracePath]);
  for (const file of manifest.files.filter((item) => item.role === 'trace')) if (!tracePaths.has(file.relativePath)) fail(`unknown trace: ${file.relativePath}`);
  if (evidence.checks.length === 0 || evidence.checks.some((check) => !check.passed)) fail('deterministic checks missing or failed');
  for (const check of evidence.checks) requireFile(check.evidencePath, 'check');
  const referencedChecks = new Set(evidence.checks.map((check) => check.evidencePath));
  for (const file of manifest.files.filter((item) => item.role === 'check')) if (!referencedChecks.has(file.relativePath)) fail(`unknown check report: ${file.relativePath}`);
  const visions = manifest.visionInputs;
  if (new Set(visions.map((item) => item.id)).size !== visions.length) fail('duplicate vision input ID');
  const source = visions.filter((item) => item.role === 'source');
  if (source.length !== 1 || source[0]?.variantId !== null || (source[0]?.derivedFromSha256 !== sourceSha256 && source[0]?.sha256 !== sourceSha256)) fail('source image binding');
  if (visions.some((item) => item.role !== 'source' && item.variantId === null)) fail('variant image binding');
  for (const variantId of ['1', '2', '3'] as const) {
    const artifact = evidence.artifacts.find((item) => item.variantId === variantId)!;
    const outputs = visions.filter((item) => item.role === 'output' && item.variantId === variantId);
    if (outputs.length !== 1 || outputs[0]?.relativePath !== artifact.path || outputs[0]?.sha256 !== artifact.sha256) fail(`output image binding: ${variantId}`);
    if (visions.filter((item) => item.role === 'reference' && item.variantId === variantId).length !== 1) fail(`reference image missing: ${variantId}`);
    const details = visions.filter((item) => item.role === 'detail' && item.variantId === variantId);
    if (details.length === 0 || details.some((item) => item.derivedFromSha256 !== artifact.sha256 || item.crop === null)) fail(`detail image binding: ${variantId}`);
  }
  for (const input of visions) {
    const file = requireFile(input.relativePath, input.role === 'output' ? 'artifact' : 'imageInput');
    if (file!.sha256 !== input.sha256) fail(`vision image digest: ${input.id}`);
    if (input.role !== 'detail' && input.crop !== null) fail(`unexpected image crop: ${input.id}`);
  }
  const indexedImages = new Set(visions.map((input) => input.relativePath));
  // One non-review image may be the contact sheet retained for operator review.
  if (manifest.files.filter((item) => item.role === 'imageInput' && !indexedImages.has(item.relativePath)).length > 1) fail('unindexed images exceed contact sheet');
  if (policy.visualGate === 'humanPerAsset' && manifest.files.filter((file) => file.role === 'humanAttestation').length !== 1) fail('manual attestation file missing');
  if (policy.visualGate !== 'humanPerAsset' && manifest.files.some((file) => file.role === 'humanAttestation')) fail('unexpected manual attestation');
}

export class EvidenceValidator {
  constructor(private readonly readState: TrustedAttemptReader, private readonly limits: EvidenceReadLimits) {
    if (![limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes].every((n) => Number.isSafeInteger(n) && n > 0)) fail('trusted read limits invalid');
  }

  async validate(input: { bundleRoot: string; manifest: unknown; evidence: unknown; policy: unknown }): Promise<EvidenceSnapshot> {
    const manifest = freezeDeep(EvidenceBundleManifestSchema.parse(input.manifest));
    const evidence = freezeDeep(RenderEvidenceSchema.parse(input.evidence));
    const policy = freezeDeep(ReviewPolicySchema.parse(input.policy));
    const state = await this.readState(manifest.jobId, manifest.assetId, manifest.attempt);
    if (!state || state.sealed !== true || state.currentAttempt !== manifest.attempt) fail('trusted seal or current attempt missing');
    const job = freezeDeep(JobSpecSchema.parse(state!.job));
    const asset = job.assets.find((item) => item.assetId === manifest.assetId);
    if (!asset || job.jobId !== manifest.jobId || evidence.jobId !== job.jobId || evidence.assetId !== asset.assetId || evidence.attempt !== manifest.attempt) fail('job/asset/attempt binding');
    if (evidence.profileSha256 !== job.profile.profileSha256 || evidence.sourceSha256 !== asset!.source.sha256 || evidence.toolSchemaSha256 !== job.profile.toolSchemaSha256) fail('source/profile/tool binding');
    if (policy.policySha256 !== job.reviewPolicySha256 || sha256Json(policy, { excludeKeys: ['policySha256'] }) !== policy.policySha256) fail('review policy binding');
    const evidenceSha256 = bundleDigest(manifest);
    if (state!.sealedEvidenceSha256 !== evidenceSha256) fail('sealed manifest digest mismatch');
    if (manifest.files.length > this.limits.maxFiles || manifest.files.some((file) => file.bytes > this.limits.maxFileBytes) || manifest.files.reduce((total, file) => total + file.bytes, 0) > this.limits.maxTotalBytes) fail('manifest exceeds trusted read limits');
    const root = await realpath(input.bundleRoot).catch(() => fail('bundle root missing'));
    if (root !== resolve(input.bundleRoot)) fail('bundle root symlink');
    const seen = new Set<string>();
    for (const file of manifest.files) { validatePortablePath(file.relativePath); const normalized = key(file.relativePath); if (seen.has(normalized)) fail(`case or Unicode path collision: ${file.relativePath}`); seen.add(normalized); }
    assertFileRoles(manifest, evidence, policy, asset!.source.sha256);
    const retained = new Map<string, Uint8Array>();
    for (const file of manifest.files) {
      const bytes = await readBoundFile(root, file.relativePath, file.bytes, this.limits.maxFileBytes);
      if (bytes.byteLength !== file.bytes || sha256Bytes(bytes) !== file.sha256) fail(`file digest or size: ${file.relativePath}`);
      retained.set(file.relativePath, bytes);
    }
    const renderBytes = retained.get('render-evidence.json')!;
    let diskEvidence: unknown;
    try { diskEvidence = RenderEvidenceSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(renderBytes))); } catch { fail('render-evidence.json invalid'); }
    if (canonicalize(diskEvidence) !== canonicalize(evidence)) fail('render evidence differs from sealed file');
    const snapshot: EvidenceSnapshot = {
      evidenceSha256, job, manifest, evidence, policy,
      getBytes(path) { const bytes = retained.get(path); if (!bytes) fail(`unlisted file: ${path}`); return Uint8Array.from(bytes!); },
      async assertUnchanged() {
        if ((await realpath(input.bundleRoot).catch(() => null)) !== root) fail('bundle root changed');
        const current = await readStateAgain();
        if (!current || current.sealed !== true || current.currentAttempt !== manifest.attempt || current.sealedEvidenceSha256 !== evidenceSha256 || canonicalize(JobSpecSchema.parse(current.job)) !== canonicalize(job)) fail('trusted seal changed');
        for (const file of manifest.files) {
          const bytes = await readBoundFile(root, file.relativePath, file.bytes, limits.maxFileBytes);
          if (bytes.byteLength !== file.bytes || sha256Bytes(bytes) !== file.sha256 || sha256Bytes(bytes) !== sha256Bytes(retained.get(file.relativePath)!)) fail(`file changed: ${file.relativePath}`);
        }
      },
    };
    const readStateAgain = () => this.readState(manifest.jobId, manifest.assetId, manifest.attempt);
    const limits = this.limits;
    return Object.freeze(snapshot);
  }
}
