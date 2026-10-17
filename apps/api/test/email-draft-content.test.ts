import assert from 'node:assert/strict';
import test from 'node:test';
import { detachInvalidManagedSignature, EmailDraftContentSchema } from '../src/lib/email-draft-service.js';
import { signatureIdentityKey } from '../src/lib/email-signature-types.js';

const base = { mode: 'compose', to: '', cc: '', bcc: '', subject: '', body: '', body_html: '', reply_record_id: '', attachments: [] };

test('native draft limits preserve long-form body, HTML, recipients, and subject without changing send semantics', () => {
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, body: 'x'.repeat(256 * 1024) }).success, true);
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, body_html: '<p>' + 'x'.repeat(256 * 1024 - 7) + '</p>' }).success, true);
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, to: 'a'.repeat(16 * 1024), subject: 's'.repeat(998) }).success, true);
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, subject: 's'.repeat(999) }).success, false);
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, body: 'x'.repeat(256 * 1024 + 1) }).success, false);
});

test('attachment manifest permits 32 opaque nominations within the 25 MiB aggregate but no more', () => {
  const attachments = Array.from({ length: 32 }, (_, index) => ({ file_id: `private-file-${index}`, filename: `file-${index}.bin`,
    media_type: 'application/octet-stream', size_bytes: index === 0 ? 25 * 1024 * 1024 : 0, sha256: 'a'.repeat(64) }));
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, attachments }).success, true);
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, attachments: [...attachments, { ...attachments[0], file_id: 'extra-file' }] }).success, false);
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, attachments: attachments.map((file, index) => ({ ...file,
    size_bytes: index < 2 ? 13 * 1024 * 1024 : 0 })) }).success, false);
});

test('aggregate UTF-8 serialization budget protects encrypted drafts from multibyte expansion', () => {
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, body: '📨'.repeat(40_000) }).success, true);
  assert.equal(EmailDraftContentSchema.safeParse({ ...base, body: '📨'.repeat(124_000) }).success, false);
});

test('managed signature markers are bounded, exact UTF-16 suffix ownership metadata only', () => {
  const address='team@example.test',suffix='\n\nBest,\nAda';
  const marker={schema_version:'deft.email_signature_region.v1',identity_key:signatureIdentityKey(address),preference_revision:4,
    plain:{start:2,text:suffix},rich:null};
  const content=EmailDraftContentSchema.parse({...base,from_identity:{address},body:`Hi${suffix}`,managed_signature:marker});
  assert.equal(detachInvalidManagedSignature(content).managed_signature?.plain.text,suffix);
  const edited=detachInvalidManagedSignature({...content,body:'Hi\n\nManual edit'});
  assert.equal(edited.body,'Hi\n\nManual edit');assert.equal('managed_signature'in edited,false);
  const switched=detachInvalidManagedSignature({...content,from_identity:{address:'other@example.test'}});
  assert.equal(switched.body,content.body);assert.equal('managed_signature'in switched,false);
  const body='Hi\n\nBest,\nAda',bodyHtml='<p>Hi</p><p></p><p>Best,</p><p>Ada</p>',richSuffix='<p></p><p>Best,</p><p>Ada</p>';
  const rich=EmailDraftContentSchema.parse({...base,from_identity:{address},body,body_html:bodyHtml,managed_signature:{...marker,
    plain:{start:2,text:'\n\nBest,\nAda'},rich:{start:'<p>Hi</p>'.length,html:richSuffix}}});
  assert.equal(detachInvalidManagedSignature(rich).managed_signature?.rich?.html,richSuffix);
  const invalidSeam=detachInvalidManagedSignature({...rich,managed_signature:{...rich.managed_signature!,plain:{start:3,text:'\nBest,\nAda'}}});
  assert.equal(invalidSeam.body,body);assert.equal('managed_signature'in invalidSeam,false);
  assert.equal(EmailDraftContentSchema.safeParse({...base,managed_signature:{...marker,preference_revision:0}}).success,false);
  assert.equal(EmailDraftContentSchema.safeParse({...base,from_identity:{address:'not-an-address'}}).success,false);
});
