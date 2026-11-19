import pg from 'pg';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const TIMESTAMP_WITHOUT_TIME_ZONE = 1114;

export type SnapshotOptions = Readonly<{
  databaseUrl: string;
  /** Rows fetched per round trip; memory is bounded by this, not by the workspace's size. */
  batchSize?: number;
  /** Test seam: called with the number of rows each FETCH returned. */
  onFetch?: (rows: number) => void;
  /** The one schema Deft's tables live in. Every query of the export reads from it alone. */
  schema?: string;
}>;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * One read-only REPEATABLE READ transaction on one connection. Every dataset
 * is read through it, so all of them describe the same moment. Deft stores
 * `timestamp` columns in UTC; they are read as UTC whatever the local zone.
 *
 * Before any other query the transaction pins its search path to pg_catalog
 * and one named schema, so no setting of the database, the role or the
 * connection can make a query read a table from anywhere else. Every query
 * of the export goes through this one transaction.
 */
export class Snapshot {
  private cursorCounter = 0;
  private constructor(
    private readonly client: pg.Client,
    private readonly batchSize: number,
    private readonly onFetch: ((rows: number) => void) | undefined,
    readonly asOf: Date,
    readonly schema: string,
  ) {}

  static async open(options: SnapshotOptions): Promise<Snapshot> {
    const batchSize = options.batchSize ?? 500;
    const schema = options.schema ?? 'public';
    if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid schema name: ${JSON.stringify(schema)}`);
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('Invalid batch size');
    const client = new pg.Client({
      connectionString: options.databaseUrl,
      application_name: 'deft-workspace-export',
      types: {
        getTypeParser: ((oid: number, format?: 'text' | 'binary') => oid === TIMESTAMP_WITHOUT_TIME_ZONE
          ? (value: string) => new Date(`${value.replace(' ', 'T')}Z`)
          : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
      },
    });
    await client.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL search_path TO pg_catalog, "${schema}"`);
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      // The snapshot is taken by the first statement; now() is the transaction start.
      const result = await client.query<{ as_of: Date }>('SELECT now() AS as_of');
      return new Snapshot(client, batchSize, options.onFetch, result.rows[0]!.as_of, schema);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Refuses unless every named table exists in the pinned schema as an
   * ordinary or partitioned table (not a view or foreign table) and an
   * unqualified name resolves to exactly that table.
   */
  async requireTables(tables: readonly string[]): Promise<void> {
    const wrong: string[] = [];
    for (const table of tables) {
      const { rows } = await this.client.query<{ ok: boolean }>(
        `SELECT to_regclass(quote_ident($2)) IS NOT NULL AND to_regclass(quote_ident($2)) = to_regclass(quote_ident($1) || '.' || quote_ident($2))
          AND (SELECT relkind FROM pg_class WHERE oid = to_regclass(quote_ident($2))) IN ('r', 'p') AS ok`,
        [this.schema, table]);
      if (!rows[0]?.ok) wrong.push(table);
    }
    if (wrong.length) {
      throw new Error(`Deft's tables are not all plain tables in the schema "${this.schema}" (not found there: ${wrong.join(', ')}). Pass the schema Deft is installed in.`);
    }
  }

  /** Runs a small query whose result is expected to fit in memory (lookups, single rows). */
  async all<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
    const { sql, params } = dialect.sqlToQuery(query);
    return (await this.client.query<T>(sql, params)).rows;
  }

  /** Streams a query's rows in batches through a server-side cursor. */
  async *rows<T extends Record<string, unknown>>(query: SQL): AsyncGenerator<T> {
    const { sql, params } = dialect.sqlToQuery(query);
    const cursor = `deft_export_${++this.cursorCounter}`;
    await this.client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${sql}`, params);
    let failed = false;
    try {
      for (;;) {
        const batch = await this.client.query<T>(`FETCH ${this.batchSize} FROM ${cursor}`);
        this.onFetch?.(batch.rows.length);
        for (const row of batch.rows) yield row;
        if (batch.rows.length < this.batchSize) break;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Also runs when the consumer stops early. After a failed statement the
      // transaction is aborted and CLOSE fails too; the first error wins.
      try {
        await this.client.query(`CLOSE ${cursor}`);
      } catch (closeError) {
        if (!failed) throw closeError;
      }
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.query('ROLLBACK');
    } finally {
      await this.client.end();
    }
  }
}
