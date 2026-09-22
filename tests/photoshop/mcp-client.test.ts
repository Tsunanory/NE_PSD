import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildPinnedLaunchParameters, McpClient, McpClientError, type ToolTransport } from '../../packages/photoshop/src/mcp-client.js';
import { buildToolMap } from '../../packages/photoshop/src/tool-map.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/tool-schema.synthetic.json', import.meta.url), 'utf8')) as { tools: Array<Record<string, unknown>> };

function transport(response: unknown = { ok: true }): ToolTransport & { sentMutations: unknown[] } {
  const sentMutations: unknown[] = [];
  return {
    sentMutations,
    async listTools() { return { tools: fixture.tools }; },
    async callTool(request) { sentMutations.push(request); return response; },
  };
}

describe('MCP primitive qualification wrapper', () => {
  it('pins a canonical tools/list schema digest', async () => {
    const client = new McpClient({ transport: transport(), toolMap: buildToolMap(fixture.tools) });
    expect(await client.listSchemaDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a schema digest change before a call', async () => {
    const t = transport();
    const client = new McpClient({ transport: t, toolMap: buildToolMap(fixture.tools), schemaDigest: '0'.repeat(64) });
    await expect(client.listSchemaDigest()).rejects.toMatchObject({ code: 'SCHEMA_DIGEST_MISMATCH' });
    expect(t.sentMutations).toHaveLength(0);
  });

  it('rejects independent-axis scale because the fixture primitive is uniform', async () => {
    const client = new McpClient({ transport: transport(), toolMap: buildToolMap(fixture.tools) });
    await expect(client.callMapped('scale', { percentX: 200, percentY: 100 })).rejects.toMatchObject({ code: 'FIT_MODE_UNSUPPORTED' });
  });

  it('rejects arbitrary script execution before mutation', async () => {
    const t = transport();
    const client = new McpClient({ transport: t, toolMap: buildToolMap(fixture.tools) });
    await expect(client.callRaw('photoshop_execute_script', { script: 'alert(1)' })).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWLISTED' });
    expect(t.sentMutations).toHaveLength(0);
  });

  it('turns structured tool errors into domain-shaped errors', async () => {
    const client = new McpClient({ transport: transport({ isError: true, content: [{ type: 'text', text: 'no document' }] }), toolMap: buildToolMap(fixture.tools) });
    await expect(client.callRaw('fixture_scale', { percent: 100 })).rejects.toMatchObject({ code: 'TOOL_ERROR', message: 'no document' });
  });

  it('rejects invalid successful responses and redacts trace arguments', async () => {
    const client = new McpClient({ transport: transport({ content: [{ type: 'text', text: 'not-json' }] }), toolMap: buildToolMap(fixture.tools) });
    await expect(client.callRaw('fixture_scale', { percent: 100 })).rejects.toMatchObject({ code: 'INVALID_TOOL_RESPONSE' });
    expect(client.traces[0]?.arguments).toEqual({ percent: '[REDACTED]' });
    expect(JSON.stringify(client.traces)).not.toContain('not-json');
  });

  it('binds and verifies tools/list before every allowlisted call', async () => {
    const t = transport({ ok: true });
    const client = new McpClient({ transport: t, toolMap: buildToolMap(fixture.tools) });
    await client.callRaw('fixture_scale', { percent: 100 });
    expect(t.sentMutations).toHaveLength(1);
  });

  it('rejects a stale separately supplied map when the listed schema differs', async () => {
    const t = transport({ ok: true });
    const stale = buildToolMap(fixture.tools);
    (stale.get('scale')!).inputSchema = { type: 'object', properties: { percent: { type: 'string' } }, required: ['percent'], additionalProperties: false };
    const client = new McpClient({ transport: t, toolMap: stale });
    await expect(client.callRaw('fixture_scale', { percent: 100 })).rejects.toMatchObject({ code: 'SCHEMA_BINDING_MISMATCH' });
    expect(t.sentMutations).toHaveLength(0);
  });

  it('rejects wrong input types and unknown keys recursively', async () => {
    const client = new McpClient({ transport: transport(), toolMap: buildToolMap(fixture.tools) });
    await expect(client.callRaw('fixture_scale', { percent: '100' })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' });
    await expect(client.callRaw('fixture_scale', { percent: 100, extra: true })).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' });
  });

  it('rejects wrong output types', async () => {
    const client = new McpClient({ transport: transport({ ok: 'yes' }), toolMap: buildToolMap(fixture.tools) });
    await expect(client.callRaw('fixture_scale', { percent: 100 })).rejects.toMatchObject({ code: 'INVALID_TOOL_RESPONSE' });
  });

  it('builds a pinned node plus vendored server launch without shell resolution', () => {
    expect(buildPinnedLaunchParameters({ nodeExecutable: '/private/tmp/node/bin/node', serverEntry: '/repo/node_modules/@alisaitteke/photoshop-mcp/dist/index.js', explicitArgs: ['--stdio'] })).toEqual({ command: '/private/tmp/node/bin/node', args: ['/repo/node_modules/@alisaitteke/photoshop-mcp/dist/index.js', '--stdio'] });
    expect(() => buildPinnedLaunchParameters({ nodeExecutable: 'node', serverEntry: '/repo/node_modules/@alisaitteke/photoshop-mcp/dist/index.js', explicitArgs: [] })).toThrowError(McpClientError);
    expect(() => buildPinnedLaunchParameters({ nodeExecutable: '/bin/npx', serverEntry: '/repo/node_modules/@alisaitteke/photoshop-mcp/dist/index.js', explicitArgs: [] })).toThrowError(McpClientError);
    expect(() => buildPinnedLaunchParameters({ nodeExecutable: '/bin/node', serverEntry: '/repo/server.js', explicitArgs: [] })).toThrowError(McpClientError);
  });

  it('fails closed when the recovery barrier cannot be persisted', async () => {
    let released = false;
    const lock = {
      runExclusive: async (_operationId: string, fn: () => Promise<unknown>) => { try { const value = await fn(); released = true; return value; } catch (error) { throw error; } },
      markUnknownMutation: async () => { throw new Error('barrier disk failure'); },
    };
    const delayed: ToolTransport = { async listTools() { return { tools: fixture.tools }; }, async callTool() { return new Promise(() => undefined); } };
    const client = new McpClient({ transport: delayed, toolMap: buildToolMap(fixture.tools), sessionLock: lock, timeouts: { scale: 5 } });
    await expect(lock.runExclusive('barrier-failure', () => client.callRaw('fixture_scale', { percent: 100 }))).rejects.toMatchObject({ code: 'JOURNAL_WRITE_FAILED', category: 'ambiguousState' });
    expect(released).toBe(false);
  });
});
