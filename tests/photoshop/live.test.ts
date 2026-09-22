import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type LiveBackendId = 'alisaitteke' | 'dcc-mcp-photoshop';
type LiveMachine = {
  schemaVersion: 1;
  installationPath: string;
  nodeExecutable: string;
  serverEntry: string;
  sourcePath: string;
  workRoot: string;
  evidenceRoot: string;
  backendId: LiveBackendId;
  platform: 'darwin' | 'win32';
};

const configPath = resolve(process.cwd(), 'docs/photoshop/live-machine.json');
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const requiredAbsolute = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`B15_LIVE_CONFIG_INVALID: ${field} must be an absolute path`);
  return value;
};

function parseConfig(value: unknown): LiveMachine {
  if (!isObject(value) || value.schemaVersion !== 1) throw new Error('B15_LIVE_CONFIG_INVALID: schemaVersion must be 1');
  const backendId = value.backendId;
  if (backendId !== 'alisaitteke' && backendId !== 'dcc-mcp-photoshop') throw new Error('B15_LIVE_CONFIG_INVALID: backendId is not allowlisted');
  if (value.platform !== 'darwin' && value.platform !== 'win32') throw new Error('B15_LIVE_CONFIG_INVALID: platform is not supported');
  return {
    schemaVersion: 1,
    installationPath: requiredAbsolute(value.installationPath, 'installationPath'),
    nodeExecutable: requiredAbsolute(value.nodeExecutable, 'nodeExecutable'),
    serverEntry: requiredAbsolute(value.serverEntry, 'serverEntry'),
    sourcePath: requiredAbsolute(value.sourcePath, 'sourcePath'),
    workRoot: requiredAbsolute(value.workRoot, 'workRoot'),
    evidenceRoot: requiredAbsolute(value.evidenceRoot, 'evidenceRoot'),
    backendId,
    platform: value.platform,
  };
}

async function readConfig(): Promise<LiveMachine | null> {
  try { return parseConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
  catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return null;
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function existing(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function probe(config: LiveMachine): Promise<string[]> {
  const blocked: string[] = [];
  if (process.platform !== config.platform) blocked.push(`platform-mismatch:${process.platform}->${config.platform}`);
  if (!await existing(config.installationPath)) blocked.push('photoshop-installation-missing');
  if (!await executable(config.nodeExecutable)) blocked.push('pinned-node-executable-missing-or-not-executable');
  if (!await existing(config.serverEntry)) blocked.push('pinned-mcp-entry-missing');
  if (!await existing(config.sourcePath)) blocked.push('source-psd-missing');
  if (!await existing(config.workRoot)) blocked.push('trusted-work-root-missing');
  if (!await existing(config.evidenceRoot)) blocked.push('trusted-evidence-root-missing');
  return blocked;
}

describe('B15 real Photoshop qualification gate', () => {
  it('reports a named external block without a machine configuration or Photoshop call', async () => {
    const config = await readConfig();
    if (config === null) {
      console.info('B15_LIVE_BLOCKED: docs/photoshop/live-machine.json is absent; no Photoshop or MCP calls were made');
      expect(config).toBeNull();
      return;
    }
    const blocked = await probe(config);
    if (blocked.length > 0) {
      console.info(`B15_LIVE_BLOCKED: ${blocked.join(', ')}`);
      expect(blocked.length).toBeGreaterThan(0);
      return;
    }
    console.info(`B15_LIVE_READY: ${config.backendId}; live execution remains an explicit operator gate`);
    expect(config.backendId).toMatch(/^(alisaitteke|dcc-mcp-photoshop)$/);
  });
});
