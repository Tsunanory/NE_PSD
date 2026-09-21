import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  root: repositoryRoot,
  test: {
    include: ['tests/contracts/**/*.test.ts'],
    environment: 'node'
  }
});
