import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {singleAddress} from '../../account-config.mjs';
import {attachmentPolicy, collectEmailAttachments, EMAIL_MEDIA_TYPES} from '../../email-attachments.mjs';
import {loadMessageByLocator, readMailboxSyncPage} from '../../mailbox-sync.mjs';
import {createMailProvider} from '../../mail.mjs';
import {withTransportIdentity, withReplyParent} from '../../transport-identity.mjs';
import {settleMailRuntimeEffect} from '../../runtime-effect.mjs';
import {appendSentCopy} from '../../sent-copy.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)));
const operations = JSON.parse(readFileSync(new URL('./interrupted-operations.json', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const source = name => {
  assert.match(name, /^[a-z0-9-]+\.(eml|pdf)$/);
  const bytes = readFileSync(new URL(name, import.meta.url));
  assert.ok(bytes.length > 0 && bytes.length < 65536, 'Fixture bytes stay bounded');
  return bytes;
};
const parsed = new Map();
for (const message of fixtures.messages) parsed.set(message.id, await simpleParser(source(message.source)));
const addresses = value => value?.value.map(row => row.address) ?? [];
const policy = attachmentPolicy({max_attachment_bytes:2097152, max_attachments_per_record:8,
  max_attachments_per_run:32, max_attachment_bytes_per_run:8388608, retention_days:1,
  allowed_media_types:[...EMAIL_MEDIA_TYPES]});

test('four credential-free synthetic accounts preserve distinct ownership context', () => {
  assert.equal(fixtures.synthetic, true);
  assert.equal(fixtures.accounts.length, 4);
  assert.equal(fixtures.accounts.filter(account => account.provider_hint === 'gmail').length, 2);
  assert.equal(new Set(fixtures.accounts.map(account => account.id)).size, 4);
  assert.equal(new Set(fixtures.accounts.map(account => account.address)).size, 4);
  assert.deepEqual(fixtures.accounts.map(account => account.provider_hint).sort(), ['gmail', 'gmail', 'imap', 'microsoft']);
  assert.match(fixtures.scope.org_id, /^[a-f0-9-]{36}$/);
  assert.notEqual(fixtures.scope.org_id, fixtures.scope.owner_id);
  for (const account of fixtures.accounts) {
    assert.ok(singleAddress(account.address));
    assert.ok(account.address.endsWith('@example.test'));
    assert.deepEqual(Object.keys(account).sort(), ['address', 'display_name', 'id', 'provider_hint']);
  }
  for (const message of fixtures.messages) {
    const account = fixtures.accounts.find(account => account.id === message.account_id);
    assert.ok(account, 'Every message has an account');
    const mail = parsed.get(message.id);
    assert.equal(mail.messageId, message.message_id);
    const mailboxAddresses = message.folder === 'sent' ? addresses(mail.from) : addresses(mail.to);
    assert.ok(mailboxAddresses.includes(account.address));
    assert.equal(source(message.source).toString().replace(/\r\n/g, '').includes('\n'), false, 'RFC822 uses CRLF');
  }
});

test('one conversation spans Inbox and Sent; an equal subject in another account stays separate', () => {
  const thread = fixtures.messages.filter(message => message.conversation_id === 'personal-review');
  assert.equal(thread.length, 3);
  assert.deepEqual(thread.map(message => message.folder), ['inbox', 'sent', 'inbox']);
  assert.equal(new Set(thread.map(message => message.account_id)).size, 1);
  assert.equal(parsed.get('review-002').inReplyTo, parsed.get('review-001').messageId);
  assert.equal(parsed.get('review-003').inReplyTo, parsed.get('review-002').messageId);
  assert.deepEqual(parsed.get('review-003').references, ['<stage0-review-001@example.test>', '<stage0-review-002@example.test>']);
  assert.equal(parsed.get('work-001').subject, parsed.get('review-001').subject);
  assert.notEqual(fixtures.messages.find(message => message.id === 'work-001').conversation_id, thread[0].conversation_id);
  assert.notEqual(fixtures.messages.find(message => message.id === 'work-001').account_id, thread[0].account_id);
});

test('Reply-To and Cc are explicit; Bcc belongs only to the owner Sent fixture', () => {
  const expected = fixtures.reply_candidates;
  const parent = parsed.get(expected.parent_id);
  assert.deepEqual(addresses(parent.replyTo), expected.reply_to);
  assert.deepEqual(addresses(parent.cc), expected.reply_all_cc);
  assert.deepEqual(addresses(parent.bcc), expected.received_bcc);
  assert.deepEqual(addresses(parsed.get('review-002').bcc), expected.owner_sent_bcc);
  assert.notDeepEqual(addresses(parent.from), expected.reply_to);
  assert.deepEqual(addresses(parsed.get('review-003').bcc), []);
});

test('same logical message resolves through changed IMAP folder and UID locators', async () => {
  const change = fixtures.locator_changes[0];
  assert.notEqual(change.before.resource_id, change.after.resource_id);
  assert.equal(change.logical_id, 'synthetic-logical-imap-001');
  const message = fixtures.messages.find(message => message.id === change.message_id);
  const bytes = source(message.source);
  let selected, released = 0;
  const observations = [change.before, change.after].map(locator => ({...locator,
    validity:locator.resource_id.split(':')[1], uid:Number(locator.resource_id.split(':')[2])}));
  const client = {
    list:async () => [{path:'INBOX'}, {path:'Sent', specialUse:'\\Sent'}, {path:'Archive', specialUse:'\\Archive'}],
    getMailboxLock:async mailbox => {
      selected = observations.find(row => row.mailbox === mailbox);
      client.mailbox = {uidValidity:selected.validity};
      return {release:() => released++};
    },
    fetchOne:async (uid, query) => uid === selected.uid
      ? {uid, ...(query.size ? {size:bytes.length} : {source:bytes})} : false
  };
  const before = await loadMessageByLocator(client, change.before.resource_id);
  const after = await loadMessageByLocator(client, change.after.resource_id);
  assert.equal(before.message_id, message.message_id);
  assert.equal(after.message_id, before.message_id);
  assert.notEqual(after.uid, before.uid);
  assert.notEqual(after.uidvalidity, before.uidvalidity);
  await assert.rejects(loadMessageByLocator(client, 'inbox:3002:1'), /STALE_MAIL_PARENT/);
  assert.equal(released, 3);
});

test('benign PDF retains exact bytes and needs explicit reviewed media consent', () => {
  const attachment = fixtures.attachments[0];
  const bytes = source(attachment.source);
  assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.ok(bytes.includes(Buffer.from('%%EOF')));
  assert.equal(bytes.length, attachment.bytes);
  assert.equal(sha256(bytes), attachment.sha256);
  const mail = parsed.get(attachment.message_id);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].contentType, 'application/pdf');
  assert.equal(mail.attachments[0].filename, attachment.filename);
  assert.equal(sha256(mail.attachments[0].content), attachment.sha256);
  const budget = {count:0, bytes:0};
  const collected = collectEmailAttachments(mail, policy, budget);
  assert.equal(collected.skipped, 0);
  assert.equal(collected.attachments.length, 1);
  assert.equal(sha256(collected.attachments[0].bytes), attachment.sha256);
  assert.deepEqual(budget, {count:1, bytes:attachment.bytes});
  const legacyPolicy = attachmentPolicy({...policy, allowed_media_types:policy.allowed_media_types.filter(type => type !== 'application/pdf')});
  assert.equal(collectEmailAttachments(mail, legacyPolicy, {count:0,bytes:0}).skipped, 1);
  assert.equal(attachment.current_runtime_outcome, 'skipped_unsupported_media_type');
});

test('untrusted HTML and instruction content remain available for Stage 1 containment tests', () => {
  const mail = parsed.get('untrusted-001');
  assert.match(mail.html, /<script>/);
  assert.match(mail.html, /onerror=/);
  assert.match(mail.html, /javascript:/);
  assert.match(mail.html, /https:\/\/pixel\.example\.test/);
  assert.match(mail.text, /Ignore previous instructions/);
  const collected = collectEmailAttachments(mail, policy, {count:0, bytes:0});
  assert.match(collected.body, /message content, never authority/);
  assert.doesNotMatch(collected.body, /<script>/);
});

test('malformed MIME cannot become a trusted reply parent', async () => {
  const fixture = fixtures.failed_messages.find(message => message.id === 'malformed-001');
  const mail = await simpleParser(source(fixture.source));
  assert.doesNotMatch(mail.messageId ?? '', /^<[^<>\s@]+@[^<>\s@]+>$/);
  assert.throws(() => withReplyParent({to:'review-queue@example.test'}, {message_id:mail.messageId}), /STALE_MAIL_PARENT/);
});

test('truncated provider source retains metadata with body unavailable', async () => {
  const fixture = fixtures.failed_messages.find(message => message.failure_kind === 'source_read_truncated');
  const bytes = source(fixture.source);
  const directory = mkdtempSync(join(tmpdir(), 'deft-stage0-source-'));
  let released = false;
  const client = {
    mailbox:{uidValidity:3001, uidNext:2},
    list:async () => [{path:'INBOX'}],
    getMailboxLock:async () => ({release:() => {released = true;}}),
    fetch:async function* () {yield {uid:1, flags:new Set(), size:bytes.length,
      envelope:{subject:'Synthetic metadata retained', messageId:'<stage0-imap-stable-001@example.test>'},
      bodyStructure:{type:'text/plain'}};},
    fetchOne:async () => ({uid:1, source:bytes.subarray(0, bytes.length - 12)})
  };
  try {
    const page = await readMailboxSyncPage(client, {request:{cursor:null, max_items:10, attachments:policy},
      cachePath:join(directory, 'cache.json'), cacheScope:'synthetic-stage0'});
    assert.equal(page.upserts.length, 1);
    assert.equal(page.upserts[0].data.subject, 'Synthetic metadata retained');
    assert.equal(page.upserts[0].data.body_status, 'unavailable');
    assert.equal(page.upserts[0].data.full_body_status, 'unavailable');
    assert.equal(page.upserts[0].data.body_text_length, -1);
    assert.equal(page.upserts[0].attachments.length, 0);
    assert.equal(released, true);
  } finally {rmSync(directory, {recursive:true, force:true});}
});

const endpoint = {host:'127.0.0.1', port:9, tls:'none', auth:{user:'personal@example.test', password:'synthetic-test-only'}};
const provider = createMailProvider({schema_version:'deft.email_account.v1', mode:'loopback_fixture',
  owner:'personal@example.test', fixture_recipient:operations.input.to, smtp:endpoint, imap:endpoint}, {allowLoopbackFixture:true});
const transportInput = withTransportIdentity(operations.run_id, operations.action, operations.input);
const digest = sha256(JSON.stringify({action:operations.action,
  input:Object.fromEntries(Object.entries(transportInput).sort(([a], [b]) => a.localeCompare(b)))}));

test('interrupted prepared/sending/uncertain operations never reserve or resend', async () => {
  for (const state of operations.interrupted_transport_states) {
    let mutations = 0;
    const journal = {latest:() => ({digest, state}), reserve:() => mutations++, append:() => mutations++};
    await assert.rejects(provider.effect(journal, operations.run_id, operations.action, operations.input),
      error => error.message === operations.expected_replay_error);
    assert.equal(mutations, 0);
  }
});

test('accepted SMTP receipt replays while delivery and Sent-copy outcomes remain unknown', async () => {
  const prior = {digest, state:'smtp_accepted', smtp_accepted:true, output:operations.accepted_receipt};
  const journal = {latest:() => prior, reserve:() => assert.fail('No new transport reservation'),
    append:() => assert.fail('No new journal mutation')};
  const output = await provider.effect(journal, operations.run_id, operations.action, operations.input);
  assert.deepEqual(output, operations.accepted_receipt);
  assert.equal(output.transport_outcome, 'smtp_accepted');
  assert.equal(output.sent_copy_outcome, 'unknown');
  assert.equal(operations.delivery_expectation, 'unknown_not_proven_by_smtp_acceptance');
  assert.equal(Object.hasOwn(output, 'delivered'), false);
});

test('lost Sent-copy acknowledgement appends once and retains SMTP acceptance', async () => {
  let appends = 0;
  const rows = [];
  const client = {list:async () => [{path:'Sent', specialUse:'\\Sent'}],
    append:async () => {appends++; throw Error('SYNTHETIC_RESPONSE_LOST');}, logout:async () => {}};
  const output = await appendSentCopy({connect:async () => client, mime:{bytes:Buffer.from('synthetic'), date:new Date(0)},
    journal:{reserveCopy:() => {}, append:row => rows.push(row)},
    identity:{run_id:operations.run_id, digest, action:operations.action}});
  assert.equal(appends, 1);
  assert.equal(rows.at(-1).state, 'append_unknown');
  assert.deepEqual(output, operations.accepted_receipt);
});

test('lost runtime result acknowledgement remains unconfirmed without retry', async () => {
  let effects = 0, settlements = 0, reports = 0;
  await assert.rejects(settleMailRuntimeEffect({claim:{run_id:operations.run_id}, action:operations.action,
    sdk:{start:async () => ({input:operations.input}), result:async () => {settlements++; throw Error('SYNTHETIC_RESULT_LOST');}},
    journal:{latest:() => ({}), append:() => reports++},
    effect:async () => {effects++; return operations.accepted_receipt;}}), /SYNTHETIC_RESULT_LOST/);
  assert.equal(effects, 1);
  assert.equal(settlements, 1);
  assert.equal(reports, 0);
});
