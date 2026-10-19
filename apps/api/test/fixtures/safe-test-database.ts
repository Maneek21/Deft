import { env } from '../../src/lib/env.js';
import { isSafeTestDatabaseTarget } from './safe-test-database-target.js';

export { isSafeTestDatabaseTarget };

export function safeTestDatabaseUrl(
  intended = process.env.DEFT_TEST_DATABASE_URL,
  runtime = env.DATABASE_URL,
): string | undefined {
  return isSafeTestDatabaseTarget(intended, runtime);
}

export const runtimeDatabaseUrl = env.DATABASE_URL?.trim();
