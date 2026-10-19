/**
 * Return the intended test target only when it is also the URL resolved by the
 * runtime DB client and its database name is explicitly disposable.
 * Missing, mismatched, malformed, or production-like targets fail closed.
 *
 * This module must not import runtime configuration: tests that set feature
 * flags before loading the API rely on it being side-effect free.
 */
export function isSafeTestDatabaseTarget(
  intended: string | undefined,
  runtime: string | undefined,
): string | undefined {
  const expected = intended?.trim();
  const actual = runtime?.trim();
  if (!expected || !actual || expected !== actual) return undefined;
  try {
    const parsed = new URL(actual);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined;
    const databaseName = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    if (!/(?:^|[-_])(test|ci|acceptance|gauntlet|phase\d+|release[-_]?upgrade|upgrade[-_]?release)(?:$|[-_])/i.test(databaseName)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return expected;
}

/** Guard for tests that read DATABASE_URL directly instead of the runtime env module. */
export function processTestDatabaseUrl(): string | undefined {
  return isSafeTestDatabaseTarget(process.env.DEFT_TEST_DATABASE_URL, process.env.DATABASE_URL);
}
