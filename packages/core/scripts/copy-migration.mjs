import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const destination = resolve(root, '../dist/migrations/001-initial.sql');
await mkdir(dirname(destination), { recursive: true });
await copyFile(resolve(root, '../src/migrations/001-initial.sql'), destination);
