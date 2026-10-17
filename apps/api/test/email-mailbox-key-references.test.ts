import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { listEmailMailboxKeyReferences } from '../src/lib/email-mailbox-key-references.js';

function database(presence: {messages:boolean;checkpoints:boolean;imap_credentials?:boolean;drafts?:boolean;operations?:boolean;send_operations?:boolean;attachments?:boolean;provider_draft_mirrors?:boolean;outbox?:boolean;outbox_events?:boolean;templates?:boolean;signatures?:boolean;imap_aliases?:boolean;imap_move_reservations?:boolean;timers?:boolean;presentation_cache?:boolean;account_consents?:boolean;rules?:boolean;rule_receipts?:boolean;native_connection_requests?:boolean;native_account_connections?:boolean;notification_events?:boolean;notification_states?:boolean;calendar_invitations?:boolean;calendar_invitation_actions?:boolean}, rows: unknown[] = []) {
  const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
  const tx = { execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
    queries.push(new PgDialect().sqlToQuery(query));
    return { rows: queries.length === 1 ? [{...presence,imap_credentials:presence.imap_credentials??false,drafts:presence.drafts??false,operations:presence.operations??false,send_operations:presence.send_operations??false,attachments:presence.attachments??false,provider_draft_mirrors:presence.provider_draft_mirrors??false,outbox:presence.outbox??false,outbox_events:presence.outbox_events??false,templates:presence.templates??false,signatures:presence.signatures??false,timers:presence.timers??false,presentation_cache:presence.presentation_cache??false,account_consents:presence.account_consents??false,rules:presence.rules??false,rule_receipts:presence.rule_receipts??false,provider_states:presence.messages && presence.checkpoints,native_connection_requests:presence.native_connection_requests??false,native_account_connections:presence.native_account_connections??false,notification_events:presence.notification_events??false,notification_states:presence.notification_states??false,calendar_invitations:presence.calendar_invitations??false,calendar_invitation_actions:presence.calendar_invitation_actions??false}] : rows };
  }};
  return { tx: tx as unknown as Parameters<typeof listEmailMailboxKeyReferences>[0], queries };
}
test('pre-migration databases contain no native mailbox references', async () => {
  const {tx,queries} = database({messages:false,checkpoints:false});
  assert.deepEqual(await listEmailMailboxKeyReferences(tx), []);
  assert.equal(queries.length,1);
});
test('reader cache preserves encryption keys until physical eviction, including expired entries',async()=>{
 const f=database({messages:true,checkpoints:true,presentation_cache:true},[{purpose:'run_encryption',key_id:'cached-body-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'cached-body-key'}]);
 assert.match(f.queries[1]!.sql,/content_envelope->>'key_version' FROM email_presentation_cache/);
 assert.doesNotMatch(f.queries[1]!.sql,/expires_at|email_accounts|revoked_at/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,presentation_cache:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});
test('retained IMAP alias evidence and unresolved move reservations preserve keys without state filters',async()=>{
 const f=database({messages:true,checkpoints:true,imap_aliases:true,imap_move_reservations:true},[{purpose:'run_encryption',key_id:'move-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'move-key'}]);
 assert.match(f.queries[1]!.sql,/evidence_envelope->>'key_version' FROM email_imap_aliases/);assert.match(f.queries[1]!.sql,/reservation_envelope->>'key_version' FROM email_imap_move_reservations/);
 assert.doesNotMatch(f.queries[1]!.sql,/state=|deleted_at|revoked_at/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:true,checkpoints:true,imap_aliases:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,imap_aliases:true,imap_move_reservations:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});

test('IMAP ciphertext retains its key even for disconnected accounts, while pre65 schemas remain supported',async()=>{
  const f=database({messages:true,checkpoints:true,imap_credentials:true},[{purpose:'run_encryption',key_id:'imap-key'}]);
  assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'imap-key'}]);
  assert.match(f.queries[1]!.sql,/email_imap_credentials/);assert.doesNotMatch(f.queries[1]!.sql,/email_accounts|revoked_at/);
  const old=database({messages:true,checkpoints:true});await listEmailMailboxKeyReferences(old.tx);
  assert.doesNotMatch(old.queries[1]!.sql,/email_imap_credentials/);
});
test('native draft ciphertext key references are inventoried without draft-content output',async()=>{
  const f=database({messages:true,checkpoints:true,drafts:true},[{purpose:'run_encryption',key_id:'draft-key'}]);
  assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'draft-key'}]);
  assert.match(f.queries[1]!.sql,/email_drafts/);assert.match(f.queries[1]!.sql,/content_envelope/);
});
test('partial migration and malformed retained key references fail closed', async () => {
  await assert.rejects(listEmailMailboxKeyReferences(database({messages:true,checkpoints:false}).tx), /EMAIL_SCHEMA_INCOMPLETE/);
  await assert.rejects(listEmailMailboxKeyReferences(database({messages:true,checkpoints:true}, [{purpose:'run_encryption',key_id:null}]).tx));
});

test('native operation reservations with no ciphertext do not block key retirement; encrypted journals do',async()=>{
  const f=database({messages:true,checkpoints:true,operations:true},[{purpose:'run_encryption',key_id:'operation-key'}]);
  assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'operation-key'}]);
  assert.match(f.queries[1]!.sql,/email_operations/);assert.match(f.queries[1]!.sql,/content_envelope IS NOT NULL/);
  assert.doesNotMatch(f.queries[1]!.sql,/kind\s*=/,'all retained operation kinds, including sent_copy, preserve their keys');
});
test('inventory includes every ciphertext column without active-account filtering', async () => {
  const {tx,queries} = database({messages:true,checkpoints:true,imap_credentials:true,drafts:true}, [{purpose:'run_encryption',key_id:'old-key'}]);
  const org='00000000-0000-4000-8000-000000000001';
  assert.deepEqual(await listEmailMailboxKeyReferences(tx,org), [{purpose:'run_encryption',key_id:'old-key'}]);
  const query=queries[1]!;
  for (const column of ['summary_envelope','source_envelope','cursor_envelope','state_envelope','content_envelope']) assert.match(query.sql,new RegExp(column));
  assert.doesNotMatch(query.sql,/email_accounts|deleted_at|revoked_at/);
  assert.ok(query.params.every(value => value===org));
});

test('submitted send receipts and detached native file ciphertext keep their encryption keys',async()=>{
 const f=database({messages:true,checkpoints:true,send_operations:true,attachments:true},[{purpose:'run_encryption',key_id:'retained-file-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'retained-file-key'}]);
 assert.match(f.queries[1]!.sql,/receipt_envelope/);assert.match(f.queries[1]!.sql,/metadata_envelope/);assert.match(f.queries[1]!.sql,/SELECT key_version FROM email_attachments/);
 assert.doesNotMatch(f.queries[1]!.sql,/detached_at|email_accounts|status/);
});
test('provider draft locators and baselines retain their encryption key',async()=>{
 const f=database({messages:true,checkpoints:true,provider_draft_mirrors:true},[{purpose:'run_encryption',key_id:'provider-draft-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'provider-draft-key'}]);
 assert.match(f.queries[1]!.sql,/provider_envelope/);assert.match(f.queries[1]!.sql,/email_provider_draft_mirrors/);
});
test('queued cancelled and uncertain MIME and every outbox envelope retain keys without state filters',async()=>{
 const f=database({messages:true,checkpoints:true,outbox:true,outbox_events:true},[{purpose:'run_encryption',key_id:'outbox-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'outbox-key'}]);
 for(const column of ['snapshot_envelope','state_envelope','SELECT key_version FROM email_outbox','email_outbox_events'])assert.ok(f.queries[1]!.sql.includes(column));
 assert.doesNotMatch(f.queries[1]!.sql,/state=|cancelled|revoked_at/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:true,checkpoints:true,outbox:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});

test('active and archived templates retain keys, with no content or status filtering',async()=>{
 const f=database({messages:true,checkpoints:true,templates:true},[{purpose:'run_encryption',key_id:'template-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'template-key'}]);
 assert.match(f.queries[1]!.sql,/content_envelope->>'key_version' FROM email_templates/);
 assert.doesNotMatch(f.queries[1]!.sql,/status|active|archived/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,templates:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});

test('retained signature preferences preserve keys without identity or account-state filtering',async()=>{
 const f=database({messages:true,checkpoints:true,signatures:true},[{purpose:'run_encryption',key_id:'signature-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'signature-key'}]);
 assert.match(f.queries[1]!.sql,/preferences_envelope->>'key_version' FROM email_signatures/);
 assert.doesNotMatch(f.queries[1]!.sql,/status|verified|email_accounts/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,signatures:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});

test('timer envelopes retain encryption keys and pre-migration databases remain compatible', async () => {
 const f=database({messages:true,checkpoints:true,timers:true},[{purpose:'run_encryption',key_id:'timer-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'timer-key'}]);
 assert.match(f.queries[1]!.sql,/timer_envelope->>'key_version' FROM email_timers/);
 const old=database({messages:true,checkpoints:true});await listEmailMailboxKeyReferences(old.tx);
 assert.doesNotMatch(old.queries[1]!.sql,/timer_envelope/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,timers:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});

test('all owner-native consent bridges and retained identity metadata preserve keys even after revocation',async()=>{
 const f=database({messages:true,checkpoints:true,account_consents:true},[{purpose:'run_encryption',key_id:'native-consent-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'native-consent-key'}]);
 assert.match(f.queries[1]!.sql,/bridge_envelope->>'key_version' FROM email_account_consents/);assert.doesNotMatch(f.queries[1]!.sql,/state=|revoked_at|email_accounts/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,account_consents:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});
test('retained Calendar invitation model and action receipts preserve keys after account disconnect or event deletion',async()=>{
 const f=database({messages:true,checkpoints:true,calendar_invitations:true,calendar_invitation_actions:true},[{purpose:'run_encryption',key_id:'invitation-retained-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'invitation-retained-key'}]);
 assert.match(f.queries[1]!.sql,/model_envelope->>'key_version' FROM email_calendar_invitations/);assert.match(f.queries[1]!.sql,/receipt_envelope->>'key_version' FROM email_calendar_invitation_actions/);
 assert.doesNotMatch(f.queries[1]!.sql,/email_accounts|event_id|status|revoked_at/);
 for(const presence of [{messages:true,checkpoints:true,calendar_invitations:true},{messages:true,checkpoints:true,calendar_invitation_actions:true},{messages:false,checkpoints:false,calendar_invitations:true,calendar_invitation_actions:true}])await assert.rejects(listEmailMailboxKeyReferences(database(presence).tx),/EMAIL_SCHEMA_INCOMPLETE/);
 const old=database({messages:true,checkpoints:true});await listEmailMailboxKeyReferences(old.tx);assert.doesNotMatch(old.queries[1]!.sql,/email_calendar_invitations/);
});
test('native connect receipt/profile keys are retained in all states and partial schema is denied',async()=>{
 const f=database({messages:true,checkpoints:true,native_connection_requests:true,native_account_connections:true},[{purpose:'run_encryption',key_id:'native-profile-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'native-profile-key'}]);assert.match(f.queries[1]!.sql,/envelope->>'key_version' FROM email_native_connection_requests/);assert.match(f.queries[1]!.sql,/descriptor_envelope->>'key_version' FROM email_native_account_connections/);assert.doesNotMatch(f.queries[1]!.sql,/state=|expires_at|email_accounts/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,native_connection_requests:true,native_account_connections:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:true,checkpoints:true,native_connection_requests:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});

test('encrypted rules and action receipts retain keys until physical deletion and require the base mailbox schema',async()=>{
 const f=database({messages:true,checkpoints:true,rules:true,rule_receipts:true},[{purpose:'run_encryption',key_id:'rule-key'}]);
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[{purpose:'run_encryption',key_id:'rule-key'}]);
 assert.match(f.queries[0]!.sql,/email_rules/);assert.match(f.queries[0]!.sql,/email_rule_receipts/);
 assert.match(f.queries[1]!.sql,/content_envelope->>'key_version' FROM email_rules/);assert.match(f.queries[1]!.sql,/receipt_envelope->>'key_version' FROM email_rule_receipts/);
 assert.doesNotMatch(f.queries[1]!.sql,/state=|active|archived/);
 const legacy=database({messages:true,checkpoints:true});await listEmailMailboxKeyReferences(legacy.tx);
 assert.doesNotMatch(legacy.queries[1]!.sql,/email_rules|email_rule_receipts/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,rules:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,rule_receipts:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});

test('contentless notification outbox tables are inventoried as a pair without adding key references',async()=>{
 const f=database({messages:true,checkpoints:true,notification_events:true,notification_states:true});
 assert.deepEqual(await listEmailMailboxKeyReferences(f.tx),[]);
 assert.match(f.queries[0]!.sql,/email_notification_events/);assert.match(f.queries[0]!.sql,/email_notification_states/);
 assert.doesNotMatch(f.queries[1]!.sql,/email_notification_events|email_notification_states/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:true,checkpoints:true,notification_events:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
 await assert.rejects(listEmailMailboxKeyReferences(database({messages:false,checkpoints:false,notification_events:true,notification_states:true}).tx),/EMAIL_SCHEMA_INCOMPLETE/);
});
