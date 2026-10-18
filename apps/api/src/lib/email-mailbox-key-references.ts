import { sql } from 'drizzle-orm';
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
