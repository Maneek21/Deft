import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type Transaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/** Table queries carry their own columns and codecs. Shared helpers need no
 * relational schema, client handles or driver internals. Nested callbacks keep
 * the same contract even when the caller uses a schema-less bounded client. */
export type CoreDatabaseTransaction = Pick<Transaction,
  'select' | 'selectDistinct' | 'selectDistinctOn' | 'insert' | 'update' | 'delete' | 'execute' | 'rollback'> & {
  transaction<T>(work: (tx: CoreDatabaseTransaction) => Promise<T>): Promise<T>;
};
