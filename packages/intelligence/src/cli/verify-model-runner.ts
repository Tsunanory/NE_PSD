import { verifyModel } from './verify-model.js';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const manifest = value('--manifest');
if (!manifest) { console.error('usage: verify-model --manifest PATH [--artifact-only] [--expected-platform PLATFORM] [--report PATH]'); process.exitCode = 2; } else {
  const options = { manifest: resolve(process.cwd(), '../..', manifest), artifactOnly: args.includes('--artifact-only') } as { manifest: string; artifactOnly: boolean; expectedPlatform?: string; report?: string };
  const platform = value('--expected-platform'); if (platform) options.expectedPlatform = platform;
  const report = value('--report'); if (report) options.report = resolve(process.cwd(), '../..', report);
  const result = await verifyModel(options);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
