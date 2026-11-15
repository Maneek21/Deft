/**
 * Run: pnpm exec tsx --test apps/web/src/lib/link-token.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLinkToken, readLinkToken, type LinkTokenBox } from './link-token';
import nextConfig from '../../next.config';

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

/** A minimal browser address that replaceState really changes. */
function fakeBrowser(href: string) {
  const url = new URL(href, 'https://deft.test');
  const calls: string[] = [];
  const location = {
    get hash() { return url.hash; },
    get search() { return url.search; },
    get pathname() { return url.pathname; },
  };
  const history = {
    state: { kept: true } as unknown,
    replaceState(data: unknown, _unused: string, next?: string | null) {
      assert.equal(data, history.state, 'history state is preserved');
      calls.push(String(next));
      const target = new URL(String(next), url);
      url.hash = target.hash;
      url.search = target.search;
      url.pathname = target.pathname;
    },
  };
  return { location, history, calls, address: () => `${url.pathname}${url.search}${url.hash}` };
}

test('captures a fragment token and strips it from the address', () => {
  for (const [href, cleanPath] of [['/invite#token=abc', '/invite'], ['/reset-password#token=abc', '/reset-password']] as const) {
    const b = fakeBrowser(href);
    const box: LinkTokenBox = { current: undefined };
    assert.equal(captureLinkToken(box, b.location, b.history, cleanPath), 'abc');
    assert.equal(b.address(), cleanPath);
  }
});

test('captures old-style links and strips them too', () => {
  const reset = fakeBrowser('/reset-password?token=old');
  assert.equal(captureLinkToken({ current: undefined }, reset.location, reset.history, '/reset-password'), 'old');
  assert.equal(reset.address(), '/reset-password');

  const invite = fakeBrowser('/invite/path-token');
  assert.equal(captureLinkToken({ current: undefined }, invite.location, invite.history, '/invite', 'path-token'), 'path-token');
  assert.equal(invite.address(), '/invite');
});

test('a missing or malformed fragment gives null and leaves the address alone', () => {
  for (const href of ['/invite', '/invite#', '/invite#token=', '/invite#tok=abc', '/reset-password#%zz']) {
    const b = fakeBrowser(href);
    assert.equal(captureLinkToken({ current: undefined }, b.location, b.history, href.split('#')[0]!), null, href);
    assert.deepEqual(b.calls, [], href);
  }
});

test('a second call (StrictMode re-running the mount effect) returns the same token', () => {
  const b = fakeBrowser('/reset-password#token=once');
  const box: LinkTokenBox = { current: undefined };
  assert.equal(captureLinkToken(box, b.location, b.history, '/reset-password'), 'once');
  assert.equal(captureLinkToken(box, b.location, b.history, '/reset-password'), 'once');
  assert.equal(b.calls.length, 1);
  assert.equal(b.address(), '/reset-password');

  const empty = fakeBrowser('/invite');
  const emptyBox: LinkTokenBox = { current: undefined };
  assert.equal(captureLinkToken(emptyBox, empty.location, empty.history, '/invite'), null);
  assert.equal(captureLinkToken(emptyBox, empty.location, empty.history, '/invite'), null);
});

test('invite and reset pages send no Referer', async () => {
  const rules = await nextConfig.headers!();
  const policyFor = (source: string) => {
    // Next applies every matching rule in order; a later key wins.
    let policy: string | undefined;
    for (const rule of rules) {
      if (rule.source !== source && rule.source !== '/(.*)') continue;
      for (const header of rule.headers) if (header.key === 'Referrer-Policy') policy = header.value;
    }
    return policy;
  };
  for (const source of ['/invite', '/invite/:path*', '/reset-password']) {
    assert.equal(policyFor(source), 'no-referrer', source);
  }
  assert.equal(policyFor('/login'), 'strict-origin-when-cross-origin');
});
