import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperienceSettings } from './experience-settings';
import { ExperienceRequestStatus } from './experience-run-review';

test('settings renders one account card with health, permissions, agent requests and a visible switcher', () => {
  const html = renderToStaticMarkup(<ExperienceSettings experienceLabel="Email" onBack={() => {}}
    accounts={[{ key: 'work', label: 'Work', statusLabel: 'Connected', detail: 'Reviewed work mailbox' }, { key: 'personal', label: 'Personal' }]}
    selectedAccountKey="work" onSelectAccount={() => {}} access={{ state: 'active' }}
    connectAccount={<p>Connection controls</p>} accessReview={<p>Exact private records</p>}
    agentPolicy={<p>Read messages policy</p>} />);
  assert.match(html, /Everything is healthy · Private access and background sync are active\./);
  assert.match(html, /Current account/);
  assert.match(html, /aria-label="Use account Personal"/);
  assert.match(html, /<summary[^>]*>Source details<\/summary>/);
  assert.match(html, /Reviewed work mailbox/);
  assert.match(html, /Connection controls/);
  assert.match(html, /Exact private records/);
  assert.match(html, /Agent requests/);
  assert.match(html, /Read messages policy/);
  assert.match(html, /Open approvals/);
  assert.match(html, /Every permitted request still needs your approval/);
  assert.doesNotMatch(html, /settings sections|<summary[^>]*>Accounts<\/summary>/);
  assert.doesNotMatch(html, /hidden=""/);
  assert.doesNotMatch(html, /Preferences|default sending|last sync/i);
});

test('attention state replaces the healthy summary and offers a restore action', () => {
  const html = renderToStaticMarkup(<ExperienceSettings experienceLabel="Email" onBack={() => {}}
    accounts={[{ key: 'work', label: 'Work', statusLabel: 'Reconnect needed' }]} selectedAccountKey="work"
    access={{ state: 'review_required' }} onReviewAccess={() => {}} />);
  assert.match(html, /Attention needed · Review connection or permissions below\./);
  assert.match(html, /Restore access/);
  assert.match(html, /Access requires your review/);
  assert.doesNotMatch(html, /Everything is healthy/);
});

test('long account labels wrap on a phone instead of forcing horizontal overflow', () => {
  const label = 'a'.repeat(72) + '@example.test';
  const html = renderToStaticMarkup(<ExperienceSettings experienceLabel="Email" onBack={() => {}}
    accounts={[{ key: 'work', label }]} selectedAccountKey="work" access={{ state: 'active' }} />);
  assert.match(html, new RegExp(`title="${label}"`));
  assert.match(html, /break-all/);
  assert.match(html, /sm:truncate/);
});

test('unsupported account selection has no fabricated action', () => {
  const html = renderToStaticMarkup(<ExperienceSettings experienceLabel="Email" onBack={() => {}}
    accounts={[{ key: 'work', label: 'Work' }, { key: 'personal', label: 'Personal' }]} selectedAccountKey="work" access={{ state: 'unavailable' }} />);
  assert.doesNotMatch(html, /Use account/);
  assert.match(html, /Private access unavailable/);
});

test('direct Access and Approvals entry keeps the whole card mounted and Preferences only when supplied', () => {
  const props = {experienceLabel:'Email',onBack:()=>{},accounts:[],selectedAccountKey:'primary',access:{state:'active' as const}};
  for (const initialSection of ['access', 'approvals'] as const) {
    const html = renderToStaticMarkup(<ExperienceSettings {...props} initialSection={initialSection} accessReview={<p>Exact private records</p>} />);
    assert.match(html, /Exact private records/);
    assert.match(html, /Agent requests/);
    assert.doesNotMatch(html, /aria-labelledby="[^"]+-preferences"/);
  }
  const preferences = renderToStaticMarkup(<ExperienceSettings {...props} initialSection="preferences" preferences={<p>Preference form</p>} />);
  assert.match(preferences, /Preference form/);
  assert.match(preferences, /Agent requests/);
});

test('request outcomes distinguish pending, provider wait, failure, and unknown without claiming delivery', () => {
  for (const [state, label] of [['pending_approval', 'Awaiting your approval'], ['pending', 'Request queued'],
    ['waiting_external', 'Waiting for provider'], ['failed', 'Request failed'], ['unknown_outcome', 'Outcome unknown']]) {
    assert.match(renderToStaticMarkup(<ExperienceRequestStatus state={state} />), new RegExp(label));
  }
  const success = renderToStaticMarkup(<ExperienceRequestStatus state="succeeded" />);
  assert.match(success, /Execution succeeded/);
  assert.match(success, /does not confirm message delivery/);
});

test('an uncertain decision overrides a stale successful state and exposes recovery guidance', () => {
  const html = renderToStaticMarkup(<ExperienceRequestStatus state="succeeded" uncertain />);
  assert.match(html, /Decision not confirmed/);
  assert.match(html, /will not be retried automatically/);
  assert.doesNotMatch(html, /Execution succeeded/);
});
