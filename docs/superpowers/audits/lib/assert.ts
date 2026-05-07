/**
 * Hard assertion helper for audit scripts. Throws with a descriptive
 * message when the condition is false. The caller catches + screenshots
 * + exits non-zero.
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

export function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `Assertion failed: ${message}\n  expected substring: ${JSON.stringify(needle)}\n  not found in: ${JSON.stringify(haystack.slice(0, 500))}`,
    );
  }
}
