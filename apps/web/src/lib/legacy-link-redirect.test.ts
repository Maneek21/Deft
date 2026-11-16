import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

test('legacy invite paths normalize to a static fragment route without cacheable credentials', () => {
  const response = proxy(new NextRequest('https://deft.test/invite/legacy%2Btoken'));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://deft.test/invite#token=legacy%2Btoken');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('legacy recovery and invite queries normalize without carrying the query onward', () => {
  for (const path of ['/reset-password', '/invite']) {
    const response = proxy(new NextRequest(`https://deft.test${path}?token=a%26b%3Dc&other=1`));
    const target = new URL(response.headers.get('location')!);
    assert.equal(target.pathname, path);
    assert.equal(target.search, '');
    assert.equal(new URLSearchParams(target.hash.slice(1)).get('token'), 'a&b=c');
  }
});

test('new fragment links, missing tokens and unrelated routes are not redirected', () => {
  for (const path of ['/invite#token=new', '/reset-password#token=new', '/invite', '/reset-password?token=', '/login?token=x', '/invite/%zz']) {
    assert.equal(proxy(new NextRequest(`https://deft.test${path}`)).headers.get('location'), null, path);
  }
});
