export const FOUNDATION_SCHEMA_VERSION = 1 as const;

export type FoundationPackage = {
  packageName: string;
  schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
};

export function foundationPackage(packageName: string): FoundationPackage {
  return { packageName, schemaVersion: FOUNDATION_SCHEMA_VERSION };
}
