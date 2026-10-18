export function canonicalAppDataJson(value: unknown): string {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 65536 || depth > 32) throw new TypeError('App data value is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const result: Record<string, unknown> = Object.create(null);
      for (const name of Object.keys(item).sort()) {
        if (['constructor','prototype','__proto__'].includes(name)) throw new TypeError('Reserved app data property');
        result[name] = visit((item as Record<string, unknown>)[name], depth + 1);
      }
      return result;
    }
    throw new TypeError('App data must be finite JSON');
  };
  return JSON.stringify(visit(value, 0));
}
