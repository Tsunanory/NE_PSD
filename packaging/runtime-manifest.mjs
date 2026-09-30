import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import { tmpdir } from 'node:os';

const hex = /^[a-f0-9]{64}$/;
const version = /^\d+\.\d+\.\d+$/;
const roles = new Set(['node', 'mcp-entry', 'dependency', 'native', 'license', 'fit-resource', 'evidence']);
const consumers = new Set(['standalone-node', 'electron', 'none']);
function fail(message) { throw new Error(`BLOCKED — ${message}`); }
function object(value, keys, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}.${key} is unknown`);
  for (const key of required) if (!(key in value)) fail(`${label}.${key} is missing`);
}
function relative(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || win32.isAbsolute(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith(' ') || p.endsWith('.'))) fail(`unsafe relative path: ${path}`);
  return path;
}
function contained(root, path) {
  const base = resolve(root); const full = resolve(base, relative(path));
  if (!full.startsWith(base + sep)) fail(`path escapes root: ${path}`);
  let part = base;
  for (const segment of path.split('/')) {
    part = join(part, segment);
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) fail(`symlink prohibited: ${path}`);
  }
  return full;
}
function checkCommand(node) {
  if (node.executable !== 'runtime/node.exe' || node.args.length !== 1 || node.args[0] !== 'runtime/mcp.cjs') fail('runtime command must use the pinned Node and MCP entry');
  for (const arg of [node.executable, ...node.args]) if (/\b(?:npx|npm|curl|powershell|cmd)(?:\.exe|\.cmd)?\b|:\/\//i.test(arg)) fail('install/network/floating runtime command');
}
export function validateManifest(m) {
  object(m, ['schemaVersion','platform','status','node','electron','files','packages','fitModes','missing'], ['schemaVersion','platform','status','node','electron','files','packages','fitModes','missing'], 'manifest');
  if (m.schemaVersion !== 2 || m.platform !== 'win32-x64' || m.status !== 'ready' || !Array.isArray(m.missing) || m.missing.length) fail(`manifest unavailable: ${m.missing?.join('; ') ?? 'invalid status'}`);
  object(m.node, ['version','abi','archiveSha256','executable','args'], ['version','abi','archiveSha256','executable','args'], 'node');
  object(m.electron, ['version','abi','integrity'], ['version','abi','integrity'], 'electron');
  if (m.node.version !== '22.23.2' || m.node.abi !== '127' || m.node.archiveSha256 !== '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97' || m.electron.version !== '41.0.0' || m.electron.abi !== '145' || m.electron.integrity !== 'sha512-U7QueSj1cFj9QM0Qamgh/MK08662FVK555iMfapqU7mcAmIm4A8bZuZptpjMXrT4JNAMGjgWu9sOeO1+RPCJNw==' || !Array.isArray(m.node.args)) fail('pinned runtime version, archive, integrity or ABI mismatch');
  checkCommand(m.node);
  if (!Array.isArray(m.files) || !m.files.length || !Array.isArray(m.packages)) fail('file/package inventory missing');
  const paths = new Set();
  for (const f of m.files) {
    object(f, ['path','sha256','bytes','role','consumer','abi','arch','licensePath','qualificationEvidence'], ['path','sha256','bytes','role','consumer','abi','arch','licensePath','qualificationEvidence'], 'file');
    relative(f.path); relative(f.licensePath); relative(f.qualificationEvidence);
    if (paths.has(f.path)) fail(`duplicate file: ${f.path}`); paths.add(f.path);
    if (!hex.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 1 || !roles.has(f.role) || !consumers.has(f.consumer) || f.arch !== 'x64') fail(`invalid file declaration: ${f.path}`);
    const expectedAbi = f.consumer === 'electron' ? m.electron.abi : f.consumer === 'standalone-node' ? m.node.abi : 'none';
    if (f.abi !== expectedAbi) fail(`wrong ABI: ${f.path}`);
    if (f.role === 'native' && !f.path.endsWith('.node')) fail('native binary must be .node');
  }
  if (m.files.find(f => f.path === m.node.executable)?.role !== 'node' || m.files.find(f => f.path === m.node.args[0])?.role !== 'mcp-entry' || !m.files.some(f => f.role === 'native' && f.consumer === 'electron')) fail('Node, MCP or Electron native binary missing');
  for (const f of m.files) if (!paths.has(f.licensePath) || !paths.has(f.qualificationEvidence) || m.files.find(x => x.path === f.licensePath)?.role !== 'license' || m.files.find(x => x.path === f.qualificationEvidence)?.role !== 'evidence') fail(`license/evidence missing: ${f.path}`);
  object(m.fitModes, ['cover','contain','stretch'], ['cover','contain','stretch'], 'fitModes');
  for (const mode of ['cover','contain','stretch']) if (!paths.has(relative(m.fitModes[mode])) || m.files.find(f => f.path === m.fitModes[mode])?.role !== 'fit-resource') fail(`unqualified ${mode} resource`);
  const packages = new Map();
  for (const p of m.packages) {
    object(p, ['name','version','packageJson','dependencies'], ['name','version','packageJson','dependencies'], 'package');
    if (typeof p.name !== 'string' || !p.name || !version.test(p.version) || !Array.isArray(p.dependencies) || packages.has(p.name) || !paths.has(relative(p.packageJson))) fail(`invalid production package: ${p.name}`);
    packages.set(p.name, p);
  }
  for (const p of m.packages) for (const dep of p.dependencies) if (!packages.has(dep)) fail(`unresolved production dependency: ${p.name} -> ${dep}`);
  for (const f of m.files.filter(f => f.path.endsWith('/package.json') && f.path.includes('/node_modules/'))) if (![...packages.values()].some(p => p.packageJson === f.path)) fail(`undeclared production package: ${f.path}`);
  return m;
}
function inspectPE(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 0x46 || bytes.toString('ascii', 0, 2) !== 'MZ') fail(`invalid PE binary: ${path}`);
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== 0x8664) fail(`binary is not Windows x64: ${path}`);
}
function verifyFiles(m, root) {
  const expected = new Set(m.files.map(f => f.path));
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(`symlink prohibited: ${rel}`);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (!entry.isFile() || !expected.has(rel)) fail(`undeclared resource: ${rel}`);
    }
  }
  if (!existsSync(root)) fail(`resource root absent: ${root}`);
  walk(root);
  for (const f of m.files) {
    const file = contained(root, f.path);
    if (!existsSync(file) || !statSync(file).isFile()) fail(`missing resource: ${f.path}`);
    const data = readFileSync(file);
    if (data.length !== f.bytes || createHash('sha256').update(data).digest('hex') !== f.sha256) fail(`hash/size mismatch: ${f.path}`);
    if (f.role === 'node' || f.role === 'native') inspectPE(file);
  }
  for (const p of m.packages) {
    const actual = JSON.parse(readFileSync(contained(root, p.packageJson), 'utf8'));
    if (actual.name !== p.name || actual.version !== p.version || JSON.stringify(Object.keys(actual.dependencies ?? {}).sort()) !== JSON.stringify([...p.dependencies].sort())) fail(`production package closure mismatch: ${p.name}`);
  }
}
export function verifyBundle(manifest, staged) { const m = validateManifest(manifest); verifyFiles(m, staged); return { files: m.files.length, packages: m.packages.length }; }
export function prepareResources(manifest, vendor, staged) {
  const m = validateManifest(manifest); verifyFiles(m, vendor);
  if (existsSync(staged)) fail(`staged path already exists: ${staged}`);
  mkdirSync(dirname(staged), { recursive: true });
  const temp = mkdtempSync(join(dirname(staged), '.ne-psd-stage-'));
  try { cpSync(vendor, temp, { recursive: true, force: true }); verifyFiles(m, temp); renameSync(temp, staged); }
  catch (error) { rmSync(temp, { recursive: true, force: true }); throw error; }
  return { files: m.files.length, staged };
}
