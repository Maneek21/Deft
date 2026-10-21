import { sql } from 'drizzle-orm';
import { wikiPages } from '@deft/db/schema';

/** Provenance survives an edited origin marker. These are associations in the
 * existing capture/receipt stores, not an additional source registry. */
function capturedSourceOrReceiptCondition() {
  return sql`(exists (select 1 from app_integration_capture_sources source
    where source.org_id = ${wikiPages.org_id} and source.page_id = ${wikiPages.id})
    or exists (select 1 from app_integration_destination_receipts receipt
    where receipt.org_id = ${wikiPages.org_id} and receipt.destination->>'kind' = 'knowledge'
      and receipt.result->>'destination_id' = ${wikiPages.id}))`;
}

export function appSourceKnowledgeAssociationCondition() {
  return sql`(${capturedSourceOrReceiptCondition()} or exists (select 1 from wiki_citations citation
    where citation.page_id = ${wikiPages.id} and citation.source_type = 'app_integration'))`;
}

/** Every retained association must agree with the current destination. A
 * missing or conflicting mapping is never permission to broaden that audience.
 * v1 uses the exact retained thread key; v2 uses Host-authored immutable consent.
 * Page edits can advance the live version without erasing the capture version. */
export function appSourceKnowledgeProvenanceCondition() {
  const audience = sql`case ${wikiPages.scope}
    when 'user' then 'user' when 'space' then 'space:' || ${wikiPages.space_id} else null end`;
  const association = sql`source.publication->'association'`;
  const declared = sql`${association}->'audience'`;
  const valid = sql`source.owner_user_id = ${wikiPages.user_id} and (
    (not (source.publication ? 'association') and exists (
      select 1 from app_integration_capture_threads thread
      where thread.org_id = source.org_id and thread.owner_user_id = source.owner_user_id
        and thread.installation_id = source.installation_id and thread.account_ref = source.account_ref
        and thread.store_key = source.store_key and thread.thread_key = source.thread_key
        and thread.page_id = source.page_id and thread.destination_key = ${audience}
        and thread.page_version > 0 and thread.page_version <= ${wikiPages.version}))
    or (${association}->>'schema_version' = 'deft.app_capture_source.v2'
      and ${association}->>'page_id' = source.page_id
      and ${association}->>'body_digest' = source.body_digest
      and source.body_digest ~ '^sha256:[a-f0-9]{64}$'
      and ${association}->>'captured_at' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?Z$'
      and jsonb_typeof(${association}->'page_version') = 'number'
      and case when ${association}->>'page_version' ~ '^[1-9][0-9]{0,9}$'
        then (${association}->>'page_version')::numeric <= ${wikiPages.version} else false end
      and ((${wikiPages.scope} = 'user' and ${declared}->>'scope' = 'user'
          and ${declared}->>'user_id' = ${wikiPages.user_id} and ${declared}->'space_id' = 'null'::jsonb)
        or (${wikiPages.scope} = 'space' and ${declared}->>'scope' = 'space'
          and ${declared}->>'space_id' = ${wikiPages.space_id} and ${declared}->'user_id' = 'null'::jsonb))))`;
  const receiptValid = sql`receipt.owner_user_id = ${wikiPages.user_id}
    and ${wikiPages.scope} = 'space' and receipt.destination->>'space_id' = ${wikiPages.space_id}
    and receipt.result->>'destination_kind' = 'knowledge'`;
  return sql`(${capturedSourceOrReceiptCondition()}
    and not exists (select 1 from app_integration_capture_sources source
      where source.org_id = ${wikiPages.org_id} and source.page_id = ${wikiPages.id}
        and not coalesce((${valid}), false))
    and not exists (select 1 from app_integration_destination_receipts receipt
      where receipt.org_id = ${wikiPages.org_id} and receipt.destination->>'kind' = 'knowledge'
        and receipt.result->>'destination_id' = ${wikiPages.id}
        and not coalesce((${receiptValid}), false))
    and not exists (select 1 from wiki_citations citation
      where citation.page_id = ${wikiPages.id} and citation.source_type = 'app_integration'
        and not coalesce((citation.org_id = ${wikiPages.org_id} and exists (
          select 1 from app_integration_capture_sources source where source.id = citation.source_id
            and source.org_id = ${wikiPages.org_id} and source.page_id = ${wikiPages.id})), false)))`;
}
