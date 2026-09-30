declare const process: { platform: string; cwd(): string; argv: string[]; exitCode?: number };
declare const console: { log(message: string): void; error(message: string): void };
declare module 'node:fs/promises' {
  export interface FileHandle { read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>; stat(): Promise<{ isFile(): boolean; size: number; dev: number; ino: number }>; close(): Promise<void>; }
  export function open(path: string, flags: number): Promise<FileHandle>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function stat(path: string): Promise<{ isFile(): boolean; size: number }>;
 export function lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  export function realpath(path: string): Promise<string>;
}
declare module 'node:fs' { export const constants: { O_RDONLY: number; O_NOFOLLOW: number }; }
declare module 'node:path' { export function resolve(...parts: string[]): string; export function dirname(path: string): string; export function relative(from: string, to: string): string; export function isAbsolute(path: string): boolean; export const sep: string; export const win32: { isAbsolute(path: string): boolean }; }
declare module 'node:url' { export function fileURLToPath(url: URL): string; }
declare module 'node:crypto' { interface Hash { update(data: Uint8Array | string): Hash; digest(encoding: 'hex'): string; } export function createHash(name: string): Hash; export function randomUUID(): string; }
