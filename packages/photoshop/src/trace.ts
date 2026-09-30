import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CanonicalTraceRecord, DocumentTraceRecord } from './types.js';
import type { RenderRequest } from '@ne-psd/contracts';

export type TraceIdentity = { operationId: string; requestId: string };
export const renderTraceOperationId = (request: Pick<RenderRequest, 'jobId' | 'asset' | 'attempt'>): string => `${request.jobId}:${request.asset.assetId}:${request.attempt}`;

/** Persists the bytes observed at each boundary, so later file mutations cannot rewrite history. */
export class CanonicalTraceWriter {
  private sequence = 0;
  private readonly root: string;
  private readonly tracePath: string;
  constructor(bundleRoot: string, tracePath: string, private readonly identity: TraceIdentity) {
    this.root = resolve(bundleRoot);
    this.tracePath = resolve(tracePath);
    if (!identity.operationId || !identity.requestId || !inside(this.root, this.tracePath)) throw new TypeError('trace identity and bundle path are required');
  }
  private async safePath(path: string, createParent = false): Promise<string> {
    const target = resolve(path);
    if (!inside(this.root, target)) throw new TypeError('trace path escapes bundle');
    let current = this.root;
    for (const [index, part] of relative(this.root, target).split(sep).entries()) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (index < relative(this.root, target).split(sep).length - 1 && !info.isDirectory())) throw new TypeError('trace path traverses symlink or non-directory');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || !createParent) throw cause;
        if (current !== target) await mkdir(current);
      }
    }
    return target;
  }
  async event(event: string, outcome: CanonicalTraceRecord['outcome'], requestId = this.identity.requestId, detail?: DocumentTraceRecord): Promise<void> {
    await this.append({ schemaVersion: 1, phase: 'event', event, sequence: ++this.sequence, ...this.identity, requestId, outcome, ...(detail ? { detail } : {}) });
  }
  async bytes(phase: 'pre' | 'post', event: string, value: Uint8Array, requestId = this.identity.requestId): Promise<void> {
    const sequence = ++this.sequence;
    const snapshot = join(dirname(this.tracePath), `${basename(this.tracePath)}.snapshots`, `${sequence}.bin`);
    await this.safePath(snapshot, true);
    await writeFile(snapshot, value, { flag: 'wx' });
    await this.append({ schemaVersion: 1, phase, event, sequence, ...this.identity, requestId, outcome: 'acknowledged', path: relative(this.root, snapshot).split(sep).join('/'), bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') });
  }
  async file(phase: 'pre' | 'post', event: string, source: string, requestId = this.identity.requestId): Promise<void> { await this.bytes(phase, event, await readFile(source), requestId); }
  private async append(record: CanonicalTraceRecord): Promise<void> {
    await this.safePath(this.tracePath, true);
    await appendFile(this.tracePath, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

function inside(root: string, target: string): boolean { return target !== root && !relative(root, target).startsWith('..'+sep) && relative(root, target) !== '..' && !isAbsolute(relative(root, target)); }
