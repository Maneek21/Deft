import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperienceAgentPolicy } from './experience-agent-policy';

test('agent requests render as one toggle list, not a single action dropdown', () => {
  const html = renderToStaticMarkup(<ExperienceAgentPolicy
    sessionId="00000000-0000-4000-8000-000000000001"
    actions={['mirror_drafts', 'organize_messages', 'send_message']}
    ensureAuthority={async () => true} />);
  assert.match(html, /aria-label="Agent action permissions"/);
  assert.match(html, /mirror drafts/);
  assert.match(html, /organize messages/);
  assert.match(html, /send message/);
  // The retired one-at-a-time control is gone.
  assert.doesNotMatch(html, /Save agent permission/);
  assert.doesNotMatch(html, /<label[^>]*>Action<select/);
  // Three toggles, one per action, all defaulting to deny (unchecked).
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
});

test('an empty action list renders nothing', () => {
  const html = renderToStaticMarkup(<ExperienceAgentPolicy
    sessionId="00000000-0000-4000-8000-000000000001" actions={[]} ensureAuthority={async () => true} />);
  assert.equal(html, '');
});
