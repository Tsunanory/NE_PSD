import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLock, type SessionLockOptions } from '../../packages/photoshop/src/session-lock.js';

const options = (lockPath: string, overrides: Partial<SessionLockOptions> = {}): SessionLockOptions => ({
  lockPath,
  installationPath: '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app',
  hostId: 'host-a',
  installationDigest: 'a'.repeat(64),
  pid: 101,
  processStartIdentity: 'start-a',
  now: () => 1000,
  randomToken: () => 'token-a',
  ...overrides,
});

describe('Photoshop installation session lock', () => {
  it('allows one owner and reports a healthy contender as busy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lockPath = join(root, 'photoshop.lock');
    const owner = new SessionLock(options(lockPath));
    const contender = new SessionLock(options(lockPath, { pid: 102, processStartIdentity: 'start-b' }));
    expect((await owner.tryAcquire({ jobId: 'job-a', journalPath: 'journal-a' })).acquired).toBe(true);
    expect(await contender.tryAcquire({ jobId: 'job-b', journalPath: 'journal-b' })).toEqual({ acquired: false, reason: 'PHOTOSHOP_BUSY' });
    await owner.release();
    await rm(root, { recursive: true, force: true });
  });

  it('serializes two independent Node processes against one lock directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lockPath = join(root, 'photoshop.lock');
    const installationPath = normalize(resolve('/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app'));
    const metadata = JSON.stringify({ schemaVersion: 1, hostId: 'host-a', installationPath, installationDigest: 'a'.repeat(64), pid: 12345, processStartIdentity: 'child-start', operationId: 'child-job', ownershipToken: 'child-token', journalPath: 'child-journal', heartbeatAt: 1000, inFlight: 0, unknownMutation: false, reconciledJobOwnedDocuments: true });
    const script = `const fs=require('node:fs/promises'); (async()=>{await fs.mkdir(process.argv[1]); await fs.writeFile(process.argv[1]+'/owner.json', process.argv[2]); console.log('ready'); setInterval(()=>{},1000)})()`;
    const child = spawn(process.execPath, ['-e', script, lockPath, metadata], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(child.stdout!, 'data');
    const contender = new SessionLock(options(lockPath, { pid: 101, processStartIdentity: 'start-a' }));
    await expect(contender.tryAcquire()).resolves.toEqual({ acquired: false, reason: 'PHOTOSHOP_BUSY' });
    child.kill();
    await rm(root, { recursive: true, force: true });
  });

  it('persists identity and ownership before use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lockPath = join(root, 'photoshop.lock');
    const owner = new SessionLock(options(lockPath));
    await expect(owner.acquire({ jobId: 'job-a', journalPath: 'journal-a' })).resolves.toMatchObject({ acquired: true, operationId: 'job-a' });
    const metadata = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as Record<string, unknown>;
    expect(metadata).toMatchObject({ hostId: 'host-a', pid: 101, processStartIdentity: 'start-a', operationId: 'job-a', ownershipToken: 'token-a', journalPath: 'journal-a' });
    await owner.release();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects missing process identity or an unqualified installation digest', async () => {
    const lockPath = join(await mkdtemp(join(tmpdir(), 'ne-psd-lock-')), 'photoshop.lock');
    expect(() => new SessionLock({ ...options(lockPath), processStartIdentity: '' })).toThrow('processStartIdentity is required');
    expect(() => new SessionLock({ ...options(lockPath), installationDigest: 'not-a-digest' })).toThrow('installationDigest');
  });

  it('fails closed for malformed, foreign and pid-reused locks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lockPath = join(root, 'photoshop.lock');
    await mkdir(lockPath);
    const contender = new SessionLock(options(lockPath));
    await writeFile(join(lockPath, 'owner.json'), '{bad');
    await expect(contender.tryAcquire()).resolves.toEqual({ acquired: false, reason: 'RECOVERY_REQUIRED' });
    const valid = { schemaVersion: 1, hostId: 'host-a', pid: 101, processStartIdentity: 'start-a', operationId: 'x', ownershipToken: 'x', journalPath: 'j', installationPath: options(lockPath).installationPath, installationDigest: 'a'.repeat(64), heartbeatAt: 1, inFlight: 0, unknownMutation: false, reconciledJobOwnedDocuments: true };
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ ...valid, hostId: 'other' }));
    await expect(contender.tryAcquire()).resolves.toEqual({ acquired: false, reason: 'RECOVERY_REQUIRED' });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ ...valid, processStartIdentity: 'different' }));
    await expect(contender.tryAcquire()).resolves.toEqual({ acquired: false, reason: 'RECOVERY_REQUIRED' });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ ...valid, installationDigest: 'b'.repeat(64) }));
    await expect(contender.tryAcquire()).resolves.toEqual({ acquired: false, reason: 'RECOVERY_REQUIRED' });
    await rm(root, { recursive: true, force: true });
  });

  it('does not steal a dead owner with unknown mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lockPath = join(root, 'photoshop.lock');
    const owner = new SessionLock(options(lockPath));
    await owner.acquire({ jobId: 'job-a', journalPath: 'journal-a' });
    await owner.markUnknownMutation();
    const contender = new SessionLock(options(lockPath, { pid: 999, processStartIdentity: 'gone', isProcessAlive: () => false }));
    await expect(contender.tryAcquire()).resolves.toEqual({ acquired: false, reason: 'RECOVERY_REQUIRED' });
    await rm(root, { recursive: true, force: true });
  });

  it('releases only with the matching ownership token and retains the barrier while unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lockPath = join(root, 'photoshop.lock');
    const owner = new SessionLock(options(lockPath));
    await owner.acquire({ jobId: 'job-a', journalPath: 'journal-a' });
    const wrong = new SessionLock(options(lockPath, { randomToken: () => 'wrong' }));
    await expect(wrong.release()).resolves.toEqual({ released: false, reason: 'OWNERSHIP_MISMATCH' });
    await owner.markUnknownMutation();
    await expect(owner.release()).resolves.toEqual({ released: false, reason: 'RECOVERY_REQUIRED' });
    await rm(root, { recursive: true, force: true });
  });

  it('keeps a timed-out mutation barrier from overlapping a later operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lock = new SessionLock(options(join(root, 'photoshop.lock')));
    await expect(lock.runExclusive('job-a', async () => {
      await lock.markUnknownMutation();
      throw new Error('acknowledgement timeout');
    })).rejects.toThrow('acknowledgement timeout');
    const metadata = JSON.parse(await readFile(join(root, 'photoshop.lock', 'owner.json'), 'utf8')) as Record<string, unknown>;
    expect(metadata.inFlight).toBe(0);
    expect(metadata.unknownMutation).toBe(true);
    await expect(lock.runExclusive('job-b', async () => undefined)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await rm(root, { recursive: true, force: true });
  });

  it('durably records journal, token and in-flight state before callback work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lockPath = join(root, 'photoshop.lock');
    const lock = new SessionLock(options(lockPath));
    await lock.runExclusive('job-durable', async () => {
      const metadata = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as Record<string, unknown>;
      expect(metadata.operationId).toBe('job-durable');
      expect(metadata.ownershipToken).toBe('token-a');
      expect(metadata.journalPath).toContain('job-durable.json');
      expect(metadata.inFlight).toBe(1);
    });
    await rm(root, { recursive: true, force: true });
  });

  it('serializes queued calls and cancellation does not enter the queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ne-psd-lock-'));
    const lock = new SessionLock(options(join(root, 'photoshop.lock')));
    let inFlight = 0;
    let maximumInFlight = 0;
    let unblock!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const first = lock.runExclusive('job-a', async () => {
      inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
      started();
      await new Promise<void>((resolve) => { unblock = resolve; });
      inFlight--;
    });
    await startedPromise;
    const controller = new AbortController(); controller.abort();
    await expect(lock.runExclusive('job-b', async () => undefined, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    const second = lock.runExclusive('job-c', async () => { inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight); inFlight--; });
    unblock();
    await first; await second;
    expect(maximumInFlight).toBe(1);
    await rm(root, { recursive: true, force: true });
  });
});
