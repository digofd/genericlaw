declare module "sql.js" {
  class Database {
    constructor(data?: ArrayLike<number> | Buffer | null);
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    close(): void;
    export(): Uint8Array;
  }

  class Statement {
    bind(params?: unknown[]): boolean;
    /** bind + step + reset numa chamada; para INSERT/UPDATE em lote. */
    run(params?: unknown[]): void;
    step(): boolean;
    getAsObject(params?: Record<string, unknown>): Record<string, unknown>;
    free(): boolean;
    get(params?: Record<string, unknown>): unknown[];
    reset(): void;
  }

  interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export { Database, Statement };
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;

  interface SqlJsStatic {
    Database: typeof Database;
  }
}