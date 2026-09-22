declare const process: { platform: string };
declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function stat(path: string): Promise<{ isFile(): boolean; size: number }>;
}
declare module 'node:path' { export function resolve(...parts: string[]): string; export function dirname(path: string): string; }
declare module 'node:crypto' { interface Hash { update(data: Uint8Array | string): Hash; digest(encoding: 'hex'): string; } export function createHash(name: string): Hash; }
