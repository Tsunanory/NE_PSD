import { mkdtemp, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const prerequisiteMessages = { photoshop: 'Установите и активируйте Photoshop отдельно', model: 'Локальная модель недоступна. Запустите настроенный сервер и повторите проверку', output: 'Папка результатов недоступна для записи', runtime: 'Поставляемый runtime не подтверждён' } as const;
export type PrerequisiteInput = { photoshop: boolean; model: boolean; runtime: boolean; output: boolean };
export function evaluatePrerequisites(input: PrerequisiteInput): { ready: boolean; messages: string[] } {
  const messages: string[] = [];
  if (!input.photoshop) messages.push(prerequisiteMessages.photoshop);
  if (!input.model) messages.push(prerequisiteMessages.model);
  if (!input.runtime) messages.push(prerequisiteMessages.runtime);
  if (!input.output) messages.push(prerequisiteMessages.output);
  return { ready: messages.length === 0, messages };
}
export type PrerequisiteProbes = {
  photoshop: () => Promise<{ connected: boolean; controllerQualified: boolean; licenseVerified: boolean }>;
  model: () => Promise<{ reachable: boolean; artifactQualified: boolean }>;
  runtime: () => Promise<{ verified: boolean }>;
  output: () => Promise<{ writable: boolean; freeBytes: number }>;
};
export async function checkPrerequisites(probes: PrerequisiteProbes): Promise<{ ready: boolean; messages: string[]; checks: PrerequisiteInput; output: { writable: boolean; freeBytes: number } | null }> {
  async function probe<T>(fn: () => Promise<T>): Promise<T | null> { try { return await fn(); } catch { return null; } }
  const [photoshop, model, runtime, output] = await Promise.all([probe(probes.photoshop), probe(probes.model), probe(probes.runtime), probe(probes.output)]);
  const checks = { photoshop: Boolean(photoshop?.connected && photoshop.controllerQualified && photoshop.licenseVerified), model: Boolean(model?.reachable && model.artifactQualified), runtime: Boolean(runtime?.verified), output: Boolean(output?.writable) };
  return { ...evaluatePrerequisites(checks), checks, output };
}
export async function inspectOutputDirectory(path: string, minimumFreeBytes: number): Promise<{ writable: boolean; freeBytes: number; path: string }> {
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error('invalid free-space requirement');
  const directory = resolve(path);
  try {
    const storage = await statfs(directory);
    const freeBytes = storage.bavail * storage.bsize;
    if (freeBytes < minimumFreeBytes) return { writable: false, freeBytes, path: directory };
    const probe = await mkdtemp(join(directory, '.ne-psd-probe-'));
    try { await writeFile(join(probe, 'a'), 'x', { flag: 'wx' }); await rename(join(probe, 'a'), join(probe, 'b')); }
    finally { await rm(probe, { recursive: true, force: true }); }
    return { writable: true, freeBytes, path: directory };
  } catch { return { writable: false, freeBytes: 0, path: directory }; }
}
