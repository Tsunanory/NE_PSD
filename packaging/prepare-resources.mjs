import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { prepareResources } from './runtime-manifest.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  const manifest = JSON.parse(readFileSync(join(root, 'packaging/runtime-manifest.json'), 'utf8'));
  const result = prepareResources(manifest, resolve(root, 'packaging/vendor'), resolve(root, 'packaging/staged/win32-x64'));
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 2; }
