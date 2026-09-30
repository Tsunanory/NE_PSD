import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const consumer = process.argv[2];
const moduleRoot = process.argv[3];
const manifest = JSON.parse(read(join(root, 'packaging/runtime-manifest.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64' || !['electron', 'standalone-node'].includes(consumer) || !moduleRoot || manifest.status !== 'ready') {
  console.error('BLOCKED — Windows x64, ready manifest, consumer and module root required'); process.exit(2);
}
const expectedAbi = consumer === 'electron' ? manifest.electron.abi : manifest.node.abi;
if (process.versions.modules !== expectedAbi || (consumer === 'electron') !== Boolean(process.versions.electron)) {
  console.error(`BLOCKED — ${consumer} ABI mismatch: ${process.versions.modules} != ${expectedAbi}`); process.exit(2);
}
const require = createRequire(resolve(moduleRoot, 'package.json'));
const Database = require('better-sqlite3');
const sharp = require('sharp');
const temp = mkdtempSync(join(tmpdir(), 'ne-psd-native-'));
try {
  const db = new Database(join(temp, 'smoke.db'));
  try {
    db.exec('CREATE TABLE t (v TEXT NOT NULL)'); db.prepare('INSERT INTO t(v) VALUES (?)').run('проверка');
    if (db.prepare('SELECT v FROM t').get().v !== 'проверка') throw new Error('SQLite read mismatch');
    db.prepare('DELETE FROM t').run(); if (db.prepare('SELECT COUNT(*) AS n FROM t').get().n !== 0) throw new Error('SQLite delete mismatch');
  } finally { db.close(); }
  const fixture = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#ff0000' } }).png().toBuffer();
  writeFileSync(join(temp, 'fixture.png'), fixture);
  for (const format of ['jpeg', 'png']) {
    const output = await sharp(readFileSync(join(temp, 'fixture.png')))[format]().toBuffer();
    const info = await sharp(output).metadata();
    if (info.width !== 2 || info.height !== 3 || info.format !== format) throw new Error(`Sharp ${format} mismatch`);
  }
  console.log(JSON.stringify({ consumer, abi: process.versions.modules, sqlite: 'pass', sharp: 'pass' }));
} finally { rmSync(temp, { recursive: true, force: true }); }
