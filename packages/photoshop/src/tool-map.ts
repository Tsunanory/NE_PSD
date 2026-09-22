import { canonicalize, sha256Json } from '@ne-psd/contracts';

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};
export type ToolDefinition = { name: string; inputSchema?: JsonSchema; outputSchema?: JsonSchema };
export type SemanticOperation = 'scale' | 'translate' | 'place' | 'replaceContents' | 'setClipping' | 'setVisibility' | 'export' | 'convertProfile' | 'resize' | 'flatten';
export type ExportToolSemantics = {
  qualityUnit: '1-100' | '0-12';
  qualityField?: string;
  formats: readonly ('jpeg' | 'png')[];
  actualPixelsToSrgb: true;
  renderingIntent: 'relative-colorimetric' | 'perceptual' | 'absolute-colorimetric' | 'saturation';
  embeddedProfile: 'sRGB';
  mode: 'RGB';
  bitDepth: 8;
  alpha: 'preserve' | 'opaque' | 'format-dependent';
};
export type ColorToolSemantics = {
  actualPixels: true;
  renderingIntent: 'relative-colorimetric' | 'perceptual' | 'absolute-colorimetric' | 'saturation';
  embeddedProfile: 'sRGB';
  mode: 'RGB';
  bitDepth: 8;
};
export type VisibilityToolSemantics = { acknowledged: true; rereadsEffectiveAncestor: true; variantIds: readonly ['1', '2', '3'] };
export type ToolSemantics = { scale?: 'uniform-percent' | 'independent-percent'; translation?: 'absolute' | 'absolute-center' | 'delta'; export?: ExportToolSemantics; color?: ColorToolSemantics; visibility?: VisibilityToolSemantics };
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
  if (binding.operation === 'export') {
    const semantics = binding.semantics.export;
    if (!semantics || semantics.actualPixelsToSrgb !== true || semantics.embeddedProfile !== 'sRGB' || semantics.mode !== 'RGB' || semantics.bitDepth !== 8 || semantics.formats.length === 0 || !['preserve', 'opaque', 'format-dependent'].includes(semantics.alpha)) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'export binding must prove actual-pixel sRGB, RGB/8, format and alpha support');
    if (!semantics.renderingIntent) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'export binding must qualify rendering intent');
    const quality = semantics.qualityField ?? 'quality';
    const schema = properties[quality] as JsonSchema | undefined;
    if (semantics.qualityUnit === '1-100' && (!schema || !(binding.inputSchema.required ?? []).includes(quality) || schema.type !== 'integer' || schema.minimum !== 1 || schema.maximum !== 100)) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'export schema does not prove integer quality units 1..100');
    if (semantics.qualityUnit === '0-12') throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'backend quality units are not the shared 1..100 contract');
    if (semantics.formats.some((format) => !['jpeg', 'png'].includes(format))) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'export schema contains an unsupported format');
  }
  if (binding.operation === 'setVisibility') {
    const semantics = binding.semantics.visibility;
    if (!semantics || semantics.acknowledged !== true || semantics.rereadsEffectiveAncestor !== true || semantics.variantIds.join(',') !== '1,2,3') throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'visibility binding must prove acknowledged effective ancestor rereads for exactly IDs 1,2,3');
  }
  if (binding.operation === 'convertProfile') {
    const semantics = binding.semantics.color;
    if (!semantics || semantics.actualPixels !== true || semantics.embeddedProfile !== 'sRGB' || semantics.mode !== 'RGB' || semantics.bitDepth !== 8 || !semantics.renderingIntent) throw new ToolMapError('TOOL_SEMANTICS_MISMATCH', 'color binding must prove actual-pixel sRGB conversion and RGB/8 intent');
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
