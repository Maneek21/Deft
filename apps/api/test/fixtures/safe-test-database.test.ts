import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeTestDatabaseTarget } from './safe-test-database.js';

test('safe DB guard fails closed when the intended target is missing', () => {
  assert.equal(isSafeTestDatabaseTarget(undefined, 'postgres://localhost/test'), undefined);
});

test('safe DB guard fails closed when runtime and intended targets differ', () => {
  assert.equal(
    isSafeTestDatabaseTarget('postgres://localhost/deft_test', 'postgres://localhost/deft_acceptance'),
    undefined,
  );
});

test('safe DB guard fails closed for a non-disposable database name', () => {
  assert.equal(
    isSafeTestDatabaseTarget('postgres://localhost/deft', 'postgres://localhost/deft'),
    undefined,
  );
});

test('safe DB guard accepts matching disposable targets', () => {
  assert.equal(
    isSafeTestDatabaseTarget('postgres://localhost/deft_acceptance', 'postgres://localhost/deft_acceptance'),
    'postgres://localhost/deft_acceptance',
  );
});

test('safe DB guard rejects malformed and non-PostgreSQL URLs', () => {
  assert.equal(isSafeTestDatabaseTarget('not a URL', 'not a URL'), undefined);
  assert.equal(isSafeTestDatabaseTarget('https://localhost/deft_test', 'https://localhost/deft_test'), undefined);
});

test('safe DB guard accepts percent-encoded disposable names', () => {
  assert.equal(
    isSafeTestDatabaseTarget('postgres://localhost/deft%5Facceptance', 'postgres://localhost/deft%5Facceptance'),
    'postgres://localhost/deft%5Facceptance',
  );
});

test('safe DB guard rejects marker substrings and blank runtime values', () => {
  assert.equal(isSafeTestDatabaseTarget('postgres://localhost/contest', 'postgres://localhost/contest'), undefined);
  assert.equal(isSafeTestDatabaseTarget('postgres://localhost/deft_test', '   '), undefined);
});

test('safe DB guard trims equal whitespace-padded targets', () => {
  assert.equal(
    isSafeTestDatabaseTarget('  postgresql://localhost/deft-ci  ', 'postgresql://localhost/deft-ci'),
    'postgresql://localhost/deft-ci',
  );
});
