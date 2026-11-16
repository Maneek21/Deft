import { bigint, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** The newest seat statement this cell accepted from the hosted control plane
 * (hosted design note section 9), one row per cell ID. `highest_version` is
 * the floor: a statement with a lower version is refused. The statement
 * belongs to the cell, not to a workspace, so the row has no org_id.
 * Created by upgrade 0.3.0-preview.144 on both fresh installs and upgrades,
 * so it is exported as `@deft/db/seat-statements` rather than from schema.ts. */
export const seatStatements = pgTable('seat_statements', {
  cell_id: text('cell_id').primaryKey(),
  token: text('token').notNull(),
  seats: integer('seats').notNull(),
  version: bigint('version', { mode: 'number' }).notNull(),
  issued_at: bigint('issued_at', { mode: 'number' }).notNull(),
  expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
  highest_version: bigint('highest_version', { mode: 'number' }).notNull(),
  accepted_at: timestamp('accepted_at').defaultNow().notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull().$onUpdate(() => new Date()),
});
