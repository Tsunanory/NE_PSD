import { canonicalize, sha256Json } from '@ne-psd/contracts';

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};
export type ToolDefinition = { name: string; inputSchema?: JsonSchema; outputSchema?: JsonSchema };
export type SemanticOperation = 'scale' | 'translate' | 'place' | 'replaceContents' | 'setClipping' | 'setVisibility' | 'export';
export type ToolSemantics = { scale?: 'uniform-percent' | 'independent-percent'; translation?: 'absolute' | 'absolute-center' | 'delta' };
export type ToolEvidence = 'synthetic-fixture' | 'live-qualified' | 'missing-live-proof';
export type ToolMapEntry = {
  operation: SemanticOperation;
  toolName: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  status: 'qualified' | 'capability';
  evidence: ToolEvidence;
  liveQualified?: boolean;
  semantics: ToolSemantics;
};
export type QualifiedToolBinding = {
  operation: SemanticOperation;
  toolName: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  semantics: ToolSemantics;
  evidence: 'live-qualified';
};
export class ToolMapError extends Error {
  readonly code: 'TOOL_BINDING_CONFLICT' | 'TOOL_SCHEMA_MISMATCH' | 'TOOL_SEMANTICS_MISMATCH';
  constructor(code: ToolMapError['code'], message: string) { super(message); this.name = 'ToolMapError'; this.code = code; }
}

function validateSemantics(binding: QualifiedToolBinding): void {
  const properties = binding.inputSchema.properties ?? {};
  if (binding.operation === 'scale') {
    if (!binding.semantics.scale) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'scale binding must declare axis semantics');
    const hasUniform = 'percent' in properties;
    const hasIndependent = 'percentX' in properties && 'percentY' in properties;
    if ((binding.semantics.scale === 'uniform-percent') !== hasUniform || (binding.semantics.scale === 'independent-percent') !== hasIndependent) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'scale schema does not match declared axis semantics');
  }
  if (binding.operation === 'translate') {
    if (!binding.semantics.translation) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'translate binding must declare coordinate semantics');
    const valid = binding.semantics.translation === 'absolute' ? 'x' in properties && 'y' in properties
      : binding.semantics.translation === 'absolute-center' ? 'centerX' in properties && 'centerY' in properties
        : 'dx' in properties && 'dy' in properties;
    if (!valid) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'translate schema does not match declared coordinate semantics');
  }
}

/** Maps schemas explicitly bound by qualification evidence. Names alone never qualify operations. */
export function buildToolMap(tools: readonly ToolDefinition[], bindings: readonly QualifiedToolBinding[] = []): ReadonlyMap<SemanticOperation, ToolMapEntry> {
  const result = new Map<SemanticOperation, ToolMapEntry>();
  const fixture = tools.find((tool) => tool.name === 'fixture_scale');
  if (fixture?.inputSchema) result.set('scale', {
    operation: 'scale',
    toolName: fixture.name,
    inputSchema: fixture.inputSchema,
    ...(fixture.outputSchema ? { outputSchema: fixture.outputSchema } : {}),
    status: 'qualified',
    evidence: 'synthetic-fixture',
    liveQualified: false,
    semantics: { scale: 'uniform-percent' },
  });
  for (const binding of bindings) {
    if (binding.evidence !== 'live-qualified') throw new ToolMapError('TOOL_BINDING_CONFLICT', 'synthetic or missing evidence cannot qualify a live binding');
    const listed = tools.find((tool) => tool.name === binding.toolName);
    if (!listed?.inputSchema || canonicalize(listed.inputSchema) !== canonicalize(binding.inputSchema)
      || canonicalize(listed.outputSchema ?? null) !== canonicalize(binding.outputSchema ?? null)) throw new ToolMapError('TOOL_SCHEMA_MISMATCH', `qualified schema does not match tools/list for ${binding.toolName}`);
    if (result.has(binding.operation) || [...result.values()].some((entry) => entry.toolName === binding.toolName)) throw new ToolMapError('TOOL_BINDING_CONFLICT', `duplicate qualified tool binding for ${binding.operation}/${binding.toolName}`);
    validateSemantics(binding);
    result.set(binding.operation, { ...binding, status: 'qualified', liveQualified: true });
  }
  return result;
}

export function toolSchemaDigest(tools: readonly ToolDefinition[]): string {
  return sha256Json([...tools].sort((a, b) => a.name.localeCompare(b.name)));
}
