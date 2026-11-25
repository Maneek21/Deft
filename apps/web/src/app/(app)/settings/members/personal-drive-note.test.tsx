import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonalDriveNote, personalDriveOutcome } from './personal-drive-note';

test('with a replacement, the remove-member dialog says the personal drive goes to them', () => {
  assert.equal(personalDriveOutcome('Rahul Mehta'), 'Their personal drive goes to Rahul Mehta.');
  const html = renderToStaticMarkup(<PersonalDriveNote replacementName="Rahul Mehta" />);
  assert.match(html, /data-testid="offboarding-personal-drive"/);
  assert.match(html, />Their personal drive goes to Rahul Mehta\.</);
});

test('without a replacement, the remove-member dialog says the personal drive will be frozen', () => {
  for (const none of [null, '', '   ']) {
    assert.equal(personalDriveOutcome(none), 'Their personal drive will be frozen until an owner hands it on.');
  }
  assert.match(renderToStaticMarkup(<PersonalDriveNote replacementName={null} />),
    />Their personal drive will be frozen until an owner hands it on\.</);
});

test('a name is shown as plain text', () => {
  const html = renderToStaticMarkup(<PersonalDriveNote replacementName={'<b>Eve</b>'} />);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /Their personal drive goes to &lt;b&gt;Eve&lt;\/b&gt;\./);
});
