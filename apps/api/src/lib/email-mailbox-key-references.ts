import { and, eq, inArray, sql } from 'drizzle-orm';
import { events, wikiPages, emailKnowledgeBudgets } from '@deft/db/schema';
import { z } from 'zod';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppRunKeyReference } from './app-run-keyrings.js';

const reference = z.strictObject({ purpose: z.literal('run_encryption'),
  key_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u) });

/** Bootstrap/retirement inventory, never a mailbox hot-path query. Include
 * retained ciphertext for paused, disconnected and revoked accounts too. */
export async function listEmailMailboxKeyReferences(tx: Pick<AppRunTransaction, 'execute'>,
  orgId?: string): Promise<readonly AppRunKeyReference[]> {
  const org = orgId === undefined ? null : z.string().uuid().parse(orgId);
  const tables = await tx.execute(sql`SELECT to_regclass('email_messages') IS NOT NULL AS messages,
    to_regclass('email_checkpoints') IS NOT NULL AS checkpoints,
    to_regclass('email_provider_states') IS NOT NULL AS provider_states,
    to_regclass('email_imap_credentials') IS NOT NULL AS imap_credentials,
    to_regclass('email_drafts') IS NOT NULL AS drafts,
    to_regclass('email_operations') IS NOT NULL AS operations,
    to_regclass('email_send_operations') IS NOT NULL AS send_operations,
    to_regclass('email_attachments') IS NOT NULL AS attachments,
    to_regclass('email_provider_draft_mirrors') IS NOT NULL AS provider_draft_mirrors,
    to_regclass('email_outbox') IS NOT NULL AS outbox,
    to_regclass('email_outbox_events') IS NOT NULL AS outbox_events,
    to_regclass('email_templates') IS NOT NULL AS templates,
    to_regclass('email_signatures') IS NOT NULL AS signatures,
    to_regclass('email_imap_aliases') IS NOT NULL AS imap_aliases,
    to_regclass('email_imap_move_reservations') IS NOT NULL AS imap_move_reservations,
    to_regclass('email_timers') IS NOT NULL AS timers,
    to_regclass('email_presentation_cache') IS NOT NULL AS presentation_cache,
    to_regclass('email_account_consents') IS NOT NULL AS account_consents,
    to_regclass('email_rules') IS NOT NULL AS rules,
    to_regclass('email_rule_receipts') IS NOT NULL AS rule_receipts,
    to_regclass('email_native_connection_requests') IS NOT NULL AS native_connection_requests,
    to_regclass('email_native_account_connections') IS NOT NULL AS native_account_connections,
    to_regclass('email_notification_events') IS NOT NULL AS notification_events,
    to_regclass('email_notification_states') IS NOT NULL AS notification_states,
    to_regclass('email_calendar_invitations') IS NOT NULL AS calendar_invitations,
    to_regclass('email_calendar_invitation_actions') IS NOT NULL AS calendar_invitation_actions`);
  const present = z.strictObject({ messages: z.boolean(), checkpoints: z.boolean(), provider_states:z.boolean(),imap_credentials:z.boolean(),drafts:z.boolean(),operations:z.boolean(),send_operations:z.boolean(),attachments:z.boolean(),provider_draft_mirrors:z.boolean(),outbox:z.boolean(),outbox_events:z.boolean(),templates:z.boolean(),signatures:z.boolean(),imap_aliases:z.boolean().default(false),imap_move_reservations:z.boolean().default(false),timers:z.boolean().default(false),presentation_cache:z.boolean().default(false),account_consents:z.boolean().default(false),rules:z.boolean().default(false),rule_receipts:z.boolean().default(false),native_connection_requests:z.boolean().default(false),native_account_connections:z.boolean().default(false),notification_events:z.boolean().default(false),notification_states:z.boolean().default(false),calendar_invitations:z.boolean().default(false),calendar_invitation_actions:z.boolean().default(false) }).parse(tables.rows[0]);
  if(present.calendar_invitations!==present.calendar_invitation_actions)throw new Error('EMAIL_SCHEMA_INCOMPLETE');
  if(present.native_connection_requests!==present.native_account_connections)throw new Error('EMAIL_SCHEMA_INCOMPLETE');
  if(present.notification_events!==present.notification_states)throw new Error('EMAIL_SCHEMA_INCOMPLETE');
  if(present.imap_aliases!==present.imap_move_reservations)throw new Error('EMAIL_SCHEMA_INCOMPLETE');
  if (present.outbox !== present.outbox_events) throw new Error('EMAIL_SCHEMA_INCOMPLETE');
  if (!present.messages && !present.checkpoints && !present.provider_states && !present.imap_credentials && !present.drafts && !present.operations && !present.send_operations && !present.attachments && !present.provider_draft_mirrors && !present.outbox && !present.templates && !present.signatures && !present.imap_aliases && !present.imap_move_reservations && !present.timers && !present.presentation_cache && !present.account_consents && !present.rules && !present.rule_receipts && !present.native_connection_requests && !present.native_account_connections && !present.notification_events && !present.notification_states && !present.calendar_invitations && !present.calendar_invitation_actions) return Object.freeze([]);
  if (!present.messages || !present.checkpoints || !present.provider_states) throw new Error('EMAIL_SCHEMA_INCOMPLETE');
  const result = await tx.execute(sql`
    WITH refs AS (
      SELECT summary_envelope->>'key_version' AS key_id FROM email_messages
        WHERE summary_envelope IS NOT NULL AND (${org}::text IS NULL OR org_id=${org})
      UNION ALL
      SELECT source_envelope->>'key_version' FROM email_messages
        WHERE source_envelope IS NOT NULL AND (${org}::text IS NULL OR org_id=${org})
      UNION ALL
      SELECT cursor_envelope->>'key_version' FROM email_checkpoints
        WHERE cursor_envelope IS NOT NULL AND (${org}::text IS NULL OR org_id=${org})
      UNION ALL
      SELECT state_envelope->>'key_version' FROM email_provider_states
        WHERE (${org}::text IS NULL OR org_id=${org})
      ${present.account_consents ? sql`UNION ALL SELECT bridge_envelope->>'key_version' FROM email_account_consents
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.native_connection_requests ? sql`UNION ALL SELECT envelope->>'key_version' FROM email_native_connection_requests WHERE (${org}::text IS NULL OR org_id=${org})
        UNION ALL SELECT descriptor_envelope->>'key_version' FROM email_native_account_connections WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.timers ? sql`UNION ALL SELECT timer_envelope->>'key_version' FROM email_timers
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.presentation_cache ? sql`UNION ALL SELECT content_envelope->>'key_version' FROM email_presentation_cache
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.rules ? sql`UNION ALL SELECT content_envelope->>'key_version' FROM email_rules
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.rule_receipts ? sql`UNION ALL SELECT receipt_envelope->>'key_version' FROM email_rule_receipts
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.calendar_invitations ? sql`UNION ALL SELECT model_envelope->>'key_version' FROM email_calendar_invitations WHERE (${org}::text IS NULL OR org_id=${org})
        UNION ALL SELECT receipt_envelope->>'key_version' FROM email_calendar_invitation_actions WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.imap_credentials ? sql`UNION ALL SELECT envelope->>'key_version' FROM email_imap_credentials
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.drafts ? sql`UNION ALL SELECT content_envelope->>'key_version' FROM email_drafts
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.signatures ? sql`UNION ALL SELECT preferences_envelope->>'key_version' FROM email_signatures
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.templates ? sql`UNION ALL SELECT content_envelope->>'key_version' FROM email_templates
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.imap_aliases ? sql`UNION ALL SELECT evidence_envelope->>'key_version' FROM email_imap_aliases WHERE (${org}::text IS NULL OR org_id=${org})
        UNION ALL SELECT reservation_envelope->>'key_version' FROM email_imap_move_reservations WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.operations ? sql`UNION ALL SELECT content_envelope->>'key_version' FROM email_operations
        WHERE content_envelope IS NOT NULL AND (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.send_operations ? sql`UNION ALL SELECT receipt_envelope->>'key_version' FROM email_send_operations
        WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.attachments ? sql`UNION ALL SELECT metadata_envelope->>'key_version' FROM email_attachments
        WHERE (${org}::text IS NULL OR org_id=${org})
        UNION ALL SELECT key_version FROM email_attachments WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.provider_draft_mirrors ? sql`UNION ALL SELECT provider_envelope->>'key_version' FROM email_provider_draft_mirrors
        WHERE provider_envelope IS NOT NULL AND (${org}::text IS NULL OR org_id=${org})` : sql``}
      ${present.outbox ? sql`UNION ALL SELECT snapshot_envelope->>'key_version' FROM email_outbox
        WHERE (${org}::text IS NULL OR org_id=${org})
        UNION ALL SELECT state_envelope->>'key_version' FROM email_outbox WHERE (${org}::text IS NULL OR org_id=${org})
        UNION ALL SELECT key_version FROM email_outbox WHERE (${org}::text IS NULL OR org_id=${org})
        UNION ALL SELECT envelope->>'key_version' FROM email_outbox_events WHERE (${org}::text IS NULL OR org_id=${org})` : sql``}
    ) SELECT DISTINCT 'run_encryption'::text AS purpose,key_id FROM refs ORDER BY key_id
  `);
  return Object.freeze(result.rows.map(row => Object.freeze(reference.parse(row))));
}

function retainedKnowledgeSourceUrl(accountId: string, messageId: string): string | null {
  if (!accountId || accountId.length > 256 || /[\u0000-\u001f\u007f]/u.test(accountId)
    || !/^mail_[a-f0-9]{64}$/u.test(messageId)) return null;
  return `/email?account=${encodeURIComponent(accountId)}&message=${encodeURIComponent(messageId)}`;
}

/** Call only after authorizing the retained Knowledge page. The excerpt is a
 * destination-owned copy; the original mailbox link remains separately gated. */
async function decorateRetainedKnowledgeCitations<T extends { source_type: string; source_id: string }>(
  orgId: string, userId: string, citations: T[],
): Promise<Array<T & { source_url?: string | null; source_label?: string }>> {
  const ids = citations.filter(row => row.source_type === 'email').map(row => row.source_id);
  if (!ids.length) return citations;
  const [{ db }, { emailKnowledgeSources }] = await Promise.all([import('./db.js'), import('@deft/db/schema')]);
  const rows = await db.select({ id: emailKnowledgeSources.id,
    owner_user_id: emailKnowledgeSources.owner_user_id, account_id: emailKnowledgeSources.account_id,
    logical_message_id: emailKnowledgeSources.logical_message_id }).from(emailKnowledgeSources)
    .where(and(eq(emailKnowledgeSources.org_id, orgId), inArray(emailKnowledgeSources.id, ids)));
  const byId = new Map(rows.map(row => [row.id, row]));
  // A routing marker never grants access. The destination excerpt is already
  // authorized; the link opens through a fresh Web/current App source check.
  const adopted=await db.execute(sql`SELECT s.id,m.state FROM email_knowledge_sources s
    JOIN native_email_adoptions m USING(org_id,owner_user_id,account_id)
    WHERE s.org_id=${orgId} AND s.owner_user_id=${userId} AND s.id IN (${sql.join(ids.map(id=>sql`${id}`),sql`,`)})`);
  const routes=new Map(adopted.rows.map(row=>[String(row.id),String(row.state)]));
  return citations.map(citation => {
    if (citation.source_type !== 'email') return citation;
    const source = byId.get(citation.source_id);
    return { ...citation, source_label: 'Email',
      source_url: source?.owner_user_id === userId
        ? routes.has(source.id) ? routes.get(source.id)==='runtime_active' ? `/apps/source/native-email/${encodeURIComponent(source.id)}` : null : retainedKnowledgeSourceUrl(source.account_id, source.logical_message_id) : null };
  });
}

const dateISO=(value:string)=>`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T00:00:00Z`;
const TimeSchema=z.strictObject({value:z.string().regex(/^(?:[0-9]{8}|[0-9]{8}T[0-9]{6}Z?)$/u),value_type:z.enum(['date','date_time']),time_zone:z.string().regex(/^[A-Za-z0-9_+./-]{1,128}$/u).nullable(),instant:z.iso.datetime().nullable()});
const ModelSchema=z.strictObject({schema_version:z.literal('deft.email_calendar_event.v1'),account_id:z.string().min(1).max(256),invitation_id:z.string().regex(/^[a-f0-9]{64}$/u),
 uid:z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u),organizer:z.string().email().max(320),start:TimeSchema,end:TimeSchema,rrule:z.string().regex(/^[A-Z0-9=;,+-]{1,1024}$/iu).nullable(),
 exdates:z.array(TimeSchema).max(256),recurrence_id:TimeSchema.nullable(),sequence:z.number().int().nonnegative(),dtstamp:z.iso.datetime()});
type Model=z.infer<typeof ModelSchema>;
type RetainedCalendarTime=z.infer<typeof TimeSchema>;
type RetainedCalendarRow={timestamp:Date;metadata:unknown};
const currentTime=(original:RetainedCalendarTime,instant:string):RetainedCalendarTime=>{
 const parsed=new Date(instant);if(!Number.isFinite(parsed.getTime()))throw Error('EMAIL_CALENDAR_MODEL_INVALID');
 if(original.value_type==='date')return {value:parsed.toISOString().slice(0,10).replaceAll('-',''),value_type:'date',time_zone:null,instant:null};
 if(!original.time_zone)return {value:parsed.toISOString().replace(/[-:]/gu,'').replace(/\.\d{3}Z$/u,'Z'),value_type:'date_time',time_zone:null,instant:parsed.toISOString()};
 const parts=new Map(new Intl.DateTimeFormat('en-US',{timeZone:original.time_zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(parsed).map(part=>[part.type,part.value]));
 return {...original,value:`${parts.get('year')}${parts.get('month')}${parts.get('day')}T${parts.get('hour')}${parts.get('minute')}${parts.get('second')}`,instant:parsed.toISOString()};
};
const decodeRetainedCalendarModel=(row:RetainedCalendarRow):Model|null=>{
 const metadata=row.metadata as Record<string,unknown>|null,value=metadata?.email_invitation as Model|undefined;
 if(!value||value.schema_version!=='deft.email_calendar_event.v1')return null;
 const model=ModelSchema.parse(value);
 // Existing Calendar remains the editable time source. Keep the imported
 // timezone/recurrence identity while projecting owner edits to start/end.
 const start=row.timestamp.toISOString(),end=typeof metadata?.end==='string'?metadata.end:null;
 const originalStart=model.start.instant??dateISO(model.start.value),originalEnd=model.end.instant??dateISO(model.end.value);
 if(Date.parse(start)!==Date.parse(originalStart))model.start=currentTime(model.start,start);
 if(end&&Date.parse(end)!==Date.parse(originalEnd))model.end=currentTime(model.end,end);
 return model;
};

const retainedBudgetConfigKeys=Object.freeze({org:'email_knowledge_daily_token_budget',account:'email_knowledge_account_daily_token_budget'});

const retainedDestinationKey=sql`case ${wikiPages.scope} when 'user' then 'user'
 when 'space' then 'space:' || ${wikiPages.space_id} else null end`;
const retainedThreadMatches=sql`thread.owner_user_id = ${wikiPages.user_id}
 and thread.destination_key = ${retainedDestinationKey}
 and thread.page_version > 0 and thread.page_version <= ${wikiPages.version}`;
const retainedKnowledgeOriginCondition=sql`(exists (select 1 from email_knowledge_threads thread
 where thread.org_id = ${wikiPages.org_id} and thread.page_id = ${wikiPages.id})
 or exists (select 1 from wiki_citations citation where citation.page_id = ${wikiPages.id} and citation.source_type = 'email'))`;
const retainedKnowledgeProvenanceCondition=sql`(
 exists (select 1 from email_knowledge_threads thread
  where thread.org_id = ${wikiPages.org_id} and thread.page_id = ${wikiPages.id}
   and ${retainedThreadMatches} and exists (select 1 from wiki_citations citation
    join email_knowledge_sources source on source.id = citation.source_id and source.org_id = thread.org_id
    where citation.org_id = thread.org_id and citation.page_id = thread.page_id and citation.source_type = 'email'
     and source.owner_user_id = thread.owner_user_id and source.account_id = thread.account_id and source.thread_key = thread.thread_key))
 and not exists (select 1 from email_knowledge_threads thread
  where thread.org_id = ${wikiPages.org_id} and thread.page_id = ${wikiPages.id}
   and not coalesce((${retainedThreadMatches}),false))
 and not exists (select 1 from wiki_citations citation
  where citation.page_id = ${wikiPages.id} and citation.source_type = 'email'
   and not coalesce((citation.org_id = ${wikiPages.org_id} and exists (
    select 1 from email_knowledge_sources source join email_knowledge_threads thread
     on thread.org_id = source.org_id and thread.owner_user_id = source.owner_user_id
      and thread.account_id = source.account_id and thread.thread_key = source.thread_key
    where source.id = citation.source_id and source.org_id = ${wikiPages.org_id}
     and thread.page_id = ${wikiPages.id} and ${retainedThreadMatches})),false)))`;

/** Sole trusted provider for retained source storage. Its wire decoders stay
 * here until explicit provenance, restore and rollback migration gates pass. */
export const retainedSourceStorageProvider = Object.freeze({
 id: 'retained-source-storage',
 listReferences: listEmailMailboxKeyReferences,
 knowledge: Object.freeze({
  origins: Object.freeze(['email_knowledge_auto']),
  originCondition: retainedKnowledgeOriginCondition,
  provenanceCondition: retainedKnowledgeProvenanceCondition,
  budgetStorage: emailKnowledgeBudgets,
  budgetConfigKeys: retainedBudgetConfigKeys,
  readBudgetConfig(config:Record<string,unknown>) {
   return {org:config[retainedBudgetConfigKeys.org],account:config[retainedBudgetConfigKeys.account]};
  },
  sourceUrl: retainedKnowledgeSourceUrl,
  isCitation: (sourceType:string) => sourceType === 'email',
  decorateCitations: decorateRetainedKnowledgeCitations,
 }),
 calendar: Object.freeze({
  condition: sql`${events.metadata}->'email_invitation'->>'schema_version' = 'deft.email_calendar_event.v1'`,
  decodeLegacyModel: decodeRetainedCalendarModel,
  decodeProjectionModel(row:RetainedCalendarRow) {
   const model=decodeRetainedCalendarModel(row);
   return model ? {series_identity:[model.account_id,model.uid,model.organizer],uid:model.uid,
    start:model.start,end:model.end,rrule:model.rrule,exdates:model.exdates,
    recurrence_id:model.recurrence_id,sequence:model.sequence,dtstamp:model.dtstamp} : null;
  },
 }),
});
