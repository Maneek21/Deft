import { z } from 'zod';
import { AppRunSafeOutcomeSchema, ModuleResourceRefV1Schema, type ModuleActor } from '@deft/shared';
import {
  agentActions,
  appActionBindings,
  appRuns,
  orgMembers,
  moduleRecordMerges,
  moduleRecords,
} from '@deft/db/schema';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from './db.js';
import { getModuleRecord } from './module-service.js';
import { AppRunError } from './app-run-errors.js';
import { approvedAppRunReviewerCondition } from './app-run-authorization.js';

export const ModuleAppRunHistoryInputSchema = z.strictObject({
  resource_ref: ModuleResourceRefV1Schema,
  before: z.strictObject({ created_at: z.iso.datetime(), id: z.string().min(1).max(256) }).optional(),
  limit: z.number().int().min(1).max(25).default(10),
});

export const ModuleAppRunOutcomesInputSchema = z.strictObject({
  resource_refs: z.array(ModuleResourceRefV1Schema).min(1).max(100),
}).superRefine((input, ctx) => {
  const [first] = input.resource_refs;
  if (!first) return;
  const seen = new Set<string>();
  input.resource_refs.forEach((ref, index) => {
    if (
      ref.provider.provider_instance_id !== first.provider.provider_instance_id
      || ref.resource_type !== first.resource_type
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['resource_refs', index],
        message: 'All resource references must share one module collection',
      });
    }
    if (seen.has(ref.resource_id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['resource_refs', index, 'resource_id'],
        message: 'Resource references must be unique',
      });
    }
    seen.add(ref.resource_id);
  });
});

type RawOutcomeRow = {
  resource_id: string;
  run_id: string;
  operation_name: string;
  state: string;
  created_at: Date | string;
  updated_at: Date | string;
  safe_outcome: unknown;
  is_sandbox: boolean;
  from_merged_record: boolean;
};

function projectOutcome(row: RawOutcomeRow) {
  const parsed = row.safe_outcome == null ? null : AppRunSafeOutcomeSchema.safeParse(row.safe_outcome);
  const outcome = parsed?.success ? parsed.data : null;
  return {
    resource_id: row.resource_id,
    run_id: row.run_id,
    operation_name: row.operation_name,
    state: row.state,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    provider_call_attempted: outcome?.provider_call_attempted ?? false,
    outcome_success: outcome?.success ?? null,
    error_code: outcome?.error_code ?? null,
    environment: row.is_sandbox ? 'sandbox' as const : 'unknown' as const,
    from_merged_record: row.from_merged_record,
  };
}

/** Return one current, safe App execution outcome per live record.
 * This endpoint deliberately rejects mixed collections and partial authority
 * instead of becoming a record-existence oracle. */
export async function listModuleAppRunOutcomes(actor: ModuleActor, inputValue: unknown) {
  const input = ModuleAppRunOutcomesInputSchema.parse(inputValue);
  if (actor.kind !== 'human' || actor.source !== 'ui') throw new AppRunError('APP_RUN_ACCESS_DENIED');
  const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers).where(and(
    eq(orgMembers.org_id, actor.org_id), eq(orgMembers.user_id, actor.actor_id), eq(orgMembers.is_active, true),
  )).limit(1);
  if (!membership) throw new AppRunError('APP_RUN_ACCESS_DENIED');

  const refs = input.resource_refs;
  const first = refs[0]!;
  const currentActor = { ...actor, role: membership.role } as ModuleActor;
  const firstRecord = await getModuleRecord(currentActor, first.resource_id).catch(() => {
    throw new AppRunError('APP_RUN_ACCESS_DENIED');
  });
  const installationId = first.provider.provider_instance_id;
  const collectionKey = first.resource_type;
  if (firstRecord.installation_id !== installationId || firstRecord.collection_key !== collectionKey) {
    throw new AppRunError('APP_RUN_ACCESS_DENIED');
  }
  const resourceIds = refs.map(ref => ref.resource_id);
  const liveRecords = await db.select({ id: moduleRecords.id }).from(moduleRecords).where(and(
    eq(moduleRecords.org_id, actor.org_id),
    eq(moduleRecords.installation_id, installationId),
    eq(moduleRecords.collection_key, collectionKey),
    eq(moduleRecords.is_deleted, false),
    inArray(moduleRecords.id, resourceIds),
  ));
  if (liveRecords.length !== resourceIds.length) throw new AppRunError('APP_RUN_ACCESS_DENIED');

  const requestedValues = sql.join(resourceIds.map(resourceId => sql`(${resourceId}::text)`), sql`, `);
  const resourceKind = `module:${installationId}:${collectionKey}`;
  const result = await db.execute(sql<RawOutcomeRow>`
    WITH RECURSIVE requested(resource_id) AS (
      VALUES ${requestedValues}
    ), history_sources(root_record_id, record_id, through_time) AS (
      SELECT requested.resource_id, requested.resource_id, 'infinity'::timestamp
      FROM requested
      UNION
      SELECT history_sources.root_record_id, ${moduleRecordMerges.source_record_id},
        least(history_sources.through_time, ${moduleRecordMerges.created_at})
      FROM history_sources
      INNER JOIN ${moduleRecordMerges}
        ON ${moduleRecordMerges.target_record_id} = history_sources.record_id
       AND ${moduleRecordMerges.org_id} = ${actor.org_id}
       AND ${moduleRecordMerges.installation_id} = ${installationId}
      INNER JOIN ${moduleRecords}
        ON ${moduleRecords.id} = ${moduleRecordMerges.source_record_id}
       AND ${moduleRecords.org_id} = ${actor.org_id}
       AND ${moduleRecords.installation_id} = ${installationId}
       AND ${moduleRecords.collection_key} = ${collectionKey}
    ), ranked AS (
      SELECT
        history_sources.root_record_id AS resource_id,
        ${appRuns.id} AS run_id,
        ${appRuns.operation_name},
        ${appRuns.state},
        ${appRuns.created_at},
        ${appRuns.updated_at},
        ${appRuns.safe_outcome},
        (${appActionBindings.interface_identity} =
          'deft.private.v1:' || lower(${appRuns.org_id}) || ':' ||
          lower(${appRuns.origin_app_installation_id}) || ':sandbox_email_send:v1') AS is_sandbox,
        (history_sources.record_id <> history_sources.root_record_id) AS from_merged_record,
        row_number() OVER (
          PARTITION BY history_sources.root_record_id
          ORDER BY ${appRuns.created_at} DESC, ${appRuns.id} DESC,
            (history_sources.record_id = history_sources.root_record_id) DESC
        ) AS outcome_rank
      FROM history_sources
      INNER JOIN ${appRuns}
        ON ${appRuns.org_id} = ${actor.org_id}
       AND ${appRuns.origin_kind} = 'app'
       AND ${appRuns.created_at} <= history_sources.through_time
       AND ${appRuns.safe_preview}->'resource_refs' @> jsonb_build_array(jsonb_build_object(
         'resource_kind', ${resourceKind}::text,
         'resource_id', history_sources.record_id
       ))
      LEFT JOIN ${appActionBindings}
        ON ${appActionBindings.org_id} = ${appRuns.org_id}
       AND ${appActionBindings.app_installation_id} = ${appRuns.origin_app_installation_id}
       AND ${appActionBindings.app_version_id} = ${appRuns.origin_app_version_id}
       AND ${appActionBindings.grant_snapshot_id} = ${appRuns.origin_app_grant_snapshot_id}
       AND ${appActionBindings.action_key} = ${appRuns.origin_app_binding_key}
       AND ${appActionBindings.provider_kind} = ${appRuns.provider_kind}
       AND ${appActionBindings.mcp_connection_id} = ${appRuns.provider_instance_id}
       AND ${appActionBindings.operation_name} = ${appRuns.operation_name}
       AND ${appActionBindings.provider_snapshot_id} = ${appRuns.provider_snapshot_id}
    )
    SELECT resource_id, run_id, operation_name, state, created_at, updated_at,
      safe_outcome, is_sandbox, from_merged_record
    FROM ranked
    WHERE outcome_rank = 1
  `);
  const rows = (((result as unknown as { rows?: RawOutcomeRow[] }).rows ?? result) as unknown) as RawOutcomeRow[];
  const byResourceId = new Map(rows.map(row => [row.resource_id, projectOutcome(row)]));
  return { outcomes: resourceIds.flatMap(resourceId => {
    const outcome = byResourceId.get(resourceId);
    return outcome ? [outcome] : [];
  }) };
}

/** Shared record history is intentionally smaller than an actor-authorized Run.
 * Never add arbitrary preview, provider, recipient or result fields here. */
export async function listModuleAppRunHistory(actor: ModuleActor, inputValue: unknown) {
  const input = ModuleAppRunHistoryInputSchema.parse(inputValue);
  if (actor.kind !== 'human' || actor.source !== 'ui') throw new AppRunError('APP_RUN_ACCESS_DENIED');
  const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers).where(and(
    eq(orgMembers.org_id, actor.org_id), eq(orgMembers.user_id, actor.actor_id), eq(orgMembers.is_active, true),
  )).limit(1);
  if (!membership) throw new AppRunError('APP_RUN_ACCESS_DENIED');
  const ref = input.resource_ref;
  const record = await getModuleRecord({ ...actor, role: membership.role }, ref.resource_id).catch(() => {
    throw new AppRunError('APP_RUN_ACCESS_DENIED');
  });
  if (record.installation_id !== ref.provider.provider_instance_id || record.collection_key !== ref.resource_type) {
    throw new AppRunError('APP_RUN_ACCESS_DENIED');
  }
  const source = JSON.stringify([{ resource_kind: `module:${ref.provider.provider_instance_id}:${ref.resource_type}`, resource_id: ref.resource_id }]);
  const resourceKind = `module:${ref.provider.provider_instance_id}:${ref.resource_type}`;
  const lineageQuery = sql`(
    WITH RECURSIVE sources(record_id, through_time) AS (
      SELECT ${ref.resource_id}::text, 'infinity'::timestamp
      UNION
      SELECT ${moduleRecordMerges.source_record_id}, least(sources.through_time, ${moduleRecordMerges.created_at})
      FROM ${moduleRecordMerges}
      INNER JOIN sources ON sources.record_id = ${moduleRecordMerges.target_record_id}
      INNER JOIN ${moduleRecords} ON ${moduleRecords.id} = ${moduleRecordMerges.source_record_id}
        AND ${moduleRecords.org_id} = ${actor.org_id}
        AND ${moduleRecords.installation_id} = ${ref.provider.provider_instance_id}
        AND ${moduleRecords.collection_key} = ${ref.resource_type}
      WHERE ${moduleRecordMerges.org_id} = ${actor.org_id}
        AND ${moduleRecordMerges.installation_id} = ${ref.provider.provider_instance_id}
    ) SELECT record_id, through_time FROM sources
  ) AS resolved_history_sources`;
  const lineage = db.$with('history_sources').as(db.select({
    record_id: sql<string>`record_id`.as('record_id'),
    through_time: sql<Date>`through_time`.as('through_time'),
  }).from(lineageQuery));
  const rows = await db.with(lineage).select({
    from_merged_record: sql<boolean>`NOT (${appRuns.safe_preview}->'resource_refs' @> ${source}::jsonb)`,
    id: appRuns.id,
    operation_name: appRuns.operation_name,
    state: appRuns.state,
    created_at: appRuns.created_at,
    updated_at: appRuns.updated_at,
    provider_call_attempted: sql<boolean>`coalesce((${appRuns.safe_outcome}->>'provider_call_attempted')::boolean, false)`,
    safe_outcome: appRuns.safe_outcome,
    is_sandbox: sql<boolean>`(${appActionBindings.interface_identity} =
      'deft.private.v1:' || lower(${appRuns.org_id}) || ':' ||
      lower(${appRuns.origin_app_installation_id}) || ':sandbox_email_send:v1')`,
    can_inspect_receipts: sql<boolean>`(
      (${appRuns.initiating_actor_type} = 'human' AND ${appRuns.initiating_actor_id} = ${actor.actor_id})
      OR (${appRuns.execution_actor_type} = 'human' AND ${appRuns.execution_actor_id} = ${actor.actor_id})
      OR EXISTS (SELECT 1 FROM ${agentActions} WHERE ${approvedAppRunReviewerCondition(actor.org_id, appRuns.id, actor.actor_id)})
    )`,
  }).from(appRuns).leftJoin(appActionBindings, and(
    eq(appActionBindings.org_id, appRuns.org_id),
    eq(appActionBindings.app_installation_id, appRuns.origin_app_installation_id),
    eq(appActionBindings.app_version_id, appRuns.origin_app_version_id),
    eq(appActionBindings.grant_snapshot_id, appRuns.origin_app_grant_snapshot_id),
    eq(appActionBindings.action_key, appRuns.origin_app_binding_key),
    eq(appActionBindings.provider_kind, appRuns.provider_kind),
    eq(appActionBindings.mcp_connection_id, appRuns.provider_instance_id),
    eq(appActionBindings.operation_name, appRuns.operation_name),
    eq(appActionBindings.provider_snapshot_id, appRuns.provider_snapshot_id),
  )).where(and(
    eq(appRuns.org_id, actor.org_id), eq(appRuns.origin_kind, 'app'),
    sql`EXISTS (SELECT 1 FROM history_sources WHERE ${appRuns.created_at} <= history_sources.through_time
      AND ${appRuns.safe_preview}->'resource_refs' @> jsonb_build_array(jsonb_build_object(
        'resource_kind', ${resourceKind}::text, 'resource_id', history_sources.record_id)))`,
    ...(input.before ? [or(
      lt(appRuns.created_at, new Date(input.before.created_at)),
      and(eq(appRuns.created_at, new Date(input.before.created_at)), lt(appRuns.id, input.before.id)),
    )] : []),
  )).orderBy(desc(appRuns.created_at), desc(appRuns.id)).limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    runs: page.map(row => {
      const parsed = row.safe_outcome == null ? null : AppRunSafeOutcomeSchema.safeParse(row.safe_outcome);
      const outcome = parsed?.success ? parsed.data : null;
      const { safe_outcome: _safeOutcome, is_sandbox: isSandbox, ...safeRow } = row;
      return {
        ...safeRow,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
        outcome_success: outcome?.success ?? null,
        error_code: outcome?.error_code ?? null,
        environment: isSandbox ? 'sandbox' as const : 'unknown' as const,
      };
    }),
    next_cursor: rows.length > input.limit && last ? { created_at: last.created_at.toISOString(), id: last.id } : null,
  };
}
