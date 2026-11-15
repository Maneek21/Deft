/**
 * Run: pnpm exec tsx --test apps/web/src/lib/link-token.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readLinkToken } from './link-token';

test('reads the token from the fragment', () => {
  assert.equal(readLinkToken('#token=abc.def.ghi'), 'abc.def.ghi');
  assert.equal(readLinkToken('token=abc'), 'abc');
  assert.equal(readLinkToken('#token=a%26b%3Dc%23d'), 'a&b=c#d');
});

test('prefers the fragment over an old-style query token', () => {
  assert.equal(readLinkToken('#token=new', '?token=old'), 'new');
});

test('falls back to an old-style ?token= link', () => {
  assert.equal(readLinkToken('', '?token=old'), 'old');
  assert.equal(readLinkToken('#other=1', 'token=old'), 'old');
});

test('returns null when no token is present', () => {
  assert.equal(readLinkToken(''), null);
  assert.equal(readLinkToken('#token=', '?token='), null);
  assert.equal(readLinkToken('#activity', '?x=1'), null);
});
