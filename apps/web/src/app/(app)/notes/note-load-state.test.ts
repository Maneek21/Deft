import test from 'node:test';
import assert from 'node:assert/strict';
import { noteLoadFailureState } from './note-load-state';

test('denied and missing note links use the same unavailable state', () => {
  assert.equal(noteLoadFailureState(403), 'unavailable');
  assert.equal(noteLoadFailureState(404), 'unavailable');
});

test('transport and server failures remain retryable errors', () => {
  assert.equal(noteLoadFailureState(401), 'error');
  assert.equal(noteLoadFailureState(500), 'error');
});
