import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RestoreAccessReview, grantLabel, loadRestoreReview } from './restore-access-review';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const contextFor = (targetKey: string, sessionId: string) => ({ schema_version: 'deft.app_restore_access_context.v1',
  installation_id: INSTALLATION, target_key: targetKey, account_ref: 'acct_' + targetKey, session_id: sessionId, same_account: true, grants: [] });
const reviewFor = (targetKey: string, sessionId: string) => ({ schema_version: 'deft.app_restore_access_review.v1', review_id: 'r',
  review_digest: 'sha256:' + '0'.repeat(64), review_expires_at: new Date().toISOString(), installation_id: INSTALLATION,
  target_key: targetKey, account_ref: 'acct_' + targetKey, session_id: sessionId, grants: [] });

test('PR424-F03: the dialog reviews the selected target, never the installation-wide newest account', async () => {
  const calls: Array<{ path: string; body?: string }> = [];
  // Server state: account B has the newest connected session installation-wide.
  const fetcher = async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body as string | undefined });
    if (path.includes('/restore-context')) {
      const selected = new URL(path, 'https://host.test').searchParams.get('target_key');
      return json(selected === 'account_a' ? contextFor('account_a', 'session-a') : contextFor('account_b', 'session-b'));
    }
    const body = JSON.parse(String(init?.body));
    return json(body.target_key === 'account_a' ? reviewFor('account_a', 'session-a') : reviewFor('account_b', 'session-b'));
  };
  const loaded = await loadRestoreReview(fetcher, INSTALLATION, 'account_a');
  assert.equal(loaded.context.target_key, 'account_a');
  assert.equal(loaded.review?.target_key, 'account_a');
  assert.match(calls[0]!.path, /\/restore-context\?target_key=account_a$/u);
  assert.equal(JSON.parse(calls[1]!.body!).target_key, 'account_a');
});

test('PR424-F03: a context or review for a different target is refused', async () => {
  const contextB = async () => json(contextFor('account_b', 'session-b'));
  await assert.rejects(loadRestoreReview(contextB, INSTALLATION, 'account_a'), /could not be read/u);
  const reviewB = async (path: string) => path.includes('/restore-context') ? json(contextFor('account_a', 'session-a')) : json(reviewFor('account_b', 'session-b'));
  await assert.rejects(loadRestoreReview(reviewB, INSTALLATION, 'account_a'), /could not be reviewed/u);
});

test('restore review renders its heading and a pending notice before any route returns', () => {
  const html = renderToStaticMarkup(<RestoreAccessReview installationId="11111111-1111-4111-8111-111111111111" targetKey="primary" onClose={() => {}} />);
  assert.match(html, /Restore access/);
  assert.match(html, /Checking the previously connected account/);
});

test('grant labels stay app-neutral and never echo raw enum casing', () => {
  const lifetime = { kind: 'until_revoked' } as const;
  assert.equal(grantLabel({ grant_id: 'a', kind: 'record_consent', store_key: 'notes', lifetime, restorable: true, preselected: true }), 'Saved notes access');
  assert.equal(grantLabel({ grant_id: 'b', kind: 'action_consent', action_key: 'share_item', lifetime, restorable: true, preselected: false }), 'share item action access');
  assert.equal(grantLabel({ grant_id: 'c', kind: 'capture_policy', store_key: 'records', lifetime, restorable: true, preselected: true }), 'Knowledge capture for records');
  assert.equal(grantLabel({ grant_id: 'd', kind: 'agent_policy_default', action_key: 'mirror_notes', lifetime, restorable: true, preselected: false }), 'Agent permission (mirror notes)');
  assert.equal(grantLabel({ grant_id: 'e', kind: 'defty_read_grant', store_key: 'records', lifetime, restorable: true, preselected: false }), 'Workspace read access to records');
});
