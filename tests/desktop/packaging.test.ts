import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateManifest, prepareResources, verifyBundle } from '../../packaging/runtime-manifest.mjs';

const pe = Buffer.alloc(80); pe.write('MZ'); pe.writeUInt32LE(64, 0x3c); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'NE PSD Тест '));
  const vendor = join(root, 'vendor');
  const staged = join(root, 'staged');
  mkdirSync(join(vendor, 'runtime'), { recursive: true });
  for (const [path, data] of [['runtime/node.exe', pe], ['runtime/mcp.cjs', 'mcp'], ['runtime/node_modules/a/package.json', '{"name":"a","version":"1.0.0","dependencies":{}}'], ['runtime/native/better_sqlite3.node', pe], ['runtime/licenses/a.txt', 'MIT'], ['runtime/fit/cover.action', 'action']] as const) {
    mkdirSync(join(vendor, path, '..'), { recursive: true });
    writeFileSync(join(vendor, path), data);
  }
  mkdirSync(join(vendor, 'evidence'));
  writeFileSync(join(vendor, 'evidence/qualified.txt'), 'qualified synthetic fixture');
  const files = [
    ['runtime/node.exe', pe, 'node', 'standalone-node', '127'],
    ['runtime/mcp.cjs', 'mcp', 'mcp-entry', 'standalone-node', '127'],
    ['runtime/node_modules/a/package.json', '{"name":"a","version":"1.0.0","dependencies":{}}', 'dependency', 'standalone-node', '127'],
    ['runtime/native/better_sqlite3.node', pe, 'native', 'electron', '145'],
    ['runtime/licenses/a.txt', 'MIT', 'license', 'none', 'none'],
    ['runtime/fit/cover.action', 'action', 'fit-resource', 'none', 'none'],
    ['evidence/qualified.txt', 'qualified synthetic fixture', 'evidence', 'none', 'none'],
  ].map(([path, data, role, consumer, abi]) => ({ path: path as string, sha256: digest(data), bytes: Buffer.byteLength(data), role: role as string, consumer: consumer as string, abi: abi as string, arch: 'x64', licensePath: 'runtime/licenses/a.txt', qualificationEvidence: 'evidence/qualified.txt' }));
  const manifest = { schemaVersion: 2, platform: 'win32-x64', status: 'ready', node: { version: '22.23.2', abi: '127', archiveSha256: '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97', executable: 'runtime/node.exe', args: ['runtime/mcp.cjs'] }, electron: { version: '41.0.0', abi: '145', integrity: 'sha512-U7QueSj1cFj9QM0Qamgh/MK08662FVK555iMfapqU7mcAmIm4A8bZuZptpjMXrT4JNAMGjgWu9sOeO1+RPCJNw==' }, files, packages: [{ name: 'a', version: '1.0.0', packageJson: 'runtime/node_modules/a/package.json', dependencies: [] as string[] }], fitModes: { cover: 'runtime/fit/cover.action', contain: 'runtime/fit/cover.action', stretch: 'runtime/fit/cover.action' }, missing: [] };
  return { root, vendor, staged, manifest };
}

describe('strict desktop bundle', () => {
  it('prepares and verifies a complete offline fixture under Unicode and spaces', () => {
    const f = fixture();
    try { expect(validateManifest(f.manifest).status).toBe('ready'); prepareResources(f.manifest, f.vendor, f.staged); verifyBundle(f.manifest, f.staged); }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['hash', 'arch', 'binary-arch', 'abi', 'dependency', 'license', 'fit', 'missing-node', 'missing-native', 'command', 'extra-file', 'traversal'])('rejects %s', (caseName) => {
    const f = fixture();
    try {
      const m = structuredClone(f.manifest);
      if (caseName === 'hash') m.files[0]!.sha256 = '0'.repeat(64);
      if (caseName === 'arch') m.files[0]!.arch = 'arm64';
      if (caseName === 'binary-arch') { const wrong = Buffer.from(pe); wrong.writeUInt16LE(0xaa64, 68); writeFileSync(join(f.vendor, 'runtime/node.exe'), wrong); m.files[0]!.sha256 = digest(wrong); }
      if (caseName === 'abi') m.files[3]!.abi = '127';
      if (caseName === 'dependency') m.packages[0]!.dependencies.push('absent');
      if (caseName === 'license') m.files[0]!.licensePath = 'runtime/licenses/missing.txt';
      if (caseName === 'fit') m.fitModes.stretch = 'runtime/fit/missing.action';
      if (caseName === 'missing-node') rmSync(join(f.vendor, 'runtime/node.exe'));
      if (caseName === 'missing-native') rmSync(join(f.vendor, 'runtime/native/better_sqlite3.node'));
      if (caseName === 'command') m.node.args = ['npx', 'runtime/mcp.cjs'];
      if (caseName === 'extra-file') writeFileSync(join(f.vendor, 'runtime/extra.dll'), 'unlisted');
      if (caseName === 'traversal') m.files[0]!.path = '../node.exe';
      expect(() => prepareResources(m, f.vendor, f.staged)).toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it('rejects blocked and unknown manifest fields', () => {
    const f = fixture();
    try { expect(() => validateManifest({ ...f.manifest, unexpected: true })).toThrow(); expect(() => validateManifest({ ...f.manifest, status: 'blocked', missing: ['vendor unavailable'] })).toThrow(); }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
