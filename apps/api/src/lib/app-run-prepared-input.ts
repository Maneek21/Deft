import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AppRunActorSchema,
  AppRunAuthorityRefSchema,
  AppRunAuthorizationSnapshotSchema,
  AppRunSafePreviewSchema,
  CapabilityJsonObjectSchema,
  ModuleResourceRefV1Schema,
  canonicalCapabilityJson,
  type AppRunActor,
  type AppRunAuthorizationSnapshot,
} from '@deft/shared';
import {
  AppRunSecretEnvelopeSchema,
  AppRunSecretSafeProjectionSchema,
  type AppRunSecretService,
} from './app-run-secrets.js';

export const APP_RUN_PREPARED_INPUT_VERSION = 'deft.app_run_prepared_input.v1' as const;
const PREPARED_INPUT_TTL_MS = 5 * 60 * 1_000;

const ExactIdentitySchema = z.string().min(1).max(512)
  .refine((value) => value === value.trim())
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

const BindingIdentitySchema = z.strictObject({
  app_installation_id: ExactIdentitySchema,
  app_version_id: ExactIdentitySchema,
  grant_snapshot_id: ExactIdentitySchema,
  binding_id: ExactIdentitySchema,
  binding_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export const APP_RUN_APP_AUTHORITY_KINDS = Object.freeze([
  'app_surface',
  'app_installation',
  'app_version',
  'app_grant',
  'app_binding',
  'app_dependency',
  'app_automation_request',
  'app_automation_definition',
  'app_automation_fire',
  'app_automation_policy',
  'resource',
  'relation',
] as const);

const AppRunInteractiveCallerSurfaceSchema = z.enum([
  'human:ui',
  'human:mcp',
  'defty',
  'agent_employee:runtime',
  'agent_employee:mcp',
]);
export const AppRunCallerSurfaceSchema = z.enum([
  ...AppRunInteractiveCallerSurfaceSchema.options,
  'automation',
]);

const AuthorityDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const PreparedResourceAuthorityV1Schema = z.strictObject({
  ref: ModuleResourceRefV1Schema,
  revision: z.number().int().positive(),
  active_manifest_digest: AuthorityDigestSchema,
  validated_manifest_digest: AuthorityDigestSchema,
  updated_at: z.string().datetime({ offset: true }),
});

export const PreparedAuthorityVectorV1Schema = z.strictObject({
  schema_version: z.literal('deft.app_action_authority.v1'),
  caller_surface: AppRunInteractiveCallerSurfaceSchema,
  installation: z.strictObject({
    id: ExactIdentitySchema,
    lifecycle_epoch: z.number().int().nonnegative(),
    grant_epoch: z.number().int().nonnegative(),
  }),
  app_version: z.strictObject({
    id: ExactIdentitySchema,
    manifest_digest: AuthorityDigestSchema,
    package_digest: AuthorityDigestSchema,
  }),
  grant: z.strictObject({
    id: ExactIdentitySchema,
    snapshot_digest: AuthorityDigestSchema,
  }),
  binding: z.strictObject({
    id: ExactIdentitySchema,
    action_key: ExactIdentitySchema,
    binding_digest: AuthorityDigestSchema,
    connector_authorization_version: z.number().int().positive(),
  }),
  dependencies: z.array(z.strictObject({
    dependency_key: ExactIdentitySchema,
    installation_id: ExactIdentitySchema,
    version_id: ExactIdentitySchema,
    lifecycle_epoch: z.number().int().nonnegative(),
    lock_digest: AuthorityDigestSchema,
  })).max(16),
  provider: z.strictObject({
    connection_id: ExactIdentitySchema,
    snapshot_id: ExactIdentitySchema,
    snapshot_digest: AuthorityDigestSchema,
    operation_name: ExactIdentitySchema,
    operation_schema_digest: AuthorityDigestSchema,
  }),
  run_authorization: AppRunAuthorizationSnapshotSchema,
  resources: z.array(PreparedResourceAuthorityV1Schema).min(1).max(32),
  relations: z.array(z.strictObject({
    source_ref: ModuleResourceRefV1Schema,
    relation_key: ExactIdentitySchema,
    revision: z.number().int().nonnegative(),
    selected_ref: ModuleResourceRefV1Schema,
  })).min(1).max(16),
});

export const PreparedAuthorityVectorV2Schema = z.strictObject({
  ...PreparedAuthorityVectorV1Schema.shape,
  schema_version: z.literal('deft.app_action_authority.v2'),
  caller_surface: z.literal('automation'),
  resources: z.array(PreparedResourceAuthorityV1Schema.extend({
    content_digest: AuthorityDigestSchema,
  })).min(1).max(32),
  automation: z.strictObject({
    request: z.strictObject({
      key: ExactIdentitySchema,
      digest: AuthorityDigestSchema,
    }),
    definition: z.strictObject({
      id: ExactIdentitySchema,
      epoch: z.number().int().positive(),
      digest: AuthorityDigestSchema,
      authorization_digest: AuthorityDigestSchema,
      approved_by_user_id: ExactIdentitySchema,
      approved_at: z.string().datetime({ offset: true }),
      valid_from: z.string().datetime({ offset: true }),
      valid_until: z.string().datetime({ offset: true }),
    }),
    fire: z.strictObject({
      id: ExactIdentitySchema,
      identity: AuthorityDigestSchema,
      logical_local_date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/),
      local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timezone: ExactIdentitySchema,
      resolved_at_utc: z.string().datetime({ offset: true }),
    }),
    policy: z.strictObject({
      key: ExactIdentitySchema,
      version: z.literal('1'),
      digest: AuthorityDigestSchema,
    }),
    budgets: z.strictObject({
      max_actions_per_fire: z.literal(1),
      max_org_runs_per_utc_day: z.number().int().min(1).max(100),
      max_pending_org_fires: z.number().int().min(1).max(25),
    }),
  }),
}).superRefine((value, ctx) => {
  if (Date.parse(value.automation.definition.valid_until) <= Date.parse(value.automation.definition.valid_from)) {
    ctx.addIssue({
      code: 'custom',
      path: ['automation', 'definition', 'valid_until'],
      message: 'Automation definition validity must be ordered',
    });
  }
});

export const PreparedAuthorityVectorSchema = z.discriminatedUnion('schema_version', [
  PreparedAuthorityVectorV1Schema,
  PreparedAuthorityVectorV2Schema,
]);

export type AppRunPreparedAuthorityVectorV1 = z.infer<typeof PreparedAuthorityVectorV1Schema>;
export type AppRunPreparedAuthorityVectorV2 = z.infer<typeof PreparedAuthorityVectorV2Schema>;
export type AppRunPreparedAuthorityVector = z.infer<typeof PreparedAuthorityVectorSchema>;

const APP_AUTHORITY_KIND_SET = new Set<string>(APP_RUN_APP_AUTHORITY_KINDS);

function normalizedGrantValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('App authority contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizedGrantValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const item = (value as Record<string, unknown>)[key];
        return item === undefined ? [] : [[key.normalize('NFC'), normalizedGrantValue(item)]];
      }));
  }
  throw new TypeError('App authority is not canonical JSON');
}

export function digestPreparedAppAuthority(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(normalizedGrantValue(value)), 'utf8')
    .digest('hex')}`;
}

export function appAuthorityVersion(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(`deft.app_run.app_authority.v1\0${domain}\0`)
    .update(canonicalCapabilityJson(value))
    .digest('hex')}`;
}

export function appResourceAuthorityId(ref: z.infer<typeof ModuleResourceRefV1Schema>): `sha256:${string}` {
  return appAuthorityVersion('resource_identity', ref);
}

export function appRelationAuthorityId(input: Readonly<{
  source_ref: z.infer<typeof ModuleResourceRefV1Schema>;
  relation_key: string;
  selected_ref: z.infer<typeof ModuleResourceRefV1Schema>;
}>): `sha256:${string}` {
  return appAuthorityVersion('relation_identity', {
    source_ref: input.source_ref,
    relation_key: input.relation_key,
    selected_ref: input.selected_ref,
  });
}

export function projectPreparedAppAuthorityRefs(
  rawVector: unknown,
): AppRunAuthorizationSnapshot['authority_refs'] {
  const vector = PreparedAuthorityVectorSchema.parse(rawVector);
  const refs: AppRunAuthorizationSnapshot['authority_refs'] = [
    {
      authority_kind: 'app_surface',
      authority_id: vector.caller_surface,
      version: appAuthorityVersion('surface', { caller_surface: vector.caller_surface }),
    },
    {
      authority_kind: 'app_installation',
      authority_id: vector.installation.id,
      version: appAuthorityVersion('installation', vector.installation),
    },
    {
      authority_kind: 'app_version',
      authority_id: vector.app_version.id,
      version: appAuthorityVersion('app_version', vector.app_version),
    },
    {
      authority_kind: 'app_grant',
      authority_id: vector.grant.id,
      version: vector.grant.snapshot_digest,
    },
    {
      authority_kind: 'app_binding',
      authority_id: vector.binding.id,
      version: appAuthorityVersion('binding', vector.binding),
    },
    ...vector.dependencies.map((dependency) => ({
      authority_kind: 'app_dependency' as const,
      authority_id: dependency.dependency_key,
      version: appAuthorityVersion('dependency', dependency),
    })),
    ...vector.resources.map((resource) => ({
      authority_kind: 'resource' as const,
      authority_id: appResourceAuthorityId(resource.ref),
      version: appAuthorityVersion('resource', resource),
    })),
    ...vector.relations.map((relation) => ({
      authority_kind: 'relation' as const,
      authority_id: appRelationAuthorityId(relation),
      version: appAuthorityVersion('relation', relation),
    })),
    ...(vector.schema_version === 'deft.app_action_authority.v2' ? [
      {
        authority_kind: 'app_automation_request' as const,
        authority_id: vector.automation.request.key,
        version: vector.automation.request.digest,
      },
      {
        authority_kind: 'app_automation_definition' as const,
        authority_id: vector.automation.definition.id,
        version: appAuthorityVersion('automation_definition', vector.automation.definition),
      },
      {
        authority_kind: 'app_automation_fire' as const,
        authority_id: vector.automation.fire.id,
        version: vector.automation.fire.identity,
      },
      {
        authority_kind: 'app_automation_policy' as const,
        authority_id: vector.automation.policy.key,
        version: vector.automation.policy.digest,
      },
    ] : []),
  ];
  return AppRunAuthorizationSnapshotSchema.parse({
    ...vector.run_authorization,
    authority_refs: refs,
  }).authority_refs;
}

const PreparedAppRunSchema = z.strictObject({
  initiating_actor: AppRunActorSchema,
  execution_actor: AppRunActorSchema,
  safe_preview: AppRunSafePreviewSchema,
  authority_vector: PreparedAuthorityVectorSchema,
  authority_digest: AuthorityDigestSchema,
  authority_refs: z.array(AppRunAuthorityRefSchema).min(7).max(32),
}).superRefine((value, ctx) => {
  if (
    value.authority_vector.run_authorization.authenticated_subject.actor_type
      !== value.initiating_actor.actor_type
    || actorId(value.authority_vector.run_authorization.authenticated_subject)
      !== actorId(value.initiating_actor)
  ) {
    ctx.addIssue({ code: 'custom', path: ['initiating_actor'], message: 'Prepared actor is not authenticated' });
  }
  if (value.authority_digest !== digestPreparedAppAuthority(value.authority_vector)) {
    ctx.addIssue({ code: 'custom', path: ['authority_digest'], message: 'Prepared authority digest is invalid' });
  }
  const projected = projectPreparedAppAuthorityRefs(value.authority_vector);
  if (canonicalCapabilityJson(projected) !== canonicalCapabilityJson(value.authority_refs)) {
    ctx.addIssue({ code: 'custom', path: ['authority_refs'], message: 'Prepared authority refs are invalid' });
  }
  if (value.authority_refs.some((ref) => !APP_AUTHORITY_KIND_SET.has(ref.authority_kind))) {
    ctx.addIssue({ code: 'custom', path: ['authority_refs'], message: 'Prepared authority refs contain ambient authority' });
  }
  if (value.authority_vector.schema_version === 'deft.app_action_authority.v2') {
    const automation = value.authority_vector.automation;
    if (
      value.initiating_actor.actor_type !== 'human'
      || value.initiating_actor.user_id !== automation.definition.approved_by_user_id
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['initiating_actor'],
        message: 'Prepared automation approver is invalid',
      });
    }
    if (
      value.execution_actor.actor_type !== 'automation'
      || value.execution_actor.automation_id !== automation.definition.id
      || value.execution_actor.user_id !== automation.definition.approved_by_user_id
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['execution_actor'],
        message: 'Prepared automation actor is invalid',
      });
    }
  }
});

function actorId(actor: AppRunActor): string {
  switch (actor.actor_type) {
    case 'human': return actor.user_id;
    case 'agent_employee': return actor.agent_employee_id;
    case 'system': return actor.system_id;
    case 'automation': return actor.automation_id;
  }
}

const PreparedPayloadSchema = z.strictObject({
  schema_version: z.literal(APP_RUN_PREPARED_INPUT_VERSION),
  expires_at: z.string().datetime({ offset: true }),
  replay_identity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  binding_identity: BindingIdentitySchema,
  provider_input: CapabilityJsonObjectSchema,
  app_run: PreparedAppRunSchema.optional(),
});

export type AppRunPreparedInputPayload = z.infer<typeof PreparedPayloadSchema>;

export const AppRunPreparedInputCandidateSchema = z.strictObject({
  schema_version: z.literal(APP_RUN_PREPARED_INPUT_VERSION),
  candidate_id: ExactIdentitySchema,
  expires_at: z.string().datetime({ offset: true }),
  sealed_payload: AppRunSecretEnvelopeSchema,
  safe_envelope: AppRunSecretSafeProjectionSchema,
}).superRefine((value, ctx) => {
  if (
    value.safe_envelope.schema_version !== value.sealed_payload.schema_version
    || value.safe_envelope.algorithm !== value.sealed_payload.algorithm
    || value.safe_envelope.key_version !== value.sealed_payload.key_version
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['safe_envelope'],
      message: 'Prepared input safe envelope must describe the sealed payload',
    });
  }
});
export type AppRunPreparedInputCandidate = z.infer<typeof AppRunPreparedInputCandidateSchema>;

/** App-Run-owned transient protection for a fully revalidated action input.
 * It creates no Run, approval, receipt, or provider effect. Loop 5 may open it
 * only after repeating live action authorization. */
export class AppRunPreparedInputService {
  constructor(
    private readonly secrets: AppRunSecretService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  protect(input: Readonly<{
    org_id: string;
    replay_identity: string;
    binding_identity: z.infer<typeof BindingIdentitySchema>;
    provider_input: unknown;
    app_run?: Readonly<{
      initiating_actor: AppRunActor;
      execution_actor: AppRunActor;
      safe_preview: unknown;
      authority_vector: unknown;
      authority_digest: string;
    }>;
  }>): AppRunPreparedInputCandidate {
    const candidateId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + PREPARED_INPUT_TTL_MS).toISOString();
    const authorityVector = input.app_run
      ? PreparedAuthorityVectorSchema.parse(input.app_run.authority_vector)
      : undefined;
    if (authorityVector && (
      authorityVector.installation.id !== input.binding_identity.app_installation_id
      || authorityVector.app_version.id !== input.binding_identity.app_version_id
      || authorityVector.grant.id !== input.binding_identity.grant_snapshot_id
      || authorityVector.binding.id !== input.binding_identity.binding_id
      || authorityVector.binding.binding_digest !== input.binding_identity.binding_digest
    )) throw new Error('APP_RUN_PREPARED_INPUT_INVALID');
    const payload = PreparedPayloadSchema.parse({
      schema_version: APP_RUN_PREPARED_INPUT_VERSION,
      expires_at: expiresAt,
      replay_identity: input.replay_identity,
      binding_identity: input.binding_identity,
      provider_input: input.provider_input,
      ...(input.app_run && authorityVector ? {
        app_run: {
          ...input.app_run,
          authority_vector: authorityVector,
          authority_refs: projectPreparedAppAuthorityRefs(authorityVector),
        },
      } : {}),
    });
    const sealed = this.secrets.sealJson(payload, {
      org_id: input.org_id,
      run_id: candidateId,
      payload_kind: 'input',
    });
    return Object.freeze({
      schema_version: APP_RUN_PREPARED_INPUT_VERSION,
      candidate_id: candidateId,
      expires_at: expiresAt,
      sealed_payload: sealed,
      safe_envelope: this.secrets.safeProjection(sealed),
    });
  }

  open(orgId: string, candidate: AppRunPreparedInputCandidate): AppRunPreparedInputPayload {
    const parsedCandidate = AppRunPreparedInputCandidateSchema.parse(candidate);
    if (
      Date.parse(parsedCandidate.expires_at) <= this.now().getTime()
    ) throw new Error('APP_RUN_PREPARED_INPUT_INVALID');
    const sealed = parsedCandidate.sealed_payload;
    const payload = PreparedPayloadSchema.parse(this.secrets.openJson(sealed, {
      org_id: orgId,
      run_id: parsedCandidate.candidate_id,
      payload_kind: 'input',
    }));
    if (
      payload.expires_at !== parsedCandidate.expires_at
      || Date.parse(payload.expires_at) <= this.now().getTime()
    ) throw new Error('APP_RUN_PREPARED_INPUT_INVALID');
    return payload;
  }
}
