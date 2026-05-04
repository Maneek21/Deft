// docs/superpowers/audits/agent-byoa/lib/assertions.ts
import { assert } from '../../lib/assert.js';
import { findRecentAgentActions } from './db-helpers.js';

export async function assertActionRowExists(opts: {
  agentEmployeeId: string;
  source: string;
  action: string;
  sinceMs?: number;
  paramsContains?: Record<string, unknown>;
}): Promise<{ id: string; params: any }> {
  const rows = await findRecentAgentActions({
    agentEmployeeId: opts.agentEmployeeId,
    source: opts.source,
    action: opts.action,
    sinceMs: opts.sinceMs ?? 30_000,
    status: 'pending',
  });
  assert(rows.length > 0, `expected at least one ${opts.source}/${opts.action} pending row in last ${opts.sinceMs ?? 30_000}ms`);
  if (opts.paramsContains) {
    const got = rows[0]!.params as Record<string, unknown>;
    for (const [k, v] of Object.entries(opts.paramsContains)) {
      assert(got?.[k] === v, `expected params.${k}=${JSON.stringify(v)}, got ${JSON.stringify(got?.[k])}`);
    }
  }
  return { id: rows[0]!.id, params: rows[0]!.params };
}

export function assertReplyShape(reply: unknown, opts: { mustContain?: string; minLength?: number }) {
  assert(typeof reply === 'string' && reply.length >= (opts.minLength ?? 1),
    `reply too short: got ${typeof reply === 'string' ? reply.length : 0}, want ≥${opts.minLength ?? 1}`);
  if (opts.mustContain) {
    assert((reply as string).toLowerCase().includes(opts.mustContain.toLowerCase()),
      `reply did not contain ${JSON.stringify(opts.mustContain)}`);
  }
}
