import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function readFixture<T = unknown>(name: string): T {
  const path = resolve(repositoryRoot, 'tests', 'fixtures', 'contracts', name);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
