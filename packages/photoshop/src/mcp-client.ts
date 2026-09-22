import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canonicalize } from '@ne-psd/contracts';
import { buildToolMap, toolSchemaDigest, type SemanticOperation, type ToolDefinition, type ToolMapEntry } from './tool-map.js';

export type ToolCall = { name: string; arguments: Record<string, unknown> };
export type ToolTransport = { listTools(): Promise<{ tools: ToolDefinition[] }>; callTool(request: ToolCall): Promise<unknown> };
export type Trace = { requestId: string; toolName: string; arguments: unknown; outcome: 'acknowledged' | 'failed'; errorCode?: string };
export class McpClientError extends Error { constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); this.name = 'McpClientError'; } }

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key]) => [key, '[REDACTED]']));
  return '[REDACTED]';
}
function matchesSchema(value: unknown, schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
  if ('const' in schema && !Object.is(schema.const, value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !types.some((type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === 'integer' ? typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) : type === 'string' ? typeof value === 'string' : type === 'boolean' && typeof value === 'boolean')) return false;
  if (Array.isArray(value) && schema.items && !value.every((item) => matchesSchema(item, schema.items as Record<string, unknown>))) return false;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    const required = schema.required as string[] | undefined;
    if (required?.some((key) => !(key in value))) return false;
    for (const [key, child] of Object.entries(properties)) if (key in value && !matchesSchema((value as Record<string, unknown>)[key], child)) return false;
  }
  return true;
}

export class McpClient {
  readonly traces: Trace[] = [];
  private schema?: { tools: ToolDefinition[]; digest: string };
  constructor(private readonly options: { transport: ToolTransport; toolMap: ReadonlyMap<SemanticOperation, ToolMapEntry>; schemaDigest?: string }) {}
  async listSchemaDigest(): Promise<string> {
    const listed = await this.options.transport.listTools();
    if (!Array.isArray(listed.tools) || listed.tools.some((tool) => typeof tool?.name !== 'string' || !tool.inputSchema)) throw new McpClientError('INVALID_TOOLS_LIST', 'tools/list response has invalid tool schemas');
    const digest = toolSchemaDigest(listed.tools);
    if (this.options.schemaDigest && digest !== this.options.schemaDigest) throw new McpClientError('SCHEMA_DIGEST_MISMATCH', 'tools/list schema digest differs from pinned digest', { expected: this.options.schemaDigest, actual: digest });
    this.schema = { tools: listed.tools, digest };
    return digest;
  }
  async callMapped(operation: SemanticOperation, args: Record<string, unknown>): Promise<unknown> {
    if (operation === 'scale' && args.percentX !== args.percentY) throw new McpClientError('FIT_MODE_UNSUPPORTED', 'independent-axis scale is not qualified');
    const entry = this.options.toolMap.get(operation);
    if (!entry || entry.status !== 'qualified') throw new McpClientError('CAPABILITY_MISSING', `no qualified MCP primitive for ${operation}`);
    const mapped = operation === 'scale' ? { percent: args.percentX } : args;
    return this.callRaw(entry.toolName, mapped);
  }
  async callRaw(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = [...this.options.toolMap.values()].find((candidate) => candidate.toolName === toolName);
    if (!entry || entry.status !== 'qualified') throw new McpClientError('TOOL_NOT_ALLOWLISTED', `tool is not allowlisted: ${toolName}`);
    await this.bindQualifiedEntry(entry);
    const listed = this.schema!.tools.find((tool) => tool.name === toolName)!;
    if (!matchesSchema(args, listed.inputSchema)) throw new McpClientError('INVALID_TOOL_ARGUMENTS', `arguments do not match schema for ${toolName}`);
    const trace: Trace = { requestId: globalThis.crypto.randomUUID(), toolName, arguments: redact(args), outcome: 'failed' };
    this.traces.push(trace);
    let response: unknown;
    try { response = await this.options.transport.callTool({ name: toolName, arguments: args }); }
    catch (error) { trace.errorCode = 'TRANSPORT_ERROR'; throw new McpClientError('TRANSPORT_ERROR', error instanceof Error ? error.message : 'transport failed'); }
    if (typeof response !== 'object' || response === null) { trace.errorCode = 'INVALID_TOOL_RESPONSE'; throw new McpClientError('INVALID_TOOL_RESPONSE', 'tool response is not an object'); }
    const result = response as Record<string, unknown>;
    if (result.isError === true) { const message = Array.isArray(result.content) && typeof result.content[0] === 'object' && result.content[0] !== null && typeof (result.content[0] as Record<string, unknown>).text === 'string' ? (result.content[0] as Record<string, unknown>).text as string : 'tool returned an error'; trace.errorCode = 'TOOL_ERROR'; throw new McpClientError('TOOL_ERROR', message); }
    let value: unknown = response;
    if (Array.isArray(result.content)) { const text = result.content[0]; if (!text || typeof text !== 'object' || typeof (text as Record<string, unknown>).text !== 'string') { trace.errorCode = 'INVALID_TOOL_RESPONSE'; throw new McpClientError('INVALID_TOOL_RESPONSE', 'tool content is invalid'); } try { value = JSON.parse((text as Record<string, unknown>).text as string); } catch { trace.errorCode = 'INVALID_TOOL_RESPONSE'; throw new McpClientError('INVALID_TOOL_RESPONSE', 'tool content is not JSON'); } }
    if (listed.outputSchema && !matchesSchema(value, listed.outputSchema)) { trace.errorCode = 'INVALID_TOOL_RESPONSE'; throw new McpClientError('INVALID_TOOL_RESPONSE', 'tool output does not match schema'); }
    trace.outcome = 'acknowledged';
    return value;
  }

  private async bindQualifiedEntry(entry: ToolMapEntry): Promise<void> {
    await this.listSchemaDigest();
    const listed = this.schema!.tools.find((tool) => tool.name === entry.toolName);
    if (!listed || canonicalize(listed.inputSchema) !== canonicalize(entry.inputSchema) || canonicalize(listed.outputSchema ?? null) !== canonicalize(entry.outputSchema ?? null)) throw new McpClientError('SCHEMA_BINDING_MISMATCH', `qualified schema does not match tools/list for ${entry.toolName}`);
  }
}

export type PinnedLaunchParameters = { command: string; args: string[] };
const absolutePath = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
const pathBase = (value: string): string => value.split(/[\\/]/).at(-1) ?? '';
export function buildPinnedLaunchParameters(input: { nodeExecutable: string; serverEntry: string; explicitArgs: readonly string[] }): PinnedLaunchParameters {
  if (!absolutePath(input.nodeExecutable) || !['node', 'node.exe'].includes(pathBase(input.nodeExecutable)) || /[;&|`$()\s]/.test(input.nodeExecutable)) throw new McpClientError('INVALID_LAUNCH', 'node executable must be an absolute pinned Node path');
  if (!absolutePath(input.serverEntry) || !input.serverEntry.replaceAll('\\', '/').endsWith('/node_modules/@alisaitteke/photoshop-mcp/dist/index.js') || /[;&|`$()\s]/.test(input.serverEntry)) throw new McpClientError('INVALID_LAUNCH', 'server entry must be an absolute vendored Photoshop MCP entry');
  if (input.explicitArgs.some((arg) => /[;&|`$()]/.test(arg) || arg.length === 0)) throw new McpClientError('INVALID_LAUNCH', 'launch arguments contain shell syntax or are empty');
  return { command: input.nodeExecutable, args: [input.serverEntry, ...input.explicitArgs] };
}
export async function createPinnedSdkTransport(launch: PinnedLaunchParameters): Promise<ToolTransport> {
  if (!absolutePath(launch.command) || launch.args.length < 1 || !absolutePath(launch.args[0]!) || !launch.args[0]!.replaceAll('\\', '/').endsWith('/node_modules/@alisaitteke/photoshop-mcp/dist/index.js')) throw new McpClientError('INVALID_LAUNCH', 'launch parameters must come from buildPinnedLaunchParameters');
  const transport = new StdioClientTransport({ command: launch.command, args: [...launch.args], stderr: 'pipe' });
  const sdk = new Client({ name: 'ne-psd-photoshop', version: '0.1.0' });
  await sdk.connect(transport);
  return {
    listTools: async () => {
      const result = await sdk.listTools();
      return { tools: result.tools.map((tool) => {
        const normalized: ToolDefinition = { name: tool.name, inputSchema: tool.inputSchema as unknown as NonNullable<ToolDefinition['inputSchema']> };
        if (tool.outputSchema) normalized.outputSchema = tool.outputSchema as unknown as NonNullable<ToolDefinition['outputSchema']>;
        return normalized;
      }) };
    },
    callTool: async (request) => sdk.callTool(request),
  };
}
