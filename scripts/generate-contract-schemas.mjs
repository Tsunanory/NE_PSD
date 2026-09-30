import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PrepareRequestV2Schema, PreparedInputManifestV2Schema, RenderRequestV2Schema, RenderEvidenceV2Schema, RecoveryRequestV2Schema, RecoveryResultV2Schema } from '../packages/contracts/dist/render-v2.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'packages/contracts/schema/v1');
export const SAFE_RELATIVE_PATH = '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[^\\u0000]+$';
export const RUNTIME_ONLY_INVARIANTS = [
  'candidate existence, role and document-route compatibility',
  'source/profile/backend/tool-schema/fit-mode and current-attempt binding',
  'manifest path existence, digest and byte verification, including digestWithoutSelfHash',
  'review policy digest, exact evidence closure and reviewer provenance qualification',
];

function visit(node, propertyName = '') {
  if (node === null || typeof node !== 'object') return;
  if (node.type === 'string' && ['relativePath', 'evidencePath', 'documentTracePath', 'toolTracePath', 'path', 'qualificationEvidencePath'].includes(propertyName)) {
    node.pattern = SAFE_RELATIVE_PATH;
  }
  if (node.type === 'string' && ['workingTemplatePath', 'evidenceDirectory', 'stagingDirectory'].includes(propertyName)) {
    node.pattern = '^(?:/|[A-Za-z]:[\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+$';
  }
  if (['bytes', 'width', 'height', 'sourceBytes'].includes(propertyName)) {
    node.minimum = Math.max(node.minimum ?? 0, 1);
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties)) visit(child, name);
  }
  if (node.items) visit(node.items, propertyName);
  if (Array.isArray(node.prefixItems)) for (const child of node.prefixItems) visit(child, propertyName);
  for (const branch of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(node[branch])) for (const child of node[branch]) visit(child, propertyName);
}

export function generatedSchema(fileName, source) {
  const schema = structuredClone(source);
  schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
  schema['x-runtime-only-invariants'] = RUNTIME_ONLY_INVARIANTS;
  visit(schema);
  if (fileName === 'evidence-bundle-manifest.json') {
    schema['x-runtime-only-invariants'] = [...RUNTIME_ONLY_INVARIANTS, 'manifest relativePath uniqueness and self-hash exclusion'];
  }
  return schema;
}

export const V2_SCHEMAS = {
  'prepare-request.json': PrepareRequestV2Schema,
  'prepared-input-manifest.json': PreparedInputManifestV2Schema,
  'render-request.json': RenderRequestV2Schema,
  'render-evidence.json': RenderEvidenceV2Schema,
  'recovery-request.json': RecoveryRequestV2Schema,
  'recovery-result.json': RecoveryResultV2Schema,
};

export function generatedV2Schema(fileName) {
  const source = V2_SCHEMAS[fileName];
  if (!source) throw new Error(`unknown v2 schema: ${fileName}`);
  const schema = generatedSchema(fileName, z.toJSONSchema(source, { target: 'draft-2020-12' }));
  schema.$id = `@ne-psd/contracts/schema/v2/${fileName}`;
  schema['x-runtime-only-invariants'] = [...schema['x-runtime-only-invariants'],
    'canonical filesystem containment and symlink/reparse-point rejection',
    'source/dependency byte hashes, complete discovered closure and actual opened-copy proof',
    'exact attempt/operation identity, settled mutation, owned-document cleanup and OS-lock release proof'];
  return schema;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const fileName of readdirSync(schemaDir).filter((name) => name.endsWith('.json')).sort()) {
    const path = join(schemaDir, fileName);
    const schema = generatedSchema(fileName, JSON.parse(readFileSync(path, 'utf8')));
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`);
  }
  const v2Directory = join(root, 'packages/contracts/schema/v2');
  mkdirSync(v2Directory, { recursive: true });
  for (const fileName of Object.keys(V2_SCHEMAS).sort()) writeFileSync(join(v2Directory, fileName), `${JSON.stringify(generatedV2Schema(fileName), null, 2)}\n`);
}
