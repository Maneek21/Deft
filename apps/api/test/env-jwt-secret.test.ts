import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveJwtSecret } from '../src/lib/env.js';

const DEV_JWT_SECRET = 'dev-jwt-secret-change-me';
const DEV_JWT_REFRESH_SECRET = 'dev-refresh-secret-change-me';

test('resolveJwtSecret: production throws when JWT_SECRET is unset', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => resolveJwtSecret(undefined, DEV_JWT_SECRET, 'JWT_SECRET'),
      /JWT_SECRET must be a non-default secret of at least 32 characters in production/,
    );
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: production throws when JWT_SECRET is the dev default', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => resolveJwtSecret(DEV_JWT_SECRET, DEV_JWT_SECRET, 'JWT_SECRET'),
      /JWT_SECRET must be a non-default secret of at least 32 characters in production/,
    );
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: production throws when JWT_SECRET contains CHANGE_ME', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => resolveJwtSecret('CHANGE_ME_JWT_SECRET', DEV_JWT_SECRET, 'JWT_SECRET'),
      /JWT_SECRET must be a non-default secret of at least 32 characters in production/,
    );
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: production throws when JWT_SECRET is too short', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => resolveJwtSecret('short', DEV_JWT_SECRET, 'JWT_SECRET'),
      /JWT_SECRET must be a non-default secret of at least 32 characters in production/,
    );
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: production throws when JWT_REFRESH_SECRET is unset', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => resolveJwtSecret(undefined, DEV_JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET'),
      /JWT_REFRESH_SECRET must be a non-default secret of at least 32 characters in production/,
    );
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: production accepts a valid 32+ character secret', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const valid = 'a'.repeat(32);
    assert.equal(resolveJwtSecret(valid, DEV_JWT_SECRET, 'JWT_SECRET'), valid);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: production accepts a valid 64 character secret', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const valid = 'b'.repeat(64);
    assert.equal(resolveJwtSecret(valid, DEV_JWT_SECRET, 'JWT_SECRET'), valid);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: production trims whitespace before validating', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const valid = '  ' + 'c'.repeat(32) + '  ';
    assert.equal(resolveJwtSecret(valid, DEV_JWT_SECRET, 'JWT_SECRET'), 'c'.repeat(32));
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: development returns dev default when unset', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    assert.equal(resolveJwtSecret(undefined, DEV_JWT_SECRET, 'JWT_SECRET'), DEV_JWT_SECRET);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: development returns dev default when empty string', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    assert.equal(resolveJwtSecret('', DEV_JWT_SECRET, 'JWT_SECRET'), DEV_JWT_SECRET);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: development returns configured value when set', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const custom = 'my-custom-dev-secret';
    assert.equal(resolveJwtSecret(custom, DEV_JWT_SECRET, 'JWT_SECRET'), custom);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: development returns dev default for JWT_REFRESH_SECRET when unset', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    assert.equal(resolveJwtSecret(undefined, DEV_JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET'), DEV_JWT_REFRESH_SECRET);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: development returns configured JWT_REFRESH_SECRET when set', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const custom = 'my-custom-refresh-secret';
    assert.equal(resolveJwtSecret(custom, DEV_JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET'), custom);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: test mode returns dev default when unset', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    assert.equal(resolveJwtSecret(undefined, DEV_JWT_SECRET, 'JWT_SECRET'), DEV_JWT_SECRET);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test('resolveJwtSecret: test mode returns configured value when set', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const custom = 'test-secret';
    assert.equal(resolveJwtSecret(custom, DEV_JWT_SECRET, 'JWT_SECRET'), custom);
  } finally {
    process.env.NODE_ENV = original;
  }
});
