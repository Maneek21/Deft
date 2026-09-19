import { sessionSWRKey, sessionSWRPath } from './session-cache';

const MODULE_POST_INPUT_SEPARATOR = '::module-post-input::';

export function moduleSessionReadCacheKey(
  sessionCacheScope: string | null,
  path: string | null,
): string | null {
  return sessionSWRKey(sessionCacheScope, path);
}

export function moduleSessionPostCacheKey(
  sessionCacheScope: string | null,
  path: string | null,
  input: unknown,
): string | null {
  return sessionSWRKey(
    sessionCacheScope,
    path === null
      ? null
      : `${path}${MODULE_POST_INPUT_SEPARATOR}${encodeURIComponent(JSON.stringify(input))}`,
  );
}

export function moduleSessionRequestPath(key: string): string {
  return sessionSWRPath(key).split(MODULE_POST_INPUT_SEPARATOR, 1)[0]!;
}
