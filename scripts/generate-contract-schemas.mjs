import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (node.type === 'string' && ['workingTemplatePath', 'evidenceDirectory'].includes(propertyName)) {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const fileName of readdirSync(schemaDir).filter((name) => name.endsWith('.json')).sort()) {
    const path = join(schemaDir, fileName);
    const schema = generatedSchema(fileName, JSON.parse(readFileSync(path, 'utf8')));
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`);
  }
}
