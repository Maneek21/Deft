import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { nativeCreateRequests } from '@deft/db/schema';
import { db } from './db.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export class NativeCreateError extends Error {
  constructor(message: string, public code: string, public status: 400 | 404 | 409) { super(message); }
}

export function nativeCreateKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = keySchema.safeParse(value);
  if (!parsed.success) throw new NativeCreateError('Invalid Idempotency-Key', 'VALIDATION_ERROR', 400);
  return parsed.data;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Call only after current authorization and validation. Identity and create commit together. */
export async function nativeCreate<T extends { id: string }>(options: {
  orgId: string; userId: string; operation: string; key?: string; payload: unknown;
  create: (tx: Transaction) => Promise<T>;
  replay: (tx: Transaction, id: string) => Promise<T | undefined>;
}): Promise<{ value: T; replayed: boolean }> {
  return db.transaction(async tx => {
    if (!options.key) return { value: await options.create(tx), replayed: false };
    const identity = digest([options.orgId, options.userId, options.operation, options.key]);
    const requestHash = digest(options.payload);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-create:${identity}`}, 0))`);
    const [prior] = await tx.select().from(nativeCreateRequests).where(eq(nativeCreateRequests.id, identity)).limit(1);
    if (prior) {
      if (prior.request_hash !== requestHash) throw new NativeCreateError('This create request was already used with different input', 'IDEMPOTENCY_CONFLICT', 409);
      const value = await options.replay(tx, prior.resource_id);
      if (!value) throw new NativeCreateError('The previously created resource is no longer available', 'NOT_FOUND', 404);
      return { value, replayed: true };
    }
    const value = await options.create(tx);
    await tx.insert(nativeCreateRequests).values({ id: identity, org_id: options.orgId, user_id: options.userId, operation: options.operation, request_hash: requestHash, resource_id: value.id });
    return { value, replayed: false };
  });
}
