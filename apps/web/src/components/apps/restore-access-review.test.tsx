import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RestoreAccessReview, grantLabel } from './restore-access-review';

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
