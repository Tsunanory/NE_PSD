import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductionPhotoshopRuntimeForTransport, ProductionRuntimeError, type ProductionPhotoshopRuntimeOptions } from '../../packages/photoshop/src/production.js';
import { toolSchemaDigest, type ToolDefinition } from '../../packages/photoshop/src/tool-map.js';
import type { ToolTransport } from '../../packages/photoshop/src/mcp-client.js';

const roots: string[] = [];
const digest = (value: string): string => value.repeat(64).slice(0, 64);

async function options(): Promise<ProductionPhotoshopRuntimeOptions> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ne-psd-production-runtime-')));
  roots.push(root);
  const dirs = await Promise.all(['lock', 'template', 'source', 'evidence'].map(async (name) => {
    const path = join(root, name);
    await mkdir(path);
    return path;
  }));
  return {
    nodeExecutable: '/opt/node/bin/node',
    serverEntry: '/opt/server/node_modules/@alisaitteke/photoshop-mcp/dist/index.js',
    explicitArgs: ['--stdio'],
    installationId: 'photoshop-installation-1',
    installationDigest: digest('a'),
    processStartIdentity: 'process-start-1',
    lockRoot: dirs[0]!,
    toolSchemaDigest: digest('b'),
    templateRoots: [dirs[1]!],
    sourceRoots: [dirs[2]!],
    evidenceRoots: [dirs[3]!],
  };
}

function transport(tools: readonly ToolDefinition[], onClose?: () => void): ToolTransport {
  return {
    async listTools() { return { tools: [...tools] }; },
    async callTool() { throw new Error('unexpected mutation'); },
    async close() { onClose?.(); },
  };
}

const syntheticTools: ToolDefinition[] = [{
  name: 'fixture_scale',
  inputSchema: { type: 'object', properties: { percent: { type: 'number' } }, required: ['percent'], additionalProperties: false },
}];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production Photoshop runtime boundary', () => {
  it('rejects relative and shell-bearing launch arguments before transport creation', async () => {
    const selected = await options();
    let created = false;
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, nodeExecutable: 'node;evil' }, transport([], () => { created = true; }))).rejects.toMatchObject({ code: 'INVALID_LAUNCH' });
    expect(created).toBe(false);
  });

  it('rejects a tools/list schema digest mismatch and closes the transport', async () => {
    const selected = await options();
    let closed = false;
    const actual = toolSchemaDigest(syntheticTools);
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: actual === selected.toolSchemaDigest ? digest('c') : selected.toolSchemaDigest }, transport(syntheticTools, () => { closed = true; }))).rejects.toMatchObject({ code: 'SCHEMA_DIGEST_MISMATCH' });
    expect(closed).toBe(true);
  });

  it('rejects synthetic or unqualified tool bindings even when the digest matches', async () => {
    const selected = await options();
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest(syntheticTools) }, transport(syntheticTools))).rejects.toMatchObject({ code: 'LIVE_TOOL_BINDINGS_UNAVAILABLE' });
  });

  it('rejects overlapping configured roots before connecting MCP', async () => {
    const selected = await options();
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, sourceRoots: selected.templateRoots }, transport([]))).rejects.toMatchObject({ code: 'PRODUCTION_ROOT_OVERLAP' });
  });

  it('rejects symlink traversal in configured roots', async () => {
    const selected = await options();
    const root = roots[0]!;
    const target = join(root, 'source-link');
    await symlink(selected.sourceRoots[0]!, target);
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, sourceRoots: [target] }, transport([]))).rejects.toMatchObject({ code: 'PRODUCTION_ROOT_INVALID' });
  });

  it('fails closed when the complete live operation map is absent', async () => {
    const selected = await options();
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest([]) }, transport([]))).rejects.toMatchObject({ code: 'LIVE_TOOL_BINDINGS_UNAVAILABLE' });
  });

  it('closes the transport on an invalid tools/list response and never constructs a synthetic backend', async () => {
    const selected = await options();
    let closed = false;
    const invalid: ToolDefinition[] = [{ name: 'broken' }];
    await expect(createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest(invalid) }, transport(invalid, () => { closed = true; }))).rejects.toMatchObject({ code: 'INVALID_TOOLS_LIST' });
    expect(closed).toBe(true);
  });

  it('uses a typed production error for all fail-closed capability exits', async () => {
    const selected = await options();
    try { await createProductionPhotoshopRuntimeForTransport({ ...selected, toolSchemaDigest: toolSchemaDigest([]) }, transport([])); }
    catch (error) { expect(error).toBeInstanceOf(ProductionRuntimeError); expect((error as ProductionRuntimeError).category).toBe('capability'); }
  });
});
