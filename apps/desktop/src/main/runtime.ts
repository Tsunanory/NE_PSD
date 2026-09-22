import type { JobService, SetupService } from '@ne-psd/contracts';
export type RuntimeServices = { jobs: JobService; setup: SetupService };
export function createRuntime(services: RuntimeServices): RuntimeServices { return services; }
