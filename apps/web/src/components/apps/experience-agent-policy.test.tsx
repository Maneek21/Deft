import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperienceAgentPolicy } from './experience-agent-policy';

test('agent requests render one control per action, not a single action dropdown', () => {
  const html = renderToStaticMarkup(<ExperienceAgentPolicy
    sessionId="00000000-0000-4000-8000-000000000001"
    actions={['mirror_drafts', 'organize_messages', 'send_message']}
    ensureAuthority={async () => true} />);
  assert.match(html, /aria-label="Agent action permissions"/);
  assert.match(html, /Mirror drafts/);
  assert.match(html, /Organize messages/);
  assert.match(html, /Send message/);
  // The retired one-at-a-time control is gone.
  assert.doesNotMatch(html, /Save agent permission/);
  assert.doesNotMatch(html, /<label[^>]*>Action<select/);
  // Three controls, one per action, all defaulting to deny.
  assert.equal((html.match(/<select/g) ?? []).length, 3);
  assert.equal((html.match(/<option value="deny" selected="">/g) ?? []).length, 3);
});

test('an empty action list renders nothing', () => {
  const html = renderToStaticMarkup(<ExperienceAgentPolicy
    sessionId="00000000-0000-4000-8000-000000000001" actions={[]} ensureAuthority={async () => true} />);
  assert.equal(html, '');
});
