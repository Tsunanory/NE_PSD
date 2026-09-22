import { resolve, sep } from 'node:path';
export function resolveRootPath(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  if (path !== resolve(root) && !path.startsWith(`${resolve(root)}${sep}`)) throw new Error('path escapes root');
  return path;
}
