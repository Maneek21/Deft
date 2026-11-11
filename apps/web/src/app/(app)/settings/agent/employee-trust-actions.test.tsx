import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EmployeeTrustActions,
  employeeAutonomousConfirmLines,
  lowerTrustLevels,
} from './employee-trust-actions';

const noop = () => {};
const render = (trustLevel: string, canEdit: boolean) => renderToStaticMarkup(
  <EmployeeTrustActions trustLevel={trustLevel} canEdit={canEdit} busy={false} onUpgrade={noop} onLower={noop} />,
);

test('Trust-a: a member who is not owner or admin sees no upgrade button', () => {
  const html = render('standard', false);
  assert.doesNotMatch(html, /upgrade-autonomous-btn|Upgrade to autonomous/);
  assert.doesNotMatch(html, /lower-trust-/);
  assert.match(html, /Trust: Standard/);
  assert.match(html, /Only workspace owners and admins can change the trust level\./);
});

test('Trust-a: an owner or admin still sees the upgrade button below autonomous', () => {
  assert.match(render('conservative', true), /data-testid="upgrade-autonomous-btn"/);
  assert.match(render('standard', true), /data-testid="upgrade-autonomous-btn"/);
  assert.doesNotMatch(render('autonomous', true), /upgrade-autonomous-btn/);
});

test('Trust-b: an owner or admin can lower trust to each level below the current one', () => {
  assert.deepEqual(lowerTrustLevels('autonomous'), ['standard', 'conservative']);
  assert.deepEqual(lowerTrustLevels('standard'), ['conservative']);
  assert.deepEqual(lowerTrustLevels('conservative'), []);
  assert.deepEqual(lowerTrustLevels('unknown'), []);
  const html = render('autonomous', true);
  assert.match(html, /data-testid="lower-trust-standard"/);
  assert.match(html, /data-testid="lower-trust-conservative"/);
  assert.doesNotMatch(render('conservative', true), /lower-trust-/);
});

test('Trust-b: the drawer confirmation no longer says Settings cannot lower the level', () => {
  const text = employeeAutonomousConfirmLines().join(' ');
  assert.doesNotMatch(text, /no control to lower/);
  assert.match(text, /Only workspace owners and admins can make this change\. They can lower it again from this panel\./);
});
