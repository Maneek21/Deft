/**
 * Run: pnpm --filter @deft/web exec tsx --test src/lib/buy-seats.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buySeatsHref, buySeatsHrefForRefusal } from './buy-seats';

const PAGE = 'https://deft-control-plane.fly.dev/seats';

test('only an https address the API sent becomes a link', () => {
  assert.equal(buySeatsHref(PAGE), PAGE);
  for (const value of [undefined, null, '', 42, 'http://deft-control-plane.fly.dev/seats', 'javascript:alert(1)', '/seats', 'not a url']) {
    assert.equal(buySeatsHref(value), null, JSON.stringify(value));
  }
});

test('a refused add links to the seats page only when it was refused for want of seats', () => {
  assert.equal(buySeatsHrefForRefusal({ code: 'SEAT_LIMIT_REACHED', buy_seats_url: PAGE }), PAGE);
  // An admin's refusal, or a self-hosted or unset cell: the API sends no address.
  assert.equal(buySeatsHrefForRefusal({ code: 'SEAT_LIMIT_REACHED' }), null);
  // Growth frozen is not fixed by buying seats.
  assert.equal(buySeatsHrefForRefusal({ code: 'SEAT_GROWTH_FROZEN', buy_seats_url: PAGE }), null);
  assert.equal(buySeatsHrefForRefusal({ code: 'ALREADY_MEMBER' }), null);
  assert.equal(buySeatsHrefForRefusal(null), null);
});
