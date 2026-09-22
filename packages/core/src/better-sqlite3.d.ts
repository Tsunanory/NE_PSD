declare module 'better-sqlite3' {
  class Statement {
    run(...parameters: unknown[]): { changes: number };
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  }
  class Database {
    constructor(path: string);
    pragma(value: string): unknown;
    exec(value: string): void;
    prepare(value: string): Statement;
    transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
    close(): void;
  }
  export default Database;
}
