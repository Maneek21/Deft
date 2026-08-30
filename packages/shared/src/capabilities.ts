import { z } from 'zod';

export const CAPABILITY_CONTRACT_VERSIONS = {
  provider_snapshot: '1',
  mcp_adapter: 'mcp.v1',
} as const;

export const CAPABILITY_LIMITS = {
  description_chars: 4_000,
  operations_per_snapshot: 1_024,
  operation_schema_bytes: 256 * 1024,
  snapshot_bytes: 1024 * 1024,
} as const;

export type CapabilityJsonValue =
  | null
  | boolean
  | number
  | string
  | CapabilityJsonValue[]
  | { [key: string]: CapabilityJsonValue };

function capabilityJsonArrayElementKeys(value: unknown[]): string[] | null {
  const keys = Reflect.ownKeys(value);
  // Every ordinary array owns one non-enumerable `length` key plus exactly one
  // enumerable canonical index key for each element. This rejects holes,
  // symbols, and augmented/non-enumerable properties that JSON would discard.
  if (keys.length !== value.length + 1) return null;

  const elementKeys: string[] = [];
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key)) {
      return null;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      return null;
    }
    elementKeys.push(key);
  }
  return elementKeys.length === value.length ? elementKeys : null;
}

function isCapabilityJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is CapabilityJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  if (Array.isArray(value)) {
    const elementKeys = capabilityJsonArrayElementKeys(value);
    const valid = elementKeys !== null
      && elementKeys.every((key) => isCapabilityJsonValue(value[Number(key)], ancestors));
    ancestors.delete(value);
    return valid;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    return false;
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    ancestors.delete(value);
    return false;
  }
  const valid = Object.values(value).every((nested) => isCapabilityJsonValue(nested, ancestors));
  ancestors.delete(value);
  return valid;
}

export const CapabilityJsonValueSchema = z.custom<CapabilityJsonValue>(
  (value) => isCapabilityJsonValue(value),
  'Value must be finite JSON data',
);

export const CapabilityJsonObjectSchema = z.custom<Record<string, CapabilityJsonValue>>(
  (value) => (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && isCapabilityJsonValue(value)
  ),
  'Value must be a JSON object',
);

const NonEmptyExactStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'Identity must not have surrounding whitespace')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Identity must not contain control characters');

// Operation names and provider-facing keys are intentionally not trimmed or
// character-bounded here. Existing MCP providers own that namespace, and the
// Phase 2 seam must not reject a value that the legacy path can execute.
const ProviderOwnedNameSchema = z.string().min(1);

export const CapabilityProviderKindSchema = z.enum(['mcp']);
export type CapabilityProviderKind = z.infer<typeof CapabilityProviderKindSchema>;

export const CapabilityProviderIdentitySchema = z.object({
  org_id: NonEmptyExactStringSchema,
  provider_kind: CapabilityProviderKindSchema,
  provider_instance_id: NonEmptyExactStringSchema,
}).strict();
export type CapabilityProviderIdentity = z.infer<typeof CapabilityProviderIdentitySchema>;

export const CapabilityProviderOperationIdentitySchema = z.object({
  provider: CapabilityProviderIdentitySchema,
  operation_name: ProviderOwnedNameSchema,
}).strict();
export type CapabilityProviderOperationIdentity = z.infer<typeof CapabilityProviderOperationIdentitySchema>;

export const CapabilityDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'Capability digest must be sha256:<lowercase hex>');
export type CapabilityDigest = z.infer<typeof CapabilityDigestSchema>;

const ProviderOperationSnapshotInputSchema = z.object({
  identity: CapabilityProviderOperationIdentitySchema,
  description: z.string().max(CAPABILITY_LIMITS.description_chars),
  title: z.string().optional(),
  input_schema: CapabilityJsonObjectSchema,
  output_schema: CapabilityJsonObjectSchema.optional(),
}).strict();

export const CapabilityProviderOperationSnapshotSchema = ProviderOperationSnapshotInputSchema.extend({
  schema_digest: CapabilityDigestSchema,
  description_digest: CapabilityDigestSchema,
}).strict();
export type CapabilityProviderOperationSnapshot = z.infer<typeof CapabilityProviderOperationSnapshotSchema>;

const ProviderDiscoverySnapshotBaseSchema = z.object({
  schema_version: z.literal(CAPABILITY_CONTRACT_VERSIONS.provider_snapshot),
  adapter_contract_version: NonEmptyExactStringSchema,
  provider: CapabilityProviderIdentitySchema,
  captured_at: z.string().datetime({ offset: true }),
  operations: z
    .array(CapabilityProviderOperationSnapshotSchema)
    .max(CAPABILITY_LIMITS.operations_per_snapshot),
  snapshot_digest: CapabilityDigestSchema,
}).strict();

function validateSnapshotOperationSet(
  snapshot: Pick<z.infer<typeof ProviderDiscoverySnapshotBaseSchema>, 'provider' | 'operations'>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, operation] of snapshot.operations.entries()) {
    if (
      operation.identity.provider.org_id !== snapshot.provider.org_id
      || operation.identity.provider.provider_kind !== snapshot.provider.provider_kind
      || operation.identity.provider.provider_instance_id !== snapshot.provider.provider_instance_id
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations', index, 'identity', 'provider'],
        message: 'Operation provider must match the snapshot provider',
      });
    }
    const key = [
      operation.identity.provider.org_id,
      operation.identity.provider.provider_kind,
      operation.identity.provider.provider_instance_id,
      operation.identity.operation_name,
    ].join('\u0000');
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations', index, 'identity'],
        message: 'Provider operation tuple must be unique within a snapshot',
      });
    }
    seen.add(key);
  }
}

// This schema validates shape and provider/operation relationships. A parsed
// digest is evidence-shaped data, not proof of integrity; trusted snapshots are
// constructed in-process by createCapabilityProviderDiscoverySnapshot.
export const CapabilityProviderDiscoverySnapshotSchema = ProviderDiscoverySnapshotBaseSchema
  .superRefine(validateSnapshotOperationSet);
export type CapabilityProviderDiscoverySnapshot = z.infer<typeof CapabilityProviderDiscoverySnapshotSchema>;

export const CapabilityProviderDiscoverySnapshotInputSchema = z.object({
  adapter_contract_version: NonEmptyExactStringSchema,
  provider: CapabilityProviderIdentitySchema,
  captured_at: z.string().datetime({ offset: true }),
  operations: z
    .array(ProviderOperationSnapshotInputSchema)
    .max(CAPABILITY_LIMITS.operations_per_snapshot),
}).strict().superRefine((snapshot, ctx) => {
  validateSnapshotOperationSet({
    provider: snapshot.provider,
    operations: snapshot.operations.map((operation) => ({
      ...operation,
      schema_digest: `sha256:${'0'.repeat(64)}` as CapabilityDigest,
      description_digest: `sha256:${'0'.repeat(64)}` as CapabilityDigest,
    })),
  }, ctx);
});
export type CapabilityProviderDiscoverySnapshotInput = z.input<typeof CapabilityProviderDiscoverySnapshotInputSchema>;

export const CapabilityInvocationActorSchema = z.object({
  user_id: NonEmptyExactStringSchema,
  agent_employee_id: NonEmptyExactStringSchema.optional(),
}).strict();
export type CapabilityInvocationActor = z.infer<typeof CapabilityInvocationActorSchema>;

export const CapabilityInvocationRequestSchema = z.object({
  org_id: NonEmptyExactStringSchema,
  actor: CapabilityInvocationActorSchema,
  provider: z.discriminatedUnion('provider_kind', [
    z.object({
      provider_kind: z.literal('mcp'),
      connection_slug: ProviderOwnedNameSchema,
      operation_name: ProviderOwnedNameSchema,
    }).strict(),
  ]),
  input: CapabilityJsonObjectSchema,
}).strict();
export type CapabilityInvocationRequest = z.infer<typeof CapabilityInvocationRequestSchema>;

export const CapabilityInvocationErrorCodeSchema = z.enum([
  'CAPABILITY_PROVIDER_UNAVAILABLE',
  'CAPABILITY_OPERATION_UNAVAILABLE',
  'CAPABILITY_PROVIDER_ERROR',
]);
export type CapabilityInvocationErrorCode = z.infer<typeof CapabilityInvocationErrorCodeSchema>;

export const CapabilityInvocationProviderRefSchema = z.object({
  provider_kind: CapabilityProviderKindSchema,
  requested_provider_key: ProviderOwnedNameSchema,
  resolved_provider: CapabilityProviderIdentitySchema.optional(),
}).strict();
export type CapabilityInvocationProviderRef = z.infer<typeof CapabilityInvocationProviderRefSchema>;

export const CapabilityInvocationOutcomeSchema = z.object({
  provider: CapabilityInvocationProviderRefSchema,
  provider_display_name: z.string().min(1).optional(),
  operation_name: ProviderOwnedNameSchema,
  success: z.boolean(),
  output: CapabilityJsonValueSchema,
  error: z.string().min(1).optional(),
  error_code: CapabilityInvocationErrorCodeSchema.optional(),
  duration_ms: z.number().int().nonnegative(),
}).strict().superRefine((outcome, ctx) => {
  if (outcome.success && (outcome.error !== undefined || outcome.error_code !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['error'], message: 'Successful outcomes cannot include an error' });
  }
  if (!outcome.success && (outcome.error === undefined || outcome.error_code === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['error'], message: 'Failed outcomes require an error and error code' });
  }
  if (outcome.success && (outcome.provider.resolved_provider === undefined || outcome.provider_display_name === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['provider'],
      message: 'Successful outcomes require resolved provider identity and display name',
    });
  }
});
export type CapabilityInvocationOutcome = z.infer<typeof CapabilityInvocationOutcomeSchema>;

function canonicalizeCapabilityJsonInner(value: CapabilityJsonValue): CapabilityJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(canonicalizeCapabilityJsonInner);

  const output = Object.create(null) as Record<string, CapabilityJsonValue>;
  const keys = Object.keys(value)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const key of keys) {
    output[key] = canonicalizeCapabilityJsonInner(value[key]!);
  }
  return output;
}

function capabilityJsonStringBytes(value: string): number {
  let bytes = new TextEncoder().encode(value).byteLength + 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 1;
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 1;
    } else if (code <= 0x1f) {
      bytes += 5;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
      else bytes += 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 3;
    }
  }
  return bytes;
}

/** Reject expensive provider JSON before cloning or hashing it. The byte count
 * matches JSON string escaping while depth/node limits bound structural work. */
export function assertCapabilityJsonWithinBudget(
  value: unknown,
  maxBytes: number,
  maxDepth = 64,
  maxNodes = 100_000,
): void {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const addBytes = (count: number): void => {
    bytes += count;
    if (bytes > maxBytes) throw new TypeError(`Capability JSON exceeds ${maxBytes} bytes`);
  };

  const visit = (nested: unknown, depth: number): void => {
    nodes++;
    if (nodes > maxNodes) throw new TypeError(`Capability JSON exceeds ${maxNodes} nodes`);
    if (depth > maxDepth) throw new TypeError(`Capability JSON exceeds depth ${maxDepth}`);
    if (nested === null) {
      addBytes(4);
      return;
    }
    if (typeof nested === 'boolean') {
      addBytes(nested ? 4 : 5);
      return;
    }
    if (typeof nested === 'number') {
      if (!Number.isFinite(nested)) throw new TypeError('Capability JSON contains a non-finite number');
      addBytes(Object.is(nested, -0) ? 1 : String(nested).length);
      return;
    }
    if (typeof nested === 'string') {
      addBytes(capabilityJsonStringBytes(nested));
      return;
    }
    if (typeof nested !== 'object') throw new TypeError('Capability JSON contains a non-JSON value');
    if (ancestors.has(nested)) throw new TypeError('Capability JSON contains a cycle');
    ancestors.add(nested);

    if (Array.isArray(nested)) {
      const elementKeys = capabilityJsonArrayElementKeys(nested);
      if (elementKeys === null) throw new TypeError('Capability JSON contains a non-JSON array');
      addBytes(2 + Math.max(0, nested.length - 1));
      for (const key of elementKeys) visit(nested[Number(key)], depth + 1);
      ancestors.delete(nested);
      return;
    }

    const prototype = Object.getPrototypeOf(nested);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Capability JSON contains a non-plain object');
    }
    const keys = Reflect.ownKeys(nested);
    if (keys.some((key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(nested, key))) {
      throw new TypeError('Capability JSON contains a symbol or non-enumerable property');
    }
    addBytes(2 + Math.max(0, keys.length - 1));
    for (const key of keys as string[]) {
      addBytes(capabilityJsonStringBytes(key) + 1);
      visit((nested as Record<string, unknown>)[key], depth + 1);
    }
    ancestors.delete(nested);
  };

  visit(value, 0);
}

export function canonicalizeCapabilityJson(value: unknown): CapabilityJsonValue {
  return canonicalizeCapabilityJsonInner(CapabilityJsonValueSchema.parse(value));
}

export function canonicalCapabilityJson(value: unknown): string {
  return JSON.stringify(canonicalizeCapabilityJson(value));
}

async function digestCapabilityValue(domain: string, value: unknown): Promise<CapabilityDigest> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable in this runtime');
  }
  const bytes = new TextEncoder().encode(`${domain}\u0000${canonicalCapabilityJson(value)}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return CapabilityDigestSchema.parse(`sha256:${hex}`);
}

function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalCapabilityJson(value)).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export async function createCapabilityProviderDiscoverySnapshot(
  value: unknown,
): Promise<Readonly<CapabilityProviderDiscoverySnapshot>> {
  assertCapabilityJsonWithinBudget(value, CAPABILITY_LIMITS.snapshot_bytes);
  // Clone all JSON-shaped input synchronously before the first digest await.
  // This prevents provider/caller mutation races and ensures deepFreeze only
  // ever touches data owned by the returned snapshot.
  const ownedValue = canonicalizeCapabilityJson(value);
  const input = CapabilityProviderDiscoverySnapshotInputSchema.parse(ownedValue);
  const operations: CapabilityProviderOperationSnapshot[] = [];

  for (const operation of input.operations) {
    const executableSchema = {
      input_schema: operation.input_schema,
      ...(operation.output_schema !== undefined ? { output_schema: operation.output_schema } : {}),
    };
    if (canonicalByteLength(executableSchema) > CAPABILITY_LIMITS.operation_schema_bytes) {
      throw new TypeError(`Capability operation schema exceeds ${CAPABILITY_LIMITS.operation_schema_bytes} bytes`);
    }
    operations.push({
      ...operation,
      schema_digest: await digestCapabilityValue('deft.capability.operation-schema.v1', executableSchema),
      description_digest: await digestCapabilityValue('deft.capability.operation-description.v1', {
        description: operation.description,
        ...(operation.title !== undefined ? { title: operation.title } : {}),
      }),
    });
  }

  const safeProjection = {
    schema_version: CAPABILITY_CONTRACT_VERSIONS.provider_snapshot,
    adapter_contract_version: input.adapter_contract_version,
    provider: input.provider,
    operations,
  };
  if (canonicalByteLength(safeProjection) > CAPABILITY_LIMITS.snapshot_bytes) {
    throw new TypeError(`Capability provider snapshot exceeds ${CAPABILITY_LIMITS.snapshot_bytes} bytes`);
  }

  const snapshot = CapabilityProviderDiscoverySnapshotSchema.parse({
    ...safeProjection,
    captured_at: input.captured_at,
    snapshot_digest: await digestCapabilityValue('deft.capability.provider-snapshot.v1', safeProjection),
  });
  return deepFreeze(snapshot);
}
