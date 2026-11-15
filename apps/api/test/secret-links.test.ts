import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInviteUrl, buildRecoveryUrl } from '../src/lib/secret-links.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOiJ5ZXMifQ.c2lnbmF0dXJlLXNlY3JldA';

test('invite and recovery links carry the token only after #', () => {
  for (const [link, path] of [
    [buildInviteUrl('https://app.example.test', TOKEN), '/invite'],
    [buildRecoveryUrl('https://app.example.test', TOKEN), '/reset-password'],
    [buildInviteUrl('https://app.example.test/', TOKEN), '/invite'],
    [buildRecoveryUrl('https://app.example.test//', TOKEN), '/reset-password'],
  ] as const) {
    const [beforeHash, fragment] = link.split('#');
    assert.equal(beforeHash, `https://app.example.test${path}`);
    assert.ok(!beforeHash!.includes(TOKEN));
    assert.equal(new URLSearchParams(fragment).get('token'), TOKEN);
    const url = new URL(link);
    assert.equal(url.pathname, path);
    assert.equal(url.search, '');
  }
});

test('links encode characters that would break the fragment', () => {
  const link = buildInviteUrl('https://app.example.test', 'a&b=c#d');
  assert.equal(link, 'https://app.example.test/invite#token=a%26b%3Dc%23d');
  assert.equal(new URLSearchParams(new URL(link).hash.slice(1)).get('token'), 'a&b=c#d');
});
