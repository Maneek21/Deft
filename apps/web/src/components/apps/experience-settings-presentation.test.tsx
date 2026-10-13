import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperienceSettings } from './experience-settings';
import { ExperienceRequestStatus } from './experience-run-review';

test('settings displays the host-selected account and retains source details without inventing preferences', () => {
  const html = renderToStaticMarkup(<ExperienceSettings experienceLabel="Email" onBack={() => {}}
    accounts={[{ key: 'work', label: 'Work', statusLabel: 'Connected', detail: 'Reviewed work mailbox' }, { key: 'personal', label: 'Personal' }]}
    selectedAccountKey="work" onSelectAccount={() => {}} access={{ state: 'active' }} />);
  assert.match(html, /Current account/);
  assert.match(html, /aria-label="Use account Personal"/);
  assert.match(html, /<summary[^>]*>Source details<\/summary>/);
  assert.match(html, /Reviewed work mailbox/);
  assert.match(html, /Actions you choose/);
  assert.match(html, /Every permitted request still needs your approval/);
  assert.doesNotMatch(html, /Preferences|default sending|last sync/i);
});

test('unsupported account selection has no fabricated action', () => {
  const html = renderToStaticMarkup(<ExperienceSettings experienceLabel="Email" onBack={() => {}}
    accounts={[{ key: 'work', label: 'Work' }, { key: 'personal', label: 'Personal' }]} selectedAccountKey="work" access={{ state: 'unavailable' }} />);
  assert.doesNotMatch(html, /Use account/);
  assert.match(html, /Private access unavailable/);
});

test('direct Access entry opens its section while a missing Preferences section falls back to Accounts', () => {
  const props = {experienceLabel:'Email',onBack:()=>{},accounts:[],selectedAccountKey:'primary',access:{state:'active' as const}};
  const access = renderToStaticMarkup(<ExperienceSettings {...props} initialSection="access" accessReview={<p>Exact private records</p>} />);
  assert.match(access, /<section aria-labelledby="[^"]+-access">/);assert.match(access, /Exact private records/);assert.match(access, /<section hidden="" aria-labelledby="[^"]+-accounts">/);
  const fallback = renderToStaticMarkup(<ExperienceSettings {...props} initialSection="preferences" />);
  assert.match(fallback, /<section aria-labelledby="[^"]+-accounts">/);assert.doesNotMatch(fallback, /aria-labelledby="[^"]+-preferences"/);
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
