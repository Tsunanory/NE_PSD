import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyModel, validateRelativePath, isContainedPath } from '../../packages/intelligence/src/cli/verify-model.js';

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const baseManifest = (artifactPath: string, evidencePath: string) => ({
  profile: { profileId: 'local', provider: 'local-qwen', modelId: 'Qwen3.8-27B', provenance: { kind: 'local', artifactSha256: 'a'.repeat(64), runtimeVersion: 'runtime', chatTemplateSha256: 'b'.repeat(64) }, endpoint: 'http://127.0.0.1:1', quantization: 'Q4_K_M', contextTokens: 4096, maxOutputTokens: 512, capabilities: { jsonSchema: true, vision: false, tools: true } },
  stage: 'runtimeQualified', artifactVerified: true, runtimeQualified: true, evidencePaths: [evidencePath], errors: [], fixture: false,
  artifact: { sourceUrl: 'https://example.test/model', repository: 'model', revision: 'rev', architecture: 'arch', parameters: '27B', license: 'license', usageTerms: 'terms', files: [{ path: artifactPath, bytes: 3, sha256: digest(Buffer.from('abc')) }], quantization: 'Q4_K_M', converterRevision: null, tokenizer: 'tokenizer', chatTemplate: 'template', runtimeBuild: 'runtime', runtimeSettings: {}, shardManifestSha256: null, resources: { os: 'test', hardware: 'test', evidencePaths: [evidencePath] } },
});

describe('verify:model evidence containment', () => {
  it.each(['/absolute/file', 'C:/drive/file', 'C:\\drive\\file', '\\\\server\\share\\file', '../outside', '..\\outside', 'a/../outside', 'a//b', './file', 'a/./b', ''])('rejects unsafe portable relative path %s', (path) => {
    expect(validateRelativePath(path)).toBe(false);
  });

  it('accepts a normalized portable relative path', () => {
    expect(validateRelativePath('evidence/runtime.json')).toBe(true);
  });

  it('accepts a legitimate child and rejects a prefix-only escape independent of slash prefix', () => {
    expect(isContainedPath('/tmp/job', '/tmp/job/evidence.json')).toBe(true);
    expect(isContainedPath('/tmp/job', '/tmp/job-output/evidence.json')).toBe(false);
  });

  it('rejects a final artifact symlink even when its target is inside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-verify-'));
    await writeFile(join(root, 'real.gguf'), 'abc');
    await symlink('real.gguf', join(root, 'link.gguf'));
    await writeFile(join(root, 'runtime.json'), '{}');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(baseManifest('link.gguf', 'runtime.json')));
    const result = await verifyModel({ manifest: join(root, 'manifest.json') });
    expect(result).toMatchObject({ ok: false, code: 'SYMLINK_ARTIFACT_PATH' });
  });

  it('requires runtime evidence paths to be present regular files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-verify-'));
    await writeFile(join(root, 'model.gguf'), 'abc');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(baseManifest('model.gguf', 'missing.json')));
    const result = await verifyModel({ manifest: join(root, 'manifest.json') });
    expect(result).toMatchObject({ ok: false, code: 'EVIDENCE_FILE_MISSING' });
  });
});
