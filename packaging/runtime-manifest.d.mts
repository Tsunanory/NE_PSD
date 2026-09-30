export type RuntimeManifest = {
  schemaVersion: 2; platform: 'win32-x64'; status: 'blocked' | 'ready';
  node: { version: string; abi: string; archiveSha256: string; executable: string; args: string[] };
  electron: { version: string; abi: string; integrity: string };
  files: Array<{ path: string; sha256: string; bytes: number; role: string; consumer: string; abi: string; arch: string; licensePath: string; qualificationEvidence: string }>;
  packages: Array<{ name: string; version: string; packageJson: string; dependencies: string[] }>;
  fitModes: { cover: string; contain: string; stretch: string }; missing: string[];
};
export function validateManifest(value: unknown): RuntimeManifest;
export function verifyBundle(manifest: unknown, staged: string): { files: number; packages: number };
export function prepareResources(manifest: unknown, vendor: string, staged: string): { files: number; staged: string };
