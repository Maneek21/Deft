import assert from 'node:assert/strict';
import test from 'node:test';
import type {NativeEmailAccount, NativeEmailConnectionContext} from '../src/lib/email-native-adapter-contract.js';
import { createEmailImapHost, EmailImapHostError, type EmailImapFlowClient, type EmailImapFlowConstructor, type EmailImapHostAccount } from '../src/lib/email-imap-host.js';

const secret = 'host-test-password-never-log';
const metadata = (): EmailImapHostAccount => ({ org_id: 'org-synthetic', owner_user_id: 'owner-synthetic', installation_id: 'install-synthetic',
  account_id: 'imap-synthetic', provider: 'imap_smtp', resource_binding_id: 'binding-synthetic', authority_epoch: 4,
  connection_revision: 2, principal_digest: 'a'.repeat(64), health: 'connected', capabilities: ['read'],
  primary_address: 'reader@example.test', display_label: 'Synthetic reader' });
const visible = (account: EmailImapHostAccount): NativeEmailAccount => {
  const { org_id: _org, owner_user_id: _owner, installation_id: _installation, ...value } = account; return value;
};
function fixture(options: { transport?: 'implicit_tls' | 'starttls_required'; addresses?: readonly { address: string; family: number }[];
  connectError?: boolean; auth?: boolean; secure?: boolean; connectHeld?: boolean; changeAfterDns?: boolean } = {}) {
  const account = {...metadata()}; let currentCalls = 0, lookupCalls = 0, clientOptions: Record<string, any> | undefined;
  let connects = 0, logouts = 0, closes = 0, workCalls = 0, accountChangeAtWork = false, closedWhileConnecting!: () => void;
  const closeWait = new Promise<void>(resolve => { closedWhileConnecting = resolve; });
  class FakeImapFlow implements EmailImapFlowClient {
    authenticated: unknown = options.auth ?? true;
    secureConnection = options.secure ?? true;
    tls = { authorized: true };
    options: { auth?: { pass?: string; user?: string } };
    constructor(value: Record<string, any>) { clientOptions = value; this.options = value; }
    async connect() { connects++; if (options.connectError) throw new Error('synthetic transport detail'); if (options.connectHeld) await closeWait; }
    async logout() { logouts++; }
    close() { closes++; closedWhileConnecting(); }
  }
  const ImapFlow = FakeImapFlow as unknown as EmailImapFlowConstructor;
  const context: NativeEmailConnectionContext = { org_id: account.org_id, owner_user_id: account.owner_user_id, account_id: account.account_id,
    installation_id: account.installation_id, resource_binding_id: account.resource_binding_id, authority_version: 'fixture-v4',
    expires_at: Date.now() + 60_000, recheck: async () => {} };
  const custody = { async withVerifiedProfile<T>(_ctx: NativeEmailConnectionContext, expected: NativeEmailAccount,
    work: (profile: any) => Promise<T>) {
    assert.deepEqual(expected, visible(account));
    return work({ host: 'imap.example.test', port: options.transport === 'starttls_required' ? 143 : 993,
      username: 'reader@example.test', password: secret,
      tls: { mode: options.transport ?? 'implicit_tls', minVersion: 'TLSv1.2', rejectUnauthorized: true } });
  } };
  const host = createEmailImapHost({ custody, ImapFlow,
    current: async () => { currentCalls++; return structuredClone(account); },
    lookup: async () => { lookupCalls++; if (options.changeAfterDns) account.connection_revision++;
      return options.addresses ?? [{ address: '8.8.8.8', family: 4 }]; },
  });
  const run = (expected = visible(account), work = async () => { workCalls++; if (accountChangeAtWork) account.health = 'revoked'; return 'ok'; }) =>
    host.withAuthorizedClient(context, expected, work);
  return { account, context, host, run, get counts() { return { currentCalls, lookupCalls, connects, logouts, closes, workCalls }; },
    get clientOptions() { return clientOptions; }, set accountChangeAtWork(value: boolean) { accountChangeAtWork = value; } };
}

test('implicit TLS uses pinned public DNS, certificate verification, disabled logging and clears transient password', async () => {
  const f = fixture();
  assert.equal(await f.run(), 'ok');
  const opts = f.clientOptions!;
  assert.equal(opts.host, 'imap.example.test'); assert.equal(opts.port, 993); assert.equal(opts.secure, true);
  assert.equal(opts.doSTARTTLS, undefined); assert.equal(opts.logger, false); assert.equal(opts.logRaw, false); assert.equal(opts.emitLogs, false);
  assert.equal(opts.tls.rejectUnauthorized, true); assert.equal(opts.tls.minVersion, 'TLSv1.2'); assert.equal(opts.tls.servername, 'imap.example.test');
  assert.equal(opts.auth.pass, '');
  const pinned = await new Promise((resolve, reject) => opts.tls.lookup('other.invalid', { all: true }, (error: unknown, result: unknown) => error ? reject(error) : resolve(result)));
  assert.deepEqual(pinned, [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(f.counts.lookupCalls, 1); assert.equal(f.counts.connects, 1); assert.equal(f.counts.logouts, 1);
  assert.ok(f.counts.currentCalls >= 4);
});

test('status current reads account metadata without opening encrypted profile custody', async () => {
  const account = metadata(); let custodyCalls = 0;
  const host = createEmailImapHost({ ImapFlow: class {} as unknown as EmailImapFlowConstructor,
    current: async () => structuredClone(account), lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    custody: { async withVerifiedProfile() { custodyCalls++; throw new Error('must not decrypt for status'); } },
  });
  const context: NativeEmailConnectionContext = { org_id: account.org_id, owner_user_id: account.owner_user_id,
    account_id: account.account_id, installation_id: account.installation_id, resource_binding_id: account.resource_binding_id,
    authority_version: 'fixture-v4', expires_at: Date.now() + 60_000, recheck: async () => {} };
  assert.equal((await host.current(context)).principal_digest, account.principal_digest);
  assert.equal(custodyCalls, 0);
});

test('required STARTTLS explicitly fails closed without STARTTLS and shares the pinned lookup', async () => {
  const f = fixture({ transport: 'starttls_required' }); await f.run();
  const opts = f.clientOptions!;
  assert.equal(opts.port, 143); assert.equal(opts.secure, false); assert.equal(opts.doSTARTTLS, true);
  assert.equal(opts.tls.rejectUnauthorized, true); assert.equal(opts.auth.pass, '');
});

test('every DNS result is checked before ImapFlow construction and private/mixed answers never connect', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]]) {
    const f = fixture({ addresses });
    await assert.rejects(f.run(), error => error instanceof EmailImapHostError && error.code === 'EMAIL_ACCESS_DENIED');
    assert.equal(f.counts.connects, 0); assert.equal(f.clientOptions, undefined); assert.equal(f.counts.workCalls, 0);
  }
});

test('account, generation and server principal mismatches deny before connection and after network work', async () => {
  const wrong = fixture();
  await assert.rejects(wrong.run({ ...visible(wrong.account), connection_revision: 3 }), error => error instanceof EmailImapHostError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.equal(wrong.counts.lookupCalls, 0); assert.equal(wrong.counts.connects, 0);
  const changed = fixture(); changed.accountChangeAtWork = true;
  await assert.rejects(changed.run(), error => error instanceof EmailImapHostError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.equal(changed.counts.workCalls, 1); assert.equal(changed.counts.logouts, 1);
  const revokedDuringDns = fixture({ changeAfterDns: true });
  await assert.rejects(revokedDuringDns.run(), error => error instanceof EmailImapHostError && error.code === 'EMAIL_ACCESS_DENIED');
  assert.equal(revokedDuringDns.counts.lookupCalls, 1); assert.equal(revokedDuringDns.counts.connects, 0);
});

test('TLS/authentication failure sanitizes errors and always closes the client', async () => {
  for (const options of [{ secure: false }, { auth: false }, { connectError: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), error => error instanceof EmailImapHostError
      && ['EMAIL_IMAP_TLS_REQUIRED', 'EMAIL_IMAP_CONNECT_FAILED'].includes(error.code)
      && !error.message.includes(secret));
    assert.ok(f.counts.logouts <= 1); assert.equal(f.counts.closes, 1);
    assert.equal(f.clientOptions?.auth.pass, '');
  }
});

test('abort while connecting closes the socket and never runs the mailbox callback', async () => {
  const f = fixture({ connectHeld: true });
  const controller = new AbortController(); Object.assign(f.context, { signal: controller.signal });
  const pending = f.run();
  while (f.counts.connects === 0) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(new Error('fixture cancellation'));
  await assert.rejects(pending, /cancel/i);
  assert.equal(f.counts.closes, 1); assert.equal(f.counts.workCalls, 0); assert.equal(f.clientOptions?.auth.pass, '');
});
