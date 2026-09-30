import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canonicalize } from '@ne-psd/contracts';
import { buildToolMap, toolSchemaDigest, type SemanticOperation, type ToolDefinition, type ToolMapEntry } from './tool-map.js';
import type { SessionLock } from './session-lock.js';
import { OperationJournal, RecoveryError, operationTimeoutMs, runUncertainOperation } from './recovery.js';
import type { CanonicalTraceWriter } from './trace.js';

export type ToolCall = { name: string; arguments: Record<string, unknown> };
export type ToolTransport = { listTools(): Promise<{ tools: ToolDefinition[] }>; callTool(request: ToolCall, signal?: AbortSignal): Promise<unknown>; close?: () => Promise<void> };
export type Trace = { requestId: string; toolName: string; arguments: unknown; outcome: 'acknowledged' | 'failed' | 'unknown'; errorCode?: string };
export class McpClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly category: 'validation' | 'capability' | 'transient' | 'ambiguousState' | 'cancelled' = 'validation',
    public readonly retryable = category === 'transient',
    public readonly evidencePaths: readonly string[] = [],
  ) { super(message); this.name = 'McpClientError'; }
}

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
  private readonly journal: OperationJournal;
  private recoveryRequired = false;
  constructor(private readonly options: {
    transport: ToolTransport;
    toolMap: ReadonlyMap<SemanticOperation, ToolMapEntry>;
    schemaDigest?: string;
    sessionLock?: Pick<SessionLock, 'runExclusive'> & Partial<Pick<SessionLock, 'markUnknownMutation' | 'reconcile' | 'markTransportPending' | 'markTransportSettled' | 'journalPath' | 'journalIdentity' | 'journalMetadata'>>;
    journal?: OperationJournal;
    canonicalTrace?: CanonicalTraceWriter;
    timeouts?: Partial<Record<string, number>>;
  }) { this.journal = options.journal ?? new OperationJournal(); }
  private readonly journals = new Map<string, OperationJournal>();
  private journalForCall(): OperationJournal {
    if (this.options.journal) return this.options.journal;
    const identity = this.options.sessionLock?.journalIdentity;
    const path = this.options.sessionLock?.journalPath;
    if (!identity || !path) return this.journal;
    const key = `${path}\u0000${JSON.stringify(identity)}`;
    const existing = this.journals.get(key);
    if (existing) return existing;
    const created = new OperationJournal(path, identity);
    this.journals.set(key, created);
    return created;
  }
  async runTransaction<T>(operationId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.options.sessionLock ? this.options.sessionLock.runExclusive(operationId, fn, signal) : fn();
  }
  async listSchemaDigest(signal?: AbortSignal): Promise<string> {
    if (this.recoveryRequired) throw new McpClientError('RECOVERY_REQUIRED', 'the previous Photoshop operation has unknown completion; reconcile before another call', undefined, 'ambiguousState', false);
    const journal = this.journalForCall();
    const listed = await runUncertainOperation({
      operation: 'readLayers',
      requestId: globalThis.crypto.randomUUID(),
      mutation: false,
      timeoutMs: this.options.timeouts?.readLayers ?? operationTimeoutMs('readLayers'),
      journal,
      signal,
      onDispatch: async () => { try { await this.options.sessionLock?.markTransportPending?.(); } catch { /* calls outside an acquired transaction retain the local journal barrier */ } },
      onSettled: async () => { try { await this.options.sessionLock?.markTransportSettled?.(); } catch { /* owner may already have exited; local tracking remains authoritative */ } },
      onUnknown: async () => {
        this.recoveryRequired = true;
        await this.options.sessionLock?.markUnknownMutation?.();
      },
      call: () => this.options.transport.listTools(),
    });
    if (!Array.isArray(listed.tools) || listed.tools.some((tool) => typeof tool?.name !== 'string' || !tool.inputSchema)) throw new McpClientError('INVALID_TOOLS_LIST', 'tools/list response has invalid tool schemas');
    const digest = toolSchemaDigest(listed.tools);
    if (this.options.schemaDigest && digest !== this.options.schemaDigest) throw new McpClientError('SCHEMA_DIGEST_MISMATCH', 'tools/list schema digest differs from pinned digest', { expected: this.options.schemaDigest, actual: digest });
    this.schema = { tools: listed.tools, digest };
    return digest;
  }
  async callMapped(operation: SemanticOperation, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (operation === 'scale' && args.percentX !== args.percentY) throw new McpClientError('FIT_MODE_UNSUPPORTED', 'independent-axis scale is not qualified');
    const entry = this.options.toolMap.get(operation);
    if (!entry || entry.status !== 'qualified') throw new McpClientError('CAPABILITY_MISSING', `no qualified MCP primitive for ${operation}`);
    const mapped = operation === 'scale' ? { percent: args.percentX } : args;
    return this.callRaw(entry.toolName, mapped, signal);
  }
  async callRaw(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.callRawWithSignal(toolName, args, signal);
  }

  async callRawWithSignal(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.recoveryRequired) throw new McpClientError('RECOVERY_REQUIRED', 'the previous Photoshop operation has unknown completion; reconcile before another call', undefined, 'ambiguousState', false);
    const entry = [...this.options.toolMap.values()].find((candidate) => candidate.toolName === toolName);
    if (!entry || entry.status !== 'qualified') throw new McpClientError('TOOL_NOT_ALLOWLISTED', `tool is not allowlisted: ${toolName}`);
    await this.bindQualifiedEntry(entry, signal);
    const listed = this.schema!.tools.find((tool) => tool.name === toolName)!;
    if (!matchesSchema(args, listed.inputSchema)) throw new McpClientError('INVALID_TOOL_ARGUMENTS', `arguments do not match schema for ${toolName}`);
    const requestId = globalThis.crypto.randomUUID();
    await this.options.canonicalTrace?.bytes('pre', toolName, Buffer.from(JSON.stringify({ requestId, toolName, arguments: args })), requestId);
    const trace: Trace = { requestId, toolName, arguments: redact(args), outcome: 'failed' };
    this.traces.push(trace);
    const journal = this.journalForCall();
    let response: unknown;
    try {
      response = await runUncertainOperation({
        operation: entry.operation,
        requestId,
        mutation: true,
        timeoutMs: this.options.timeouts?.[entry.operation] ?? operationTimeoutMs(entry.operation),
        journal,
        signal,
        onDispatch: async () => { try { await this.options.sessionLock?.markTransportPending?.(); } catch { /* calls outside an acquired transaction retain the local journal barrier */ } },
        onSettled: async () => { try { await this.options.sessionLock?.markTransportSettled?.(); } catch { /* owner may already have exited; local tracking remains authoritative */ } },
        onUnknown: async () => {
          this.recoveryRequired = true;
          await this.options.sessionLock?.markUnknownMutation?.();
        },
        call: () => this.options.transport.callTool({ name: toolName, arguments: args }, signal),
      });
    } catch (error) {
      trace.errorCode = error instanceof RecoveryError ? error.code : 'TRANSPORT_ERROR';
      if (error instanceof RecoveryError && error.category === 'ambiguousState') trace.outcome = 'unknown';
      if (error instanceof RecoveryError) throw new McpClientError(error.code, error.message, undefined, error.category, error.retryable, error.evidencePaths);
      throw new McpClientError('TRANSPORT_ERROR', error instanceof Error ? error.message : 'transport failed', undefined, 'ambiguousState', false);
    }
    if (typeof response !== 'object' || response === null) { trace.errorCode = 'INVALID_TOOL_RESPONSE'; throw new McpClientError('INVALID_TOOL_RESPONSE', 'tool response is not an object'); }
    const result = response as Record<string, unknown>;
    if (result.isError === true) { const message = Array.isArray(result.content) && typeof result.content[0] === 'object' && result.content[0] !== null && typeof (result.content[0] as Record<string, unknown>).text === 'string' ? (result.content[0] as Record<string, unknown>).text as string : 'tool returned an error'; trace.errorCode = 'TOOL_ERROR'; throw new McpClientError('TOOL_ERROR', message); }
    let value: unknown = response;
    if (Array.isArray(result.content)) { const text = result.content[0]; if (!text || typeof text !== 'object' || typeof (text as Record<string, unknown>).text !== 'string') { trace.errorCode = 'INVALID_TOOL_RESPONSE'; throw new McpClientError('INVALID_TOOL_RESPONSE', 'tool content is invalid'); } try { value = JSON.parse((text as Record<string, unknown>).text as string); } catch { trace.errorCode = 'INVALID_TOOL_RESPONSE'; throw new McpClientError('INVALID_TOOL_RESPONSE', 'tool content is not JSON'); } }
    if (listed.outputSchema && !matchesSchema(value, listed.outputSchema)) { trace.errorCode = 'INVALID_TOOL_RESPONSE'; throw new McpClientError('INVALID_TOOL_RESPONSE', 'tool output does not match schema'); }
    trace.outcome = 'acknowledged';
    await this.options.canonicalTrace?.bytes('post', toolName, Buffer.from(JSON.stringify(response)), requestId);
    return value;
  }

  /** Clears the local barrier only after the caller has independently proven idle state and ownership. */
  async reconcile(requestId?: string): Promise<void> {
    const journal = this.journalForCall();
    if (journal.unsettled().length > 0 || (this.options.sessionLock?.journalMetadata?.unsettledOperations ?? 0) > 0) throw new McpClientError('UNSETTLED_OPERATION', 'cannot reconcile while an underlying transport promise is unresolved', undefined, 'ambiguousState', false);
    await journal.reconcile(requestId);
    try { await this.options.sessionLock?.reconcile?.(); }
    catch (error) { this.recoveryRequired = true; throw error; }
    this.recoveryRequired = journal.pendingUnknown().length > 0 || journal.unsettled().length > 0;
  }

  isRecoveryRequired(): boolean { return this.recoveryRequired; }

  private async bindQualifiedEntry(entry: ToolMapEntry, signal?: AbortSignal): Promise<void> {
    await this.listSchemaDigest(signal);
    const listed = this.schema!.tools.find((tool) => tool.name === entry.toolName);
    if (!listed || canonicalize(listed.inputSchema) !== canonicalize(entry.inputSchema) || canonicalize(listed.outputSchema ?? null) !== canonicalize(entry.outputSchema ?? null)) throw new McpClientError('SCHEMA_BINDING_MISMATCH', `qualified schema does not match tools/list for ${entry.toolName}`);
  }
}

export type PinnedLaunchParameters = { command: string; args: string[] };
const absolutePath = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
const pathBase = (value: string): string => value.split(/[\\/]/).at(-1) ?? '';
const shellSyntax = /[;&|`$()<>\n\r]/;
function validatePinnedLaunch(launch: PinnedLaunchParameters): void {
  if (!absolutePath(launch.command) || !['node', 'node.exe'].includes(pathBase(launch.command)) || shellSyntax.test(launch.command)) throw new McpClientError('INVALID_LAUNCH', 'command must be an absolute pinned Node executable');
  if (!Array.isArray(launch.args) || launch.args.length < 1 || !absolutePath(launch.args[0]!) || !launch.args[0]!.replaceAll('\\', '/').endsWith('/node_modules/@alisaitteke/photoshop-mcp/dist/index.js') || shellSyntax.test(launch.args[0]!)) throw new McpClientError('INVALID_LAUNCH', 'first argument must be the absolute vendored Photoshop MCP entry');
  if (launch.args.some((arg) => typeof arg !== 'string' || arg.length === 0 || shellSyntax.test(arg))) throw new McpClientError('INVALID_LAUNCH', 'launch arguments contain unsafe shell syntax or empty values');
}
export function buildPinnedLaunchParameters(input: { nodeExecutable: string; serverEntry: string; explicitArgs: readonly string[] }): PinnedLaunchParameters {
  // Spaces are valid Windows/macOS path characters. Arguments are passed to
  // the child process as an argv array, so rejecting whitespace is neither a
  // safety proof nor necessary. Reject shell metacharacters instead.
  const launch = { command: input.nodeExecutable, args: [input.serverEntry, ...input.explicitArgs] };
  validatePinnedLaunch(launch); return launch;
}
export async function createPinnedSdkTransport(launch: PinnedLaunchParameters): Promise<ToolTransport> {
  validatePinnedLaunch(launch);
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
    close: async () => { await transport.close(); },
  };
}
