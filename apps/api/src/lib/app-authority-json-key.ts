/** Exact JSON bytes only: a cache key must not erase values through stringify.
 * Non-JSON, excessive or oversized inputs simply use their ordinary parser. */
export function boundedAppAuthorityJsonKey(raw: unknown, maxBytes: number): string | undefined {
  let remaining = 50000;
  const active = new Set<object>();
  const json = (value: unknown, depth = 0): boolean => {
    if (--remaining < 0 || depth > 64) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
    if (typeof value !== 'object' || active.has(value)) return false;
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string') || array && keys.length !== value.length + 1) return false;
    active.add(value);
    try {
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (array && (typeof key !== 'string' || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= value.length)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !('value' in descriptor) || !json(descriptor.value, depth + 1)) return false;
      }
      return true;
    } finally { active.delete(value); }
  };
  try {
    if (!json(raw)) return undefined;
    const key = JSON.stringify(raw);
    return key !== undefined && Buffer.byteLength(key) <= maxBytes ? key : undefined;
  } catch { return undefined; }
}
