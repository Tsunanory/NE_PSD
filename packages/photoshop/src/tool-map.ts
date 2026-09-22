import { sha256Json } from '@ne-psd/contracts';

export type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean; [key: string]: unknown };
export type ToolDefinition = { name: string; inputSchema?: JsonSchema; outputSchema?: JsonSchema };
export type SemanticOperation = 'scale' | 'translate' | 'place' | 'replaceContents' | 'setClipping' | 'setVisibility' | 'export';
export type ToolMapEntry = { operation: SemanticOperation; toolName: string; inputSchema: JsonSchema; outputSchema?: JsonSchema; status: 'qualified' | 'capability'; evidence: 'synthetic-fixture' | 'missing-live-proof' };

/** Maps only explicitly observed schemas. Names alone never qualify a real operation. */
export function buildToolMap(tools: readonly ToolDefinition[]): ReadonlyMap<SemanticOperation, ToolMapEntry> {
  const result = new Map<SemanticOperation, ToolMapEntry>();
  const fixture = tools.find((tool) => tool.name === 'fixture_scale');
  if (fixture?.inputSchema) result.set('scale', { operation: 'scale', toolName: fixture.name, inputSchema: fixture.inputSchema, ...(fixture.outputSchema ? { outputSchema: fixture.outputSchema } : {}), status: 'qualified', evidence: 'synthetic-fixture' });
  return result;
}

export function toolSchemaDigest(tools: readonly ToolDefinition[]): string {
  return sha256Json([...tools].sort((a, b) => a.name.localeCompare(b.name)));
}
