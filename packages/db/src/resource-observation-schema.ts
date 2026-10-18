import {pgTable,text,timestamp,jsonb,primaryKey,index,uniqueIndex,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
export const appResourceObservationConsents=pgTable('app_resource_observation_consents',{
 org_id:text('org_id').notNull(),owner_user_id:text('owner_user_id').notNull(),consent_id:text('consent_id').notNull(),
 resource_binding_id:text('resource_binding_id').notNull(),connection_session_id:text('connection_session_id').notNull(),
 state:text('state').notNull(),consent_digest:text('consent_digest').notNull(),snapshot:jsonb('snapshot').$type<Record<string,unknown>>().notNull(),
 expires_at:timestamp('expires_at',{withTimezone:true}),created_at:timestamp('created_at',{withTimezone:true}).notNull(),
 updated_at:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.org_id,t.consent_id]}),index('app_resource_observation_active_idx').on(t.org_id,t.resource_binding_id,t.state),
 check('app_resource_observation_state',sql`${t.state} IN ('proposed','active','revoked')`),
 uniqueIndex('app_resource_observation_one_active').on(t.org_id,t.resource_binding_id).where(sql`${t.state}='active'`),
 check('app_resource_observation_digest',sql`${t.consent_digest} ~ '^sha256:[a-f0-9]{64}$'`),
 check('app_resource_observation_bound',sql`octet_length(${t.snapshot}::text)<=16384`)]);
export const appResourceObservationRuns=pgTable('app_resource_observation_runs',{
 org_id:text('org_id').notNull(),run_id:text('run_id').notNull(),consent_id:text('consent_id').notNull(),
 consent_digest:text('consent_digest').notNull(),created_at:timestamp('created_at',{withTimezone:true}).notNull(),
 updated_at:timestamp('updated_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.org_id,t.run_id]}),check('app_resource_observation_run_digest',sql`${t.consent_digest} ~ '^sha256:[a-f0-9]{64}$'`),
 check('app_resource_observation_run_dates',sql`isfinite(${t.created_at}) AND isfinite(${t.updated_at}) AND ${t.updated_at}>=${t.created_at}`)]);
// Composite FKs and the closed JSON identity/immutability guards are SQL extras.
// This avoids a schema barrel cycle; fresh push executes immutable preview98.
