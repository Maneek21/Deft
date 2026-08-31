import { z } from 'zod';

export const DEFT_APP_MANIFEST_FILENAME = 'deft.app.json';
export const DEFT_APP_MANIFEST_SCHEMA_VERSION = '0' as const;
export const DEFT_APP_PROTOCOL_VERSION = '0' as const;
export const DEFT_APP_PACKAGE_FORMAT = 'deft.app.package.v0' as const;
export const DEFT_APP_MANIFEST_SCHEMA_VERSION_V1 = '1' as const;
export const DEFT_APP_PROTOCOL_VERSION_V1 = '1' as const;
export const DEFT_APP_PACKAGE_FORMAT_V1 = 'deft.app.package.v1' as const;
export const DEFT_MODULE_ARTIFACT_MEDIA_TYPE = 'application/vnd.deft.module+json' as const;

export const APP_LIMITS = Object.freeze({
  manifest_bytes: 128 * 1024,
  package_bytes: 1024 * 1024,
  artifacts_per_app: 16,
  artifact_bytes: 128 * 1024,
  artifact_path_chars: 240,
  app_id_chars: 128,
  display_name_chars: 80,
  description_chars: 500,
  navigation_items: 32,
  dependencies: 16,
  resource_requirements: 16,
  resource_fields_per_requirement: 32,
  capability_requirements: 8,
  connector_requirements: 8,
  actions: 16,
} as const);

const APP_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff<>]/u;
const ARTIFACT_PATH_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const SPDX_EXPRESSION_PATTERN = /^[A-Za-z0-9.+()-]+(?: [A-Za-z0-9.+()-]+)*$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();

function boundedPlainText(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((value) => !UNSAFE_TEXT.test(value), `${label} must be safe single-line plain text`);
}

export const AppIdSchema = z
  .string()
  .min(3)
  .max(APP_LIMITS.app_id_chars)
  .regex(APP_ID_PATTERN, 'App id must be a lowercase reverse-DNS identifier');

export const AppSemverSchema = z
  .string()
  .max(64)
  .regex(SEMVER_PATTERN, 'Version must be strict semantic versioning');

export const AppDigestSchema = z
  .string()
  .regex(SHA256_PATTERN, 'Digest must be sha256:<lowercase hex>');

export const AppArtifactPathSchema = z
  .string()
  .min(1)
  .max(APP_LIMITS.artifact_path_chars)
  .regex(ARTIFACT_PATH_PATTERN, 'Artifact path must use lowercase portable ASCII characters')
  .superRefine((path, ctx) => {
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      ctx.addIssue({ code: 'custom', message: 'Artifact path contains an unsafe segment' });
    }
    if (path.startsWith('/') || path.includes('\\') || /^[a-z]:/i.test(path)) {
      ctx.addIssue({ code: 'custom', message: 'Artifact path must be relative and portable' });
    }
    const reserved = new Set(['.git', 'node_modules']);
    if (
      segments.some((segment) => reserved.has(segment)) ||
      path === DEFT_APP_MANIFEST_FILENAME ||
      path === 'package.json'
    ) {
      ctx.addIssue({ code: 'custom', message: 'Artifact path is reserved' });
    }
  });

export const DeftAppModuleReferenceV0Schema = z.strictObject({
  module_id: AppIdSchema,
  version: AppSemverSchema,
  manifest_path: AppArtifactPathSchema,
  manifest_digest: AppDigestSchema,
});

export const DeftAppNavigationItemV0Schema = z.strictObject({
  key: z.string().min(1).max(48).regex(KEY_PATTERN, 'Navigation key must be lowercase snake_case'),
  label: boundedPlainText(APP_LIMITS.display_name_chars, 'Navigation label'),
  module_id: AppIdSchema,
  collection_key: z
    .string()
    .min(1)
    .max(48)
    .regex(KEY_PATTERN, 'Collection key must be lowercase snake_case'),
  view_key: z.string().min(1).max(48).regex(KEY_PATTERN, 'View key must be lowercase snake_case').optional(),
});

export const DeftAppManifestV0Schema = z
  .strictObject({
    schema_version: z.literal(DEFT_APP_MANIFEST_SCHEMA_VERSION),
    id: AppIdSchema,
    version: AppSemverSchema,
    name: boundedPlainText(APP_LIMITS.display_name_chars, 'App name'),
    description: boundedPlainText(APP_LIMITS.description_chars, 'App description').optional(),
    license: z
      .string()
      .min(1)
      .max(128)
      .regex(SPDX_EXPRESSION_PATTERN, 'License must be a bounded SPDX-style expression'),
    compatibility: z.strictObject({
      app_protocol: z.literal(DEFT_APP_PROTOCOL_VERSION),
    }),
    provenance: z
      .strictObject({
        source_repository: z.url().refine((value) => /^https?:\/\//.test(value), 'Repository must use HTTP(S)'),
        source_commit: z.string().regex(/^[a-f0-9]{7,64}$/, 'Commit must be lowercase hexadecimal'),
      })
      .optional(),
    modules: z.array(DeftAppModuleReferenceV0Schema).min(1).max(APP_LIMITS.artifacts_per_app),
    navigation: z
      .array(DeftAppNavigationItemV0Schema)
      .max(APP_LIMITS.navigation_items)
      .default([]),
  })
  .superRefine((manifest, ctx) => {
    const identities = new Set<string>();
    const moduleIds = new Set<string>();
    const paths = new Set<string>();
    for (const [index, module] of manifest.modules.entries()) {
      const identity = `${module.module_id}@${module.version}`;
      if (identities.has(identity)) {
        ctx.addIssue({ code: 'custom', path: ['modules', index], message: `Duplicate module identity ${identity}` });
      }
      if (moduleIds.has(module.module_id)) {
        ctx.addIssue({ code: 'custom', path: ['modules', index, 'module_id'], message: `Module id appears more than once: ${module.module_id}` });
      }
      if (paths.has(module.manifest_path)) {
        ctx.addIssue({ code: 'custom', path: ['modules', index, 'manifest_path'], message: 'Duplicate artifact path' });
      }
      identities.add(identity);
      moduleIds.add(module.module_id);
      paths.add(module.manifest_path);
    }
    const navigationKeys = new Set<string>();
    for (const [index, item] of manifest.navigation.entries()) {
      if (!moduleIds.has(item.module_id)) {
        ctx.addIssue({ code: 'custom', path: ['navigation', index, 'module_id'], message: 'Navigation references an undeclared module' });
      }
      if (navigationKeys.has(item.key)) {
        ctx.addIssue({ code: 'custom', path: ['navigation', index, 'key'], message: 'Navigation key must be unique' });
      }
      navigationKeys.add(item.key);
    }
  });

export const AppMachineKeyV1Schema = z
  .string()
  .min(1)
  .max(48)
  .regex(KEY_PATTERN, 'App key must be lowercase snake_case');

// Only identifiers that enter host authority/binding namespaces reserve these
// prefixes. App-scoped resource and Module field keys remain ordinary machine
// keys so names such as `system_prompt` stay compatible.
export const AppAuthorityKeyV1Schema = AppMachineKeyV1Schema
  .refine(
    (value) => !/^(deft|core|system)(_|$)/.test(value),
    'App authority key uses a reserved host namespace',
  );

export const AppPrivateInterfaceIdentityInputSchema = z.strictObject({
  organization_id: z.uuid().transform((value) => value.toLowerCase()),
  app_lineage_id: z.uuid().transform((value) => value.toLowerCase()),
  interface_key: AppAuthorityKeyV1Schema,
  interface_version: z.string().regex(/^[1-9]\d*$/, 'Private interface version must be a positive integer'),
});

export type AppPrivateInterfaceIdentityInput = z.infer<typeof AppPrivateInterfaceIdentityInputSchema>;
export type AppPrivateInterfaceIdentity =
  `deft.private.v1:${string}:${string}:${string}:v${string}`;

/**
 * Builds the host-owned identity for an App-private capability. Callers must
 * supply persisted organization and immutable App-lineage ids; package-authored
 * App ids, repository metadata, and publisher labels are intentionally absent.
 */
export function canonicalAppPrivateInterfaceIdentity(
  value: AppPrivateInterfaceIdentityInput,
): AppPrivateInterfaceIdentity {
  const input = AppPrivateInterfaceIdentityInputSchema.parse(value);
  return `deft.private.v1:${input.organization_id}:${input.app_lineage_id}:${input.interface_key}:v${input.interface_version}`;
}

const EMAIL_SUBJECT_PATTERN =
  '^[^\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060\\u2066-\\u2069\\ufeff]+$';
const EMAIL_BODY_TEXT_PATTERN =
  '^[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060\\u2066-\\u2069\\ufeff]+$';
const SANDBOX_MESSAGE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$';

export const SandboxEmailSendInputSchema = z.strictObject({
  to: z.email().max(320),
  subject: z.string().min(1).max(998).regex(new RegExp(EMAIL_SUBJECT_PATTERN, 'u')),
  body_text: z.string().min(1).max(100_000).regex(new RegExp(EMAIL_BODY_TEXT_PATTERN, 'u')),
  idempotency_key: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
});

export const SandboxEmailSendOutputSchema = z.strictObject({
  message_id: z.string().min(1).max(256).regex(new RegExp(SANDBOX_MESSAGE_ID_PATTERN)),
  status: z.literal('accepted'),
});

export type SandboxEmailSendInput = z.infer<typeof SandboxEmailSendInputSchema>;
export type SandboxEmailSendOutput = z.infer<typeof SandboxEmailSendOutputSchema>;

export const SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT = Object.freeze({
  key: 'sandbox_email_send',
  version: '1',
  input_schema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['to', 'subject', 'body_text', 'idempotency_key']),
    properties: Object.freeze({
      to: Object.freeze({ type: 'string', format: 'email', maxLength: 320 }),
      subject: Object.freeze({ type: 'string', minLength: 1, maxLength: 998, pattern: EMAIL_SUBJECT_PATTERN }),
      body_text: Object.freeze({ type: 'string', minLength: 1, maxLength: 100_000, pattern: EMAIL_BODY_TEXT_PATTERN }),
      idempotency_key: Object.freeze({
        type: 'string',
        minLength: 1,
        maxLength: 256,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
      }),
    }),
  }),
  output_schema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['message_id', 'status']),
    properties: Object.freeze({
      message_id: Object.freeze({ type: 'string', minLength: 1, maxLength: 256, pattern: SANDBOX_MESSAGE_ID_PATTERN }),
      status: Object.freeze({ const: 'accepted' }),
    }),
  }),
  host_policy: Object.freeze({
    risk_class: 'external_write',
    review_requirement: 'always',
    review_scope: 'per_invocation',
    egress_class: 'email',
    retry_class: 'idempotent_with_key',
    retention_class: 'standard',
    automation_eligibility: 'forbidden',
    provider_idempotency_key_required: true,
  }),
} as const);

/**
 * Host-owned descriptor for the first private App interface. This is inert
 * support metadata: Apps may select a registered key/version, but cannot add
 * provider operations, policy, executable validators, or loading behavior.
 */
export const SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE = Object.freeze({
  key: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.key,
  version: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.version,
  provider_kind: 'mcp',
  operation_name: 'send_email',
  input_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
  output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
  host_policy: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy,
  action_binding: Object.freeze({
    inputs: Object.freeze([
      Object.freeze({
        input_key: 'to',
        source_kind: 'selected_relation_field',
        source_resource_requirement: 'placement',
        selection: 'one',
        allowed_field_types: Object.freeze(['email'] as const),
      }),
      Object.freeze({
        input_key: 'subject',
        source_kind: 'resource_field',
        resource_requirement: 'placement',
        allowed_field_types: Object.freeze(['text'] as const),
      }),
      Object.freeze({
        input_key: 'body_text',
        source_kind: 'resource_field',
        resource_requirement: 'placement',
        allowed_field_types: Object.freeze(['text', 'long_text'] as const),
      }),
    ]),
    distinct_resource_field_inputs: Object.freeze([
      Object.freeze(['subject', 'body_text'] as const),
    ]),
  }),
} as const);

export const DeftAppDependencyRequirementV1Schema = z.strictObject({
  key: AppAuthorityKeyV1Schema,
  app_id: AppIdSchema,
  version: AppSemverSchema,
});

export const DeftAppResourceRequirementV1Schema = z.strictObject({
  key: AppMachineKeyV1Schema,
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('included_module'),
      module_id: AppIdSchema,
      version: AppSemverSchema,
    }),
    z.strictObject({
      kind: z.literal('dependency_module'),
      dependency_key: AppAuthorityKeyV1Schema,
      module_id: AppIdSchema,
      version: AppSemverSchema,
    }),
  ]),
  resource_type: AppMachineKeyV1Schema,
  fields: z.array(AppMachineKeyV1Schema).min(1).max(APP_LIMITS.resource_fields_per_requirement),
});

export const DeftAppCapabilityRequirementV1Schema = z.strictObject({
  key: AppAuthorityKeyV1Schema,
  interface: z.strictObject({
    kind: z.literal('private'),
    namespace: z.literal('app_lineage'),
    key: z.literal(SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE.key),
    version: z.literal(SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE.version),
  }),
});

export const DeftAppConnectorRequirementV1Schema = z.strictObject({
  key: AppAuthorityKeyV1Schema,
  provider_kind: z.literal('mcp'),
});

export const DeftAppActionInputSourceV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resource_field'),
    resource_requirement_key: AppMachineKeyV1Schema,
    field_key: AppMachineKeyV1Schema,
  }),
  z.strictObject({
    kind: z.literal('selected_relation_field'),
    source_resource_requirement_key: AppMachineKeyV1Schema,
    relation_field_key: AppMachineKeyV1Schema,
    target_resource_requirement_key: AppMachineKeyV1Schema,
    target_field_key: AppMachineKeyV1Schema,
    selection: z.literal('one'),
  }),
  z.strictObject({
    kind: z.literal('user_input'),
    input_type: z.enum(['email', 'text']),
    label: boundedPlainText(APP_LIMITS.display_name_chars, 'Action input label'),
    required: z.literal(true),
  }),
]);

export const DeftAppActionBindingV1Schema = z.strictObject({
  key: AppAuthorityKeyV1Schema,
  label: boundedPlainText(APP_LIMITS.display_name_chars, 'Action label'),
  capability_requirement_key: AppAuthorityKeyV1Schema,
  connector_requirement_key: AppAuthorityKeyV1Schema,
  placement: z.strictObject({
    kind: z.literal('resource_detail'),
    resource_requirement_key: AppMachineKeyV1Schema,
  }),
  input_bindings: z.array(z.strictObject({
    input_key: z.enum(['to', 'subject', 'body_text']),
    source: DeftAppActionInputSourceV1Schema,
  })).length(3),
});

function addDuplicateIssue(
  ctx: z.RefinementCtx,
  seen: Set<string>,
  value: string,
  path: PropertyKey[],
  label: string,
): void {
  if (seen.has(value)) ctx.addIssue({ code: 'custom', path, message: `${label} must be unique` });
  seen.add(value);
}

export const DeftAppManifestV1Schema = z
  .strictObject({
    schema_version: z.literal(DEFT_APP_MANIFEST_SCHEMA_VERSION_V1),
    id: AppIdSchema,
    version: AppSemverSchema,
    name: boundedPlainText(APP_LIMITS.display_name_chars, 'App name'),
    description: boundedPlainText(APP_LIMITS.description_chars, 'App description').optional(),
    license: z
      .string()
      .min(1)
      .max(128)
      .regex(SPDX_EXPRESSION_PATTERN, 'License must be a bounded SPDX-style expression'),
    compatibility: z.strictObject({
      app_protocol: z.literal(DEFT_APP_PROTOCOL_VERSION_V1),
    }),
    provenance: z
      .strictObject({
        source_repository: z.url().refine((value) => /^https?:\/\//.test(value), 'Repository must use HTTP(S)'),
        source_commit: z.string().regex(/^[a-f0-9]{7,64}$/, 'Commit must be lowercase hexadecimal'),
      })
      .optional(),
    modules: z.array(DeftAppModuleReferenceV0Schema).min(1).max(APP_LIMITS.artifacts_per_app),
    navigation: z.array(DeftAppNavigationItemV0Schema).max(APP_LIMITS.navigation_items).default([]),
    dependencies: z.array(DeftAppDependencyRequirementV1Schema).min(1).max(APP_LIMITS.dependencies),
    resource_requirements: z
      .array(DeftAppResourceRequirementV1Schema)
      .min(1)
      .max(APP_LIMITS.resource_requirements),
    capability_requirements: z
      .array(DeftAppCapabilityRequirementV1Schema)
      .min(1)
      .max(APP_LIMITS.capability_requirements),
    connector_requirements: z
      .array(DeftAppConnectorRequirementV1Schema)
      .min(1)
      .max(APP_LIMITS.connector_requirements),
    actions: z.array(DeftAppActionBindingV1Schema).min(1).max(APP_LIMITS.actions),
  })
  .superRefine((manifest, ctx) => {
    const moduleIdentities = new Set<string>();
    const moduleIds = new Set<string>();
    const modulePaths = new Set<string>();
    const moduleById = new Map(manifest.modules.map((item) => [item.module_id, item]));
    for (const [index, module] of manifest.modules.entries()) {
      addDuplicateIssue(ctx, moduleIdentities, `${module.module_id}@${module.version}`, ['modules', index], 'Module identity');
      addDuplicateIssue(ctx, moduleIds, module.module_id, ['modules', index, 'module_id'], 'Module id');
      addDuplicateIssue(ctx, modulePaths, module.manifest_path, ['modules', index, 'manifest_path'], 'Artifact path');
    }

    const navigationKeys = new Set<string>();
    for (const [index, item] of manifest.navigation.entries()) {
      if (!moduleIds.has(item.module_id)) {
        ctx.addIssue({ code: 'custom', path: ['navigation', index, 'module_id'], message: 'Navigation references an undeclared module' });
      }
      addDuplicateIssue(ctx, navigationKeys, item.key, ['navigation', index, 'key'], 'Navigation key');
    }

    const dependencyKeys = new Set<string>();
    const dependencyAppIds = new Set<string>();
    for (const [index, dependency] of manifest.dependencies.entries()) {
      addDuplicateIssue(ctx, dependencyKeys, dependency.key, ['dependencies', index, 'key'], 'Dependency key');
      addDuplicateIssue(ctx, dependencyAppIds, dependency.app_id, ['dependencies', index, 'app_id'], 'Dependency App id');
      if (dependency.app_id === manifest.id) {
        ctx.addIssue({ code: 'custom', path: ['dependencies', index, 'app_id'], message: 'An App cannot depend on itself' });
      }
    }

    const resourceKeys = new Set<string>();
    const resourceByKey = new Map<string, z.infer<typeof DeftAppResourceRequirementV1Schema>>();
    for (const [index, resource] of manifest.resource_requirements.entries()) {
      addDuplicateIssue(ctx, resourceKeys, resource.key, ['resource_requirements', index, 'key'], 'Resource requirement key');
      resourceByKey.set(resource.key, resource);
      const fields = new Set<string>();
      for (const [fieldIndex, field] of resource.fields.entries()) {
        addDuplicateIssue(ctx, fields, field, ['resource_requirements', index, 'fields', fieldIndex], 'Resource field');
      }
      if (resource.source.kind === 'included_module') {
        const included = moduleById.get(resource.source.module_id);
        if (!included || included.version !== resource.source.version) {
          ctx.addIssue({
            code: 'custom',
            path: ['resource_requirements', index, 'source'],
            message: 'Included resource source must reference one exact included Module version',
          });
        }
      } else if (!dependencyKeys.has(resource.source.dependency_key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resource_requirements', index, 'source', 'dependency_key'],
          message: 'Dependency resource source references an undeclared dependency',
        });
      }
    }

    const capabilityKeys = new Set<string>();
    for (const [index, capability] of manifest.capability_requirements.entries()) {
      addDuplicateIssue(ctx, capabilityKeys, capability.key, ['capability_requirements', index, 'key'], 'Capability requirement key');
    }
    const connectorKeys = new Set<string>();
    for (const [index, connector] of manifest.connector_requirements.entries()) {
      addDuplicateIssue(ctx, connectorKeys, connector.key, ['connector_requirements', index, 'key'], 'Connector requirement key');
    }

    const actionKeys = new Set<string>();
    for (const [index, action] of manifest.actions.entries()) {
      addDuplicateIssue(ctx, actionKeys, action.key, ['actions', index, 'key'], 'Action key');
      if (!capabilityKeys.has(action.capability_requirement_key)) {
        ctx.addIssue({ code: 'custom', path: ['actions', index, 'capability_requirement_key'], message: 'Action references an undeclared capability requirement' });
      }
      if (!connectorKeys.has(action.connector_requirement_key)) {
        ctx.addIssue({ code: 'custom', path: ['actions', index, 'connector_requirement_key'], message: 'Action references an undeclared connector requirement' });
      }
      if (!resourceKeys.has(action.placement.resource_requirement_key)) {
        ctx.addIssue({ code: 'custom', path: ['actions', index, 'placement', 'resource_requirement_key'], message: 'Action placement references an undeclared resource requirement' });
      }

      const inputKeys = new Set<string>();
      for (const [bindingIndex, binding] of action.input_bindings.entries()) {
        addDuplicateIssue(ctx, inputKeys, binding.input_key, ['actions', index, 'input_bindings', bindingIndex, 'input_key'], 'Action input key');
        const source = binding.source;
        if (source.kind === 'resource_field') {
          const resource = resourceByKey.get(source.resource_requirement_key);
          if (source.resource_requirement_key !== action.placement.resource_requirement_key) {
            ctx.addIssue({ code: 'custom', path: ['actions', index, 'input_bindings', bindingIndex, 'source', 'resource_requirement_key'], message: 'Resource input must use the action placement resource' });
          }
          if (!resource || !resource.fields.includes(source.field_key)) {
            ctx.addIssue({ code: 'custom', path: ['actions', index, 'input_bindings', bindingIndex, 'source'], message: 'Resource input must use a declared resource field' });
          }
        } else if (source.kind === 'selected_relation_field') {
          const sourceResource = resourceByKey.get(source.source_resource_requirement_key);
          const targetResource = resourceByKey.get(source.target_resource_requirement_key);
          if (source.source_resource_requirement_key !== action.placement.resource_requirement_key) {
            ctx.addIssue({ code: 'custom', path: ['actions', index, 'input_bindings', bindingIndex, 'source', 'source_resource_requirement_key'], message: 'Selected relation must start from the action placement resource' });
          }
          if (!sourceResource?.fields.includes(source.relation_field_key)) {
            ctx.addIssue({ code: 'custom', path: ['actions', index, 'input_bindings', bindingIndex, 'source', 'relation_field_key'], message: 'Selected relation must use a declared source field' });
          }
          if (!targetResource?.fields.includes(source.target_field_key)) {
            ctx.addIssue({ code: 'custom', path: ['actions', index, 'input_bindings', bindingIndex, 'source', 'target_field_key'], message: 'Selected relation must use a declared target field' });
          }
        } else {
          const expectedType = binding.input_key === 'to' ? 'email' : 'text';
          if (source.input_type !== expectedType) {
            ctx.addIssue({ code: 'custom', path: ['actions', index, 'input_bindings', bindingIndex, 'source', 'input_type'], message: `${binding.input_key} user input must use ${expectedType}` });
          }
        }
      }
      for (const requiredInput of ['to', 'subject', 'body_text']) {
        if (!inputKeys.has(requiredInput)) {
          ctx.addIssue({ code: 'custom', path: ['actions', index, 'input_bindings'], message: `Action must bind ${requiredInput}` });
        }
      }
    }
  });

export const DEFT_APP_PROTOCOL_OPERATIONS = Object.freeze([
  'authoring',
  'inspect',
  'stage',
  'review',
  'route',
  'activate',
  'invoke',
] as const);

export type DeftAppProtocolOperation = typeof DEFT_APP_PROTOCOL_OPERATIONS[number];
type DeftAppProtocolHandlerMatrix = Readonly<Record<DeftAppProtocolOperation, string | null>>;

function handlerMatrix(
  handlers: Partial<Record<DeftAppProtocolOperation, string>>,
): DeftAppProtocolHandlerMatrix {
  return Object.freeze(Object.fromEntries(
    DEFT_APP_PROTOCOL_OPERATIONS.map((operation) => [operation, handlers[operation] ?? null]),
  ) as Record<DeftAppProtocolOperation, string | null>);
}

function protocolAtoms(
  names: readonly string[],
  handlers: DeftAppProtocolHandlerMatrix,
): Readonly<Record<string, DeftAppProtocolHandlerMatrix>> {
  return Object.freeze(Object.fromEntries(names.map((name) => [name, handlers])));
}

const V0_HANDLER_MATRIX = handlerMatrix({
  authoring: 'app-kit:v0',
  inspect: 'app-service:inspect-v0',
  stage: 'app-service:stage-v0',
  route: 'app-service:route-v0',
  activate: 'app-service:activate-v0',
});

const V1_HANDLER_MATRIX = handlerMatrix({
  authoring: 'app-kit:v1',
  inspect: 'app-service:inspect-v1',
  stage: 'app-service:stage-v1-requested-grant',
  review: 'app-review-service:prepare-v1',
  route: 'app-action-service:route-v1',
  activate: 'app-review-service:activate-v1',
  invoke: 'app-action-service:invoke-v1',
});

export const DEFT_APP_PROTOCOL_SUPPORT = Object.freeze({
  '0': Object.freeze({
    manifest_keys: Object.freeze([
      'schema_version', 'id', 'version', 'name', 'description', 'license',
      'compatibility', 'provenance', 'modules', 'navigation',
    ]),
    atoms: protocolAtoms([
      'manifest.identity',
      'manifest.provenance',
      'modules.included',
      'navigation.host_rendered',
      'package.module_artifacts',
    ], V0_HANDLER_MATRIX),
    private_interfaces: Object.freeze([]),
  }),
  '1': Object.freeze({
    manifest_keys: Object.freeze([
      'schema_version', 'id', 'version', 'name', 'description', 'license',
      'compatibility', 'provenance', 'modules', 'navigation', 'dependencies',
      'resource_requirements', 'capability_requirements',
      'connector_requirements', 'actions',
    ]),
    atoms: protocolAtoms([
      'manifest.identity',
      'manifest.provenance',
      'modules.included',
      'navigation.host_rendered',
      'dependencies.exact_app',
      'resources.included_module',
      'resources.dependency_module',
      'capabilities.private_app_lineage',
      'connectors.existing_mcp',
      'actions.resource_detail',
      'action_inputs.resource_field',
      'action_inputs.selected_relation_field',
      'action_inputs.user_input',
      'package.module_artifacts',
    ], V1_HANDLER_MATRIX),
    private_interfaces: Object.freeze([
      SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
    ]),
  }),
} as const);

export type DeftAppPrivateInterfaceDescriptorV1 =
  typeof DEFT_APP_PROTOCOL_SUPPORT['1']['private_interfaces'][number];

export function isDeftAppProtocolOperationSupported(
  protocol: string,
  operation: DeftAppProtocolOperation,
): boolean {
  const support = DEFT_APP_PROTOCOL_SUPPORT[protocol as keyof typeof DEFT_APP_PROTOCOL_SUPPORT];
  return support !== undefined
    && Object.values(support.atoms).every((handlers) => handlers[operation] !== null);
}

export const DeftAppPackageArtifactV0Schema = z.strictObject({
  path: AppArtifactPathSchema,
  media_type: z.literal(DEFT_MODULE_ARTIFACT_MEDIA_TYPE),
  content: z.string().max(APP_LIMITS.artifact_bytes),
  byte_length: z.number().int().nonnegative().max(APP_LIMITS.artifact_bytes),
  digest: AppDigestSchema,
});

export const DeftAppPackageV0Schema = z.strictObject({
  package_format: z.literal(DEFT_APP_PACKAGE_FORMAT),
  manifest: DeftAppManifestV0Schema,
  manifest_digest: AppDigestSchema,
  artifacts: z.array(DeftAppPackageArtifactV0Schema).min(1).max(APP_LIMITS.artifacts_per_app),
});

export const DeftAppPackageV1Schema = z.strictObject({
  package_format: z.literal(DEFT_APP_PACKAGE_FORMAT_V1),
  manifest: DeftAppManifestV1Schema,
  manifest_digest: AppDigestSchema,
  artifacts: z.array(DeftAppPackageArtifactV0Schema).min(1).max(APP_LIMITS.artifacts_per_app),
});

export const DeftAppManifestSchema = z.union([DeftAppManifestV0Schema, DeftAppManifestV1Schema]);
export const DeftAppPackageSchema = z.union([DeftAppPackageV0Schema, DeftAppPackageV1Schema]);

export type DeftAppManifestV0 = z.infer<typeof DeftAppManifestV0Schema>;
export type DeftAppManifestV0Input = z.input<typeof DeftAppManifestV0Schema>;
export type DeftAppManifestV1 = z.infer<typeof DeftAppManifestV1Schema>;
export type DeftAppManifestV1Input = z.input<typeof DeftAppManifestV1Schema>;
export type DeftAppManifest = z.infer<typeof DeftAppManifestSchema>;
export type DeftAppManifestInput = z.input<typeof DeftAppManifestSchema>;
export type DeftAppPackageV0 = z.infer<typeof DeftAppPackageV0Schema>;
export type DeftAppPackageV1 = z.infer<typeof DeftAppPackageV1Schema>;
export type DeftAppPackage = z.infer<typeof DeftAppPackageSchema>;
export type DeftAppPackageArtifactV0 = z.infer<typeof DeftAppPackageArtifactV0Schema>;
export type AppDigest = z.infer<typeof AppDigestSchema>;

function recordWithString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' ? item : undefined;
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalizeJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === 'object') {
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) output[key.normalize('NFC')] = canonicalizeJson(item);
    }
    return output;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

function assertByteLimit(value: string, limit: number, label: string): void {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

async function digestText(value: string): Promise<AppDigest> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable in this runtime');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return AppDigestSchema.parse(`sha256:${hex}`);
}

export function parseDeftAppManifest(value: unknown): DeftAppManifest {
  // Preserve v0 rejection behavior exactly: anything not explicitly marked v1
  // continues through the original direct v0 schema instead of a union branch.
  const manifest = recordWithString(value, 'schema_version') === DEFT_APP_MANIFEST_SCHEMA_VERSION_V1
    ? DeftAppManifestV1Schema.parse(value)
    : DeftAppManifestV0Schema.parse(value);
  if (!isDeftAppProtocolOperationSupported(manifest.compatibility.app_protocol, 'authoring')) {
    throw new TypeError(`App Protocol v${manifest.compatibility.app_protocol} authoring is not registered`);
  }
  const registeredKeys = DEFT_APP_PROTOCOL_SUPPORT[manifest.compatibility.app_protocol].manifest_keys;
  for (const key of Object.keys(manifest)) {
    if (!(registeredKeys as readonly string[]).includes(key)) {
      throw new TypeError(`App Protocol v${manifest.compatibility.app_protocol} manifest key is not registered: ${key}`);
    }
  }
  assertByteLimit(JSON.stringify(manifest), APP_LIMITS.manifest_bytes, 'App manifest');
  return manifest;
}

export function parseDeftAppManifestJson(value: string): DeftAppManifest {
  assertByteLimit(value, APP_LIMITS.manifest_bytes, 'App manifest');
  try {
    return parseDeftAppManifest(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('App manifest is not valid JSON', { cause: error });
    throw error;
  }
}

export function canonicalAppManifestJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(parseDeftAppManifest(value)));
}

export async function digestAppManifest(value: unknown): Promise<AppDigest> {
  return digestText(canonicalAppManifestJson(value));
}

export function getDeftAppManifestV0JsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Deft declarative app manifest v0',
    ...z.toJSONSchema(DeftAppManifestV0Schema, { target: 'draft-2020-12', unrepresentable: 'any' }),
  } as Record<string, unknown>;
}

export function getDeftAppManifestV1JsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Deft connected app manifest v1',
    ...z.toJSONSchema(DeftAppManifestV1Schema, { target: 'draft-2020-12', unrepresentable: 'any' }),
  } as Record<string, unknown>;
}

type ModuleIdentity = { schema_version: string; id: string; version: string };

const ModuleResourceShapeSchema = z.object({
  collections: z.array(z.object({
    key: AppMachineKeyV1Schema,
    fields: z.array(z.object({
      key: AppMachineKeyV1Schema,
      type: z.string(),
      target: z.object({
        module_id: AppIdSchema,
        resource_type: AppMachineKeyV1Schema,
      }).optional(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

function parseModuleArtifactIdentity(value: unknown): ModuleIdentity {
  return z
    .strictObject({
      schema_version: z.union([z.literal('1'), z.literal('2')]),
      id: AppIdSchema,
      version: AppSemverSchema,
    })
    .passthrough()
    .parse(value);
}

export async function prepareModuleArtifact(input: {
  path: string;
  manifest: unknown;
}): Promise<DeftAppPackageArtifactV0> {
  const path = AppArtifactPathSchema.parse(input.path);
  parseModuleArtifactIdentity(input.manifest);
  const content = JSON.stringify(canonicalizeJson(input.manifest));
  assertByteLimit(content, APP_LIMITS.artifact_bytes, 'Module artifact');
  return DeftAppPackageArtifactV0Schema.parse({
    path,
    media_type: DEFT_MODULE_ARTIFACT_MEDIA_TYPE,
    content,
    byte_length: textEncoder.encode(content).byteLength,
    digest: await digestText(content),
  });
}

async function verifyPackage(packageValue: DeftAppPackage): Promise<void> {
  const artifacts = new Map<string, DeftAppPackageArtifactV0>();
  const moduleManifests = new Map<string, unknown>();
  for (const artifact of packageValue.artifacts) {
    if (artifacts.has(artifact.path)) throw new Error(`Duplicate package artifact path ${artifact.path}`);
    assertByteLimit(artifact.content, APP_LIMITS.artifact_bytes, 'Module artifact');
    if (textEncoder.encode(artifact.content).byteLength !== artifact.byte_length) {
      throw new Error(`Artifact byte length mismatch for ${artifact.path}`);
    }
    if ((await digestText(artifact.content)) !== artifact.digest) {
      throw new Error(`Artifact digest mismatch for ${artifact.path}`);
    }
    artifacts.set(artifact.path, artifact);
  }
  if ((await digestAppManifest(packageValue.manifest)) !== packageValue.manifest_digest) {
    throw new Error('App manifest digest mismatch');
  }
  if (artifacts.size !== packageValue.manifest.modules.length) {
    throw new Error('Package must contain exactly the artifacts declared by the app manifest');
  }
  for (const moduleReference of packageValue.manifest.modules) {
    const artifact = artifacts.get(moduleReference.manifest_path);
    if (!artifact) throw new Error(`Missing module artifact ${moduleReference.manifest_path}`);
    if (artifact.digest !== moduleReference.manifest_digest) {
      throw new Error(`Manifest digest does not match artifact ${artifact.path}`);
    }
    let moduleManifest: unknown;
    try {
      moduleManifest = JSON.parse(artifact.content) as unknown;
    } catch (error) {
      throw new Error(`Module artifact ${artifact.path} is not valid JSON`, { cause: error });
    }
    const identity = parseModuleArtifactIdentity(moduleManifest);
    if (identity.id !== moduleReference.module_id || identity.version !== moduleReference.version) {
      throw new Error(`Module identity does not match app manifest for ${artifact.path}`);
    }
    moduleManifests.set(identity.id, moduleManifest);
  }
  if (packageValue.manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION_V1) {
    verifyV1ResourceBindings(packageValue.manifest, moduleManifests);
  }
}

function verifyV1ResourceBindings(
  manifest: DeftAppManifestV1,
  moduleManifests: ReadonlyMap<string, unknown>,
): void {
  const resources = new Map(manifest.resource_requirements.map((resource) => [resource.key, resource]));
  const includedCollections = new Map<string, z.infer<typeof ModuleResourceShapeSchema>['collections'][number]>();

  for (const resource of manifest.resource_requirements) {
    if (resource.source.kind !== 'included_module') continue;
    const moduleManifest = ModuleResourceShapeSchema.parse(moduleManifests.get(resource.source.module_id));
    const collection = moduleManifest.collections.find((item) => item.key === resource.resource_type);
    if (!collection) throw new Error(`Resource requirement ${resource.key} references an unknown included collection`);
    const fieldKeys = new Set(collection.fields.map((field) => field.key));
    for (const field of resource.fields) {
      if (!fieldKeys.has(field)) {
        throw new Error(`Resource requirement ${resource.key} references unknown included field ${field}`);
      }
    }
    includedCollections.set(resource.key, collection);
  }

  for (const action of manifest.actions) {
    for (const binding of action.input_bindings) {
      if (binding.source.kind !== 'selected_relation_field') continue;
      const source = binding.source;
      const sourceCollection = includedCollections.get(source.source_resource_requirement_key);
      if (!sourceCollection) continue;
      const relation = sourceCollection.fields.find((field) => field.key === source.relation_field_key);
      const targetResource = resources.get(source.target_resource_requirement_key);
      if (
        relation?.type !== 'resource_ref'
        || !relation.target
        || !targetResource
        || relation.target.module_id !== targetResource.source.module_id
        || relation.target.resource_type !== targetResource.resource_type
      ) {
        throw new Error(`Action ${action.key} selected relation does not target the declared resource requirement`);
      }
    }
  }
}

export async function buildDeftAppPackage(input: {
  manifest: DeftAppManifestInput;
  artifacts: DeftAppPackageArtifactV0[];
}): Promise<{ package: DeftAppPackage; json: string; digest: AppDigest }> {
  const manifest = parseDeftAppManifest(input.manifest);
  const packageSchema = manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION
    ? DeftAppPackageV0Schema
    : DeftAppPackageV1Schema;
  const packageValue = packageSchema.parse({
    package_format: manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION
      ? DEFT_APP_PACKAGE_FORMAT
      : DEFT_APP_PACKAGE_FORMAT_V1,
    manifest,
    manifest_digest: await digestAppManifest(manifest),
    artifacts: [...input.artifacts].sort((left, right) => left.path.localeCompare(right.path)),
  });
  await verifyPackage(packageValue);
  const json = JSON.stringify(canonicalizeJson(packageValue));
  assertByteLimit(json, APP_LIMITS.package_bytes, 'App package');
  return { package: packageValue, json, digest: await digestText(json) };
}

export async function verifyDeftAppPackageJson(
  value: string,
): Promise<{ package: DeftAppPackage; json: string; digest: AppDigest }> {
  assertByteLimit(value, APP_LIMITS.package_bytes, 'App package');
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('App package is not valid JSON', { cause: error });
  }
  // As with manifest parsing, direct dispatch keeps invalid-v0 issue shapes
  // stable while allowing the explicitly versioned v1 package format.
  const packageValue = recordWithString(raw, 'package_format') === DEFT_APP_PACKAGE_FORMAT_V1
    ? DeftAppPackageV1Schema.parse(raw)
    : DeftAppPackageV0Schema.parse(raw);
  await verifyPackage(packageValue);
  const json = JSON.stringify(canonicalizeJson(packageValue));
  return { package: packageValue, json, digest: await digestText(json) };
}
