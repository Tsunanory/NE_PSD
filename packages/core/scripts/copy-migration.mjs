import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const destination = resolve(root, '../dist/migrations');
await mkdir(destination, { recursive: true });
for (const migration of ['001-initial.sql', '002-attempt-foreign-keys.sql', '003-qualified-profile.sql', '004-job-output-root.sql', '005-v2-attempt-intent.sql', '006-publication-visual-intent.sql']) {
  await copyFile(resolve(root, '../src/migrations', migration), resolve(destination, migration));
}
