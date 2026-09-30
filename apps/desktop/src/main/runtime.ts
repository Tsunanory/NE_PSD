import type { JobService, SetupService } from '@ne-psd/contracts';
import { spawn } from 'node:child_process';
import { runtimeSpawnOptions, verifyPackagedResources } from './packaged-runtime.js';
export type RuntimeServices = { jobs: JobService; setup: SetupService };
export function createRuntime(services: RuntimeServices): RuntimeServices { return services; }
export async function launchPackagedMcp(resourcesPath: string, sourceEnv: NodeJS.ProcessEnv = process.env): Promise<ReturnType<typeof spawn>> {
  const paths = await verifyPackagedResources(resourcesPath);
  const command = runtimeSpawnOptions(paths, sourceEnv);
  return spawn(command.command, command.args, command.options);
}
