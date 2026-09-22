import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export function isAllowedNavigation(url: string, mode: 'development' | 'production'): boolean {
  if (mode === 'development') return url.startsWith('http://localhost:');
  return url.startsWith('file:///app/');
}

export function isAllowedRootHandle(input: { rootId: string; relativePath: string; roots: Record<string, string> }): boolean {
  const root = input.roots[input.rootId];
  if (!root || !input.relativePath || input.relativePath.includes('\\')) return false;
  const candidate = resolve(root, input.relativePath);
  const base = resolve(root);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) return false;
  if (existsSync(root) && existsSync(candidate)) {
    try { return realpathSync(candidate) === candidate || realpathSync(candidate).startsWith(`${realpathSync(root)}${sep}`); } catch { return false; }
  }
  return true;
}

export function installWindowPolicy(contents: { setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void; on(event: string, listener: (event: { preventDefault(): void }, url: string) => void): void }): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (!isAllowedNavigation(url, 'production')) event.preventDefault(); });
}
