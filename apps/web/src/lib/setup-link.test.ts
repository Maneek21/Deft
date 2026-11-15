import test from 'node:test';
import assert from 'node:assert/strict';
import { takeSetupTokenFromAddress } from './setup-link';

function address(pathname: string, search: string, hash: string) {
  const replaced: Array<[unknown, string, string]> = [];
  const history = {
    replaceState(state: unknown, unused: string, url?: string | URL | null) {
      replaced.push([state, unused, String(url)]);
    },
  };
  return { location: { pathname, search, hash }, history, replaced };
}

test('the setup token is read from the part after # and taken out of the address', () => {
  const page = address('/signup', '', '#setup=abc-DEF_123');
  assert.equal(takeSetupTokenFromAddress(page.location, page.history), 'abc-DEF_123');
  assert.deepEqual(page.replaced, [[null, '', '/signup']]);
});

test('the rest of the address is kept and other # values do not confuse the read', () => {
  const page = address('/signup', '?ref=welcome', '#lang=en&setup=tok3n&x=1');
  assert.equal(takeSetupTokenFromAddress(page.location, page.history), 'tok3n');
  assert.deepEqual(page.replaced, [[null, '', '/signup?ref=welcome']]);
});

test('the token is never read from the query string', () => {
  for (const [search, hash] of [['?setup=from-query', ''], ['?setup=from-query', '#'], ['?setup=from-query', '#notsetup=x'], ['', '#presetup=x']]) {
    const page = address('/signup', search!, hash!);
    assert.equal(takeSetupTokenFromAddress(page.location, page.history), null);
    assert.deepEqual(page.replaced, [], 'an address without a setup token is left alone');
  }
});

test('an empty token is no token; token characters arrive unchanged', () => {
  const empty = address('/signup', '', '#setup=');
  assert.equal(takeSetupTokenFromAddress(empty.location, empty.history), null);

  const plus = address('/signup', '', '#setup=a+b/c=');
  assert.equal(takeSetupTokenFromAddress(plus.location, plus.history), 'a+b/c=', 'a plus sign is not turned into a space');

  const encoded = address('/signup', '', '#setup=a%2Bb');
  assert.equal(takeSetupTokenFromAddress(encoded.location, encoded.history), 'a+b');

  const malformed = address('/signup', '', '#setup=100%');
  assert.equal(takeSetupTokenFromAddress(malformed.location, malformed.history), '100%');
  assert.deepEqual(malformed.replaced, [[null, '', '/signup']]);
});
