import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MODULE_OPERATION_REQUEST_SCHEMAS, MODULE_OPERATION_RESULT_SCHEMAS } from '@deft/shared/modules';

const moduleReads = ['module_record_search', 'module_record_query', 'module_record_get'] as const;
const wikiPage = z.object({ title: z.string(), slug: z.string(), content: z.string(), version: z.number().int().positive() });
const wikiSearch = z.object({ pages: z.array(z.object({ title: z.string(), slug: z.string() })) });
const wikiKeys: Record<string, readonly string[]> = { wiki_search: ['query', 'type', 'scope', 'limit'], wiki_read: ['slug'] };

/** Hash the entire finite JSON input, or explicitly decline; never hash a truncated input. */
function inputHash(input: unknown): string | null {
  let nodes = 0;
  const seen = new Set<object>();
  function canonical(value: unknown, depth: number): unknown {
    if (++nodes > 1024 || depth > 8) throw new Error('bound');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length <= 16384) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('not finite JSON');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 256) throw new Error('bound');
        return value.map((item) => canonical(item, depth + 1));
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('not plain JSON');
      const result: Record<string, unknown> = Object.create(null);
      const keys = Object.keys(value).sort();
      if (keys.length > 128) throw new Error('bound');
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('accessor');
        result[key] = canonical(descriptor.value, depth + 1);
      }
      return result;
    } finally { seen.delete(value); }
  }
  try {
    const text = JSON.stringify(canonical(input, 0));
    if (Buffer.byteLength(text, 'utf8') > 16384) return null;
    return createHash('sha256').update(text).digest('hex');
  } catch { return null; }
}

export function projectAgentReadDiagnostics(actions: readonly { action?: unknown; params?: unknown; success?: unknown; result?: unknown; readOnly?: unknown }[]) {
  const reads = actions.filter((read) => read.readOnly === true && typeof read.action === 'string'
    && (Object.hasOwn(wikiKeys, read.action) || moduleReads.some((tool) => tool === read.action)));
  return {
    version: 1,
    omitted_count: Math.max(0, reads.length - 20),
    entries: reads.slice(0, 20).map((read) => {
      const tool = read.action as string;
      const moduleTool = moduleReads.find((name) => name === tool);
      const knownKeys = moduleTool ? Object.keys(MODULE_OPERATION_REQUEST_SCHEMAS[moduleTool].shape) : wikiKeys[tool]!;
      const inputKeys = read.params && typeof read.params === 'object' ? Object.keys(read.params) : [];
      let count: number | null = null;
      if (read.success === true) {
        if (moduleTool) {
          const parsed = MODULE_OPERATION_RESULT_SCHEMAS[moduleTool].safeParse(read.result);
          if (parsed.success) count = 'items' in parsed.data ? parsed.data.items.length : 1;
        } else if (tool === 'wiki_read') {
          if (wikiPage.safeParse(read.result).success) count = 1;
        } else {
          const parsed = wikiSearch.safeParse(read.result);
          if (parsed.success) count = parsed.data.pages.length;
        }
      }
      const hash = inputHash(read.params);
      return { tool, status: read.success === true ? 'success' : read.success === false ? 'failed' : 'unknown',
        result_count: count, input_sha256: hash, input_hash_status: hash ? 'complete' : 'unavailable',
        input_fields: knownKeys.filter((key) => inputKeys.includes(key)).sort() };
    }),
  };
}
