import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, '..', 'src', 'prompts');
const target = join(root, '..', 'dist', 'prompts');
await mkdir(target, { recursive: true });
for (const name of ['planner-system.txt', 'runtime-reviewer-system.txt', 'diagnostic-system.txt']) await copyFile(join(source, name), join(target, name));
