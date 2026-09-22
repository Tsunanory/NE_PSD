import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  root: repositoryRoot,
  test: {
    include: ['tests/desktop/**/*.test.{ts,tsx}'],
    exclude: ['tests/desktop/**/*.e2e.test.ts'],
    environment: 'node'
  }
});
