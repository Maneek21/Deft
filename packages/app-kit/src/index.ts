import { z } from 'zod';
import {
  classifyAppAutomationOccurrence,
  resolveAppAutomationOccurrence,
} from './automation-schedule.js';

export {
  appAutomationLocalDate,
  classifyAppAutomationOccurrence,
  listAppAutomationLogicalDates,
  nextEligibleAppAutomationOccurrence,
  resolveAppAutomationOccurrence,
  type AppAutomationOccurrence,
  type AppAutomationOccurrenceDecision,
} from './automation-schedule.js';

export const DEFT_APP_MANIFEST_FILENAME = 'deft.app.json';
export const DEFT_APP_MANIFEST_SCHEMA_VERSION = '0' as const;
export const DEFT_APP_PROTOCOL_VERSION = '0' as const;
export const DEFT_APP_PACKAGE_FORMAT = 'deft.app.package.v0' as const;
export const DEFT_APP_MANIFEST_SCHEMA_VERSION_V1 = '1' as const;
export const DEFT_APP_PROTOCOL_VERSION_V1 = '1' as const;
export const DEFT_APP_PACKAGE_FORMAT_V1 = 'deft.app.package.v1' as const;
export const DEFT_APP_MANIFEST_SCHEMA_VERSION_V2 = '2' as const;
export const DEFT_APP_PROTOCOL_VERSION_V2 = '2' as const;
export const DEFT_APP_PACKAGE_FORMAT_V2 = 'deft.app.package.v2' as const;
export const DEFT_MODULE_ARTIFACT_MEDIA_TYPE = 'application/vnd.deft.module+json' as const;
export const DEFT_APP_KIT_PACKAGE_NAME = '@deft/app-kit' as const;
export const DEFT_APP_KIT_VERSION = '0.1.0-alpha.2' as const;
export const DEFT_APP_DEVELOPER_COMPATIBILITY_SCHEMA = 'deft.app_developer.compatibility.v1' as const;
export const DEFT_APP_DEVELOPER_CONTRACT_CHECK_SCHEMA = 'deft.app_developer.contract_check.v1' as const;
export const DEFT_APP_REQUESTED_AUTHORITY_REPORT_SCHEMA = 'deft.app.requested_authority.v1' as const;
export const DEFT_APP_REQUESTED_AUTHORITY_REPORT_SCHEMA_V2 = 'deft.app.requested_authority.v2' as const;
export const DEFT_APP_REQUESTED_AUTHORITY_DIFF_SCHEMA = 'deft.app.requested_authority_diff.v1' as const;
export const DEFT_APP_AUTOMATION_SIMULATION_SCHEMA = 'deft.app.automation_simulation.v1' as const;
export const DEFT_APP_REQUESTED_AUTHORITY_REPORT_PATH = '.deft/requested-authority.json' as const;

const DeftAppDeveloperProtocolV0FlowSchema = z.strictObject({
  package_format: z.literal(DEFT_APP_PACKAGE_FORMAT),
  install_mode: z.literal('stage_and_activate'),
});

const DeftAppDeveloperProtocolV1FlowSchema = z.strictObject({
  package_format: z.literal(DEFT_APP_PACKAGE_FORMAT_V1),
  install_mode: z.literal('stage_only'),
});

const DeftAppDeveloperProtocolV2FlowSchema = z.strictObject({
  package_format: z.literal(DEFT_APP_PACKAGE_FORMAT_V2),
  install_mode: z.literal('stage_only'),
});

export const DeftAppDeveloperCompatibilitySchema = z.strictObject({
  schema: z.literal(DEFT_APP_DEVELOPER_COMPATIBILITY_SCHEMA),
  app_kit: z.strictObject({
    package: z.literal(DEFT_APP_KIT_PACKAGE_NAME),
    versions: z.array(z.string().min(1)).min(1),
  }),
  protocol_flows: z.strictObject({
    '0': DeftAppDeveloperProtocolV0FlowSchema,
    '1': DeftAppDeveloperProtocolV1FlowSchema,
    '2': DeftAppDeveloperProtocolV2FlowSchema.optional(),
  }),
}).superRefine((value, ctx) => {
  if (new Set(value.app_kit.versions).size !== value.app_kit.versions.length) {
    ctx.addIssue({ code: 'custom', path: ['app_kit', 'versions'], message: 'App Kit versions must be unique' });
  }
});

export type DeftAppDeveloperCompatibility = z.infer<typeof DeftAppDeveloperCompatibilitySchema>;
export type DeftAppDeveloperProtocol = keyof DeftAppDeveloperCompatibility['protocol_flows'];
export type DeftAppDeveloperProtocolFlow = NonNullable<
  DeftAppDeveloperCompatibility['protocol_flows'][DeftAppDeveloperProtocol]
>;
export type DeftAppDeveloperInstallMode = DeftAppDeveloperProtocolFlow['install_mode'];

export const DEFT_APP_DEVELOPER_COMPATIBILITY = Object.freeze({
  schema: DEFT_APP_DEVELOPER_COMPATIBILITY_SCHEMA,
  app_kit: Object.freeze({
    package: DEFT_APP_KIT_PACKAGE_NAME,
    versions: Object.freeze([DEFT_APP_KIT_VERSION, '0.1.0-alpha.1']),
  }),
  protocol_flows: Object.freeze({
    '0': Object.freeze({
      package_format: DEFT_APP_PACKAGE_FORMAT,
      install_mode: 'stage_and_activate' as const,
    }),
    '1': Object.freeze({
      package_format: DEFT_APP_PACKAGE_FORMAT_V1,
      install_mode: 'stage_only' as const,
    }),
    '2': Object.freeze({
      package_format: DEFT_APP_PACKAGE_FORMAT_V2,
      install_mode: 'stage_only' as const,
    }),
  }),
});

export function parseDeftAppDeveloperCompatibility(value: unknown): DeftAppDeveloperCompatibility {
  return DeftAppDeveloperCompatibilitySchema.parse(value);
}

export function resolveDeftAppDeveloperProtocolFlow(
  value: unknown,
  protocol: string,
): DeftAppDeveloperProtocolFlow {
  const compatibility = parseDeftAppDeveloperCompatibility(value);
  if (!compatibility.app_kit.versions.includes(DEFT_APP_KIT_VERSION)) {
    throw new Error(`Host does not support ${DEFT_APP_KIT_PACKAGE_NAME} ${DEFT_APP_KIT_VERSION}`);
  }
  if (
    protocol !== DEFT_APP_PROTOCOL_VERSION
    && protocol !== DEFT_APP_PROTOCOL_VERSION_V1
    && protocol !== DEFT_APP_PROTOCOL_VERSION_V2
  ) {
    throw new Error(`Host does not support App Protocol v${protocol}`);
  }
  const flow = compatibility.protocol_flows[protocol];
  if (!flow) throw new Error(`Host does not support App Protocol v${protocol}`);
  return flow;
}

export function resolveDeftAppDeveloperInstallFlow(
  value: unknown,
  protocol: string,
): DeftAppDeveloperInstallMode {
  return resolveDeftAppDeveloperProtocolFlow(value, protocol).install_mode;
}

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
  automation_requests: 16,
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

/**
 * The only code-owned policy that may make the frozen sandbox email action
 * eligible for an approved automation definition. This is a separate,
 * additive authority input: the referenced interactive binding remains
 * automation-forbidden and is necessary but never sufficient on its own.
 */
export const APP_AUTOMATION_POLICY_V1 = Object.freeze({
  key: 'sandbox_email_send_approved_automation',
  version: '1',
  authority_owner: 'deft_core',
  app_authored: false,
  app_selectable: false,
  schedule_selectable: false,
  private_interface: SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
  action_binding: SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE.action_binding,
  base_host_policy: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy,
  review_scope: 'approved_automation_definition',
  definition: Object.freeze({
    fully_pinned: true,
    approving_roles: Object.freeze(['owner', 'admin'] as const),
  }),
  limits: Object.freeze({
    external_actions_per_fire: 1,
  }),
} as const);

export type AppAutomationPolicyV1 = typeof APP_AUTOMATION_POLICY_V1;

/**
 * Public, inert conformance data for independently implemented proof
 * providers. This contains no transport, provider loading, or execution code.
 */
export const SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS = Object.freeze({
  schema: 'deft.app.sandbox_email_send.conformance.v1',
  valid: Object.freeze({
    input: Object.freeze({
      to: 'ada@example.test',
      subject: 'Analytical Engines',
      body_text: 'Hello Ada',
      idempotency_key: 'campaign:one/contact:ada',
    }),
    output: Object.freeze({
      message_id: 'sandbox_a90928f63948386da7c8a7a4',
      status: 'accepted' as const,
    }),
  }),
  invalid: Object.freeze([
    Object.freeze({
      label: 'invalid_email',
      input: Object.freeze({
        to: 'not-email',
        subject: 'Analytical Engines',
        body_text: 'Hello Ada',
        idempotency_key: 'campaign:invalid/contact:ada',
      }),
    }),
    Object.freeze({
      label: 'header_injection',
      input: Object.freeze({
        to: 'ada@example.test',
        subject: 'Analytical Engines\r\nBcc: attacker@example.test',
        body_text: 'Hello Ada',
        idempotency_key: 'campaign:header/contact:ada',
      }),
    }),
  ]),
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

export const DeftAppAutomationRequestV2Schema = z.strictObject({
  key: AppAuthorityKeyV1Schema,
  label: boundedPlainText(APP_LIMITS.display_name_chars, 'Automation request label'),
  trigger: z.strictObject({
    kind: z.literal('daily_local_time'),
  }),
  action_key: AppAuthorityKeyV1Schema,
});

export const DeftAppManifestV2Schema = z
  .strictObject({
    ...DeftAppManifestV1Schema.shape,
    schema_version: z.literal(DEFT_APP_MANIFEST_SCHEMA_VERSION_V2),
    compatibility: z.strictObject({
      app_protocol: z.literal(DEFT_APP_PROTOCOL_VERSION_V2),
    }),
    automation_requests: z
      .array(DeftAppAutomationRequestV2Schema)
      .min(1)
      .max(APP_LIMITS.automation_requests),
  })
  .superRefine((manifest, ctx) => {
    const { automation_requests: _automationRequests, ...v1Fields } = manifest;
    const v1Validation = DeftAppManifestV1Schema.safeParse({
      ...v1Fields,
      schema_version: DEFT_APP_MANIFEST_SCHEMA_VERSION_V1,
      compatibility: { app_protocol: DEFT_APP_PROTOCOL_VERSION_V1 },
    });
    if (!v1Validation.success) {
      for (const issue of v1Validation.error.issues) {
        if (issue.code !== 'custom') {
          throw new TypeError('Protocol v2 base validation diverged from Protocol v1');
        }
        ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
      }
    }

    const actionByKey = new Map(manifest.actions.map((action) => [action.key, action]));
    const requestKeys = new Set<string>();
    for (const [index, request] of manifest.automation_requests.entries()) {
      addDuplicateIssue(
        ctx,
        requestKeys,
        request.key,
        ['automation_requests', index, 'key'],
        'Automation request key',
      );
      const action = actionByKey.get(request.action_key);
      if (!action) {
        ctx.addIssue({
          code: 'custom',
          path: ['automation_requests', index, 'action_key'],
          message: 'Automation request references an undeclared action',
        });
      } else if (action.input_bindings.some((binding) => binding.source.kind === 'user_input')) {
        ctx.addIssue({
          code: 'custom',
          path: ['automation_requests', index, 'action_key'],
          message: 'Automation request action cannot require user input',
        });
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

const V2_HANDLER_MATRIX = handlerMatrix({
  authoring: 'app-kit:v2',
  inspect: 'app-service:inspect-v2',
  stage: 'app-service:stage-v2-requested-automation',
  review: 'app-review-service:review-v2',
  route: 'app-action-service:route-v2',
  activate: 'app-review-service:activate-v2',
  invoke: 'app-action-service:invoke-v2',
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
  '2': Object.freeze({
    manifest_keys: Object.freeze([
      'schema_version', 'id', 'version', 'name', 'description', 'license',
      'compatibility', 'provenance', 'modules', 'navigation', 'dependencies',
      'resource_requirements', 'capability_requirements',
      'connector_requirements', 'actions', 'automation_requests',
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
      'automation_requests.daily_local_time',
      'package.module_artifacts',
    ], V2_HANDLER_MATRIX),
    private_interfaces: Object.freeze([
      SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,
    ]),
  }),
} as const);

export type DeftAppPrivateInterfaceDescriptorV1 =
  typeof DEFT_APP_PROTOCOL_SUPPORT['1']['private_interfaces'][number];
export type DeftAppPrivateInterfaceDescriptorV2 =
  typeof DEFT_APP_PROTOCOL_SUPPORT['2']['private_interfaces'][number];

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

export const DeftAppPackageV2Schema = z.strictObject({
  package_format: z.literal(DEFT_APP_PACKAGE_FORMAT_V2),
  manifest: DeftAppManifestV2Schema,
  manifest_digest: AppDigestSchema,
  artifacts: z.array(DeftAppPackageArtifactV0Schema).min(1).max(APP_LIMITS.artifacts_per_app),
});

export const DeftAppManifestSchema = z.union([
  DeftAppManifestV0Schema,
  DeftAppManifestV1Schema,
  DeftAppManifestV2Schema,
]);
export const DeftAppPackageSchema = z.union([
  DeftAppPackageV0Schema,
  DeftAppPackageV1Schema,
  DeftAppPackageV2Schema,
]);

export type DeftAppManifestV0 = z.infer<typeof DeftAppManifestV0Schema>;
export type DeftAppManifestV0Input = z.input<typeof DeftAppManifestV0Schema>;
export type DeftAppManifestV1 = z.infer<typeof DeftAppManifestV1Schema>;
export type DeftAppManifestV1Input = z.input<typeof DeftAppManifestV1Schema>;
export type DeftAppAutomationRequestV2 = z.infer<typeof DeftAppAutomationRequestV2Schema>;
export type DeftAppAutomationRequestV2Input = z.input<typeof DeftAppAutomationRequestV2Schema>;
export type DeftAppManifestV2 = z.infer<typeof DeftAppManifestV2Schema>;
export type DeftAppManifestV2Input = z.input<typeof DeftAppManifestV2Schema>;
export type DeftAppManifest = z.infer<typeof DeftAppManifestSchema>;
export type DeftAppManifestInput = z.input<typeof DeftAppManifestSchema>;
export type DeftAppPackageV0 = z.infer<typeof DeftAppPackageV0Schema>;
export type DeftAppPackageV1 = z.infer<typeof DeftAppPackageV1Schema>;
export type DeftAppPackageV2 = z.infer<typeof DeftAppPackageV2Schema>;
export type DeftAppPackage = z.infer<typeof DeftAppPackageSchema>;
export type DeftAppPackageArtifactV0 = z.infer<typeof DeftAppPackageArtifactV0Schema>;
export type AppDigest = z.infer<typeof AppDigestSchema>;

const SandboxEmailHostPolicySchema = z.strictObject({
  risk_class: z.literal(SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy.risk_class),
  review_requirement: z.literal(SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy.review_requirement),
  review_scope: z.literal(SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy.review_scope),
  egress_class: z.literal(SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy.egress_class),
  retry_class: z.literal(SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy.retry_class),
  retention_class: z.literal(SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy.retention_class),
  automation_eligibility: z.literal(
    SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy.automation_eligibility,
  ),
  provider_idempotency_key_required: z.literal(
    SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy.provider_idempotency_key_required,
  ),
});

export const DeftAppRequestedAuthorityProjectionSchema = z.strictObject({
  requirements: z.strictObject({
    dependencies: z.array(DeftAppDependencyRequirementV1Schema).max(APP_LIMITS.dependencies),
    resources: z.array(DeftAppResourceRequirementV1Schema).max(APP_LIMITS.resource_requirements),
    capabilities: z.array(DeftAppCapabilityRequirementV1Schema).max(APP_LIMITS.capability_requirements),
    connectors: z.array(DeftAppConnectorRequirementV1Schema).max(APP_LIMITS.connector_requirements),
    actions: z.array(DeftAppActionBindingV1Schema).max(APP_LIMITS.actions),
  }),
  resource_rights: z.array(z.strictObject({
    requirement_key: AppMachineKeyV1Schema,
    source: DeftAppResourceRequirementV1Schema.shape.source,
    resource_type: AppMachineKeyV1Schema,
    fields: z.array(AppMachineKeyV1Schema).min(1).max(APP_LIMITS.resource_fields_per_requirement),
    right: z.literal('read'),
  })).max(APP_LIMITS.resource_requirements),
  classification: z.strictObject({
    authority_state: z.literal('requested_only'),
    executable: z.literal(false),
    provider_access: z.literal(false),
    review_required: z.boolean(),
    actions: z.array(z.strictObject({
      action_key: AppAuthorityKeyV1Schema,
      capability_requirement_key: AppAuthorityKeyV1Schema,
      host_policy: SandboxEmailHostPolicySchema,
    })).max(APP_LIMITS.actions),
  }),
});

export const DeftAppRequestedAuthorityProjectionV2Schema = z.strictObject({
  requirements: z.strictObject({
    ...DeftAppRequestedAuthorityProjectionSchema.shape.requirements.shape,
    automation_requests: z
      .array(DeftAppAutomationRequestV2Schema)
      .min(1)
      .max(APP_LIMITS.automation_requests),
  }),
  resource_rights: DeftAppRequestedAuthorityProjectionSchema.shape.resource_rights,
  classification: DeftAppRequestedAuthorityProjectionSchema.shape.classification,
});

export const DeftAppRequestedAuthorityReportSchema = z.strictObject({
  schema: z.literal(DEFT_APP_REQUESTED_AUTHORITY_REPORT_SCHEMA),
  app: z.strictObject({
    id: AppIdSchema,
    version: AppSemverSchema,
    protocol_version: z.union([
      z.literal(DEFT_APP_PROTOCOL_VERSION),
      z.literal(DEFT_APP_PROTOCOL_VERSION_V1),
    ]),
  }),
  requested_authority: DeftAppRequestedAuthorityProjectionSchema,
});

export const DeftAppRequestedAuthorityReportV2Schema = z.strictObject({
  schema: z.literal(DEFT_APP_REQUESTED_AUTHORITY_REPORT_SCHEMA_V2),
  app: z.strictObject({
    id: AppIdSchema,
    version: AppSemverSchema,
    protocol_version: z.literal(DEFT_APP_PROTOCOL_VERSION_V2),
  }),
  requested_authority: DeftAppRequestedAuthorityProjectionV2Schema,
});

export const DeftAppRequestedAuthorityProjectionAnySchema = z.union([
  DeftAppRequestedAuthorityProjectionSchema,
  DeftAppRequestedAuthorityProjectionV2Schema,
]);
export const DeftAppRequestedAuthorityReportAnySchema = z.union([
  DeftAppRequestedAuthorityReportSchema,
  DeftAppRequestedAuthorityReportV2Schema,
]);

export type DeftAppRequestedAuthorityProjection =
  z.infer<typeof DeftAppRequestedAuthorityProjectionSchema>;
export type DeftAppRequestedAuthorityProjectionV2 =
  z.infer<typeof DeftAppRequestedAuthorityProjectionV2Schema>;
export type DeftAppRequestedAuthorityProjectionAny =
  DeftAppRequestedAuthorityProjection | DeftAppRequestedAuthorityProjectionV2;
export type DeftAppRequestedAuthorityReport = z.infer<typeof DeftAppRequestedAuthorityReportSchema>;
export type DeftAppRequestedAuthorityReportV2 = z.infer<typeof DeftAppRequestedAuthorityReportV2Schema>;
export type DeftAppRequestedAuthorityReportAny =
  DeftAppRequestedAuthorityReport | DeftAppRequestedAuthorityReportV2;

const DeftAppRequestedAuthorityAtomSchema = z.enum([
  'dependencies',
  'resources',
  'capabilities',
  'connectors',
  'actions',
  'automation_requests',
]);

export const DeftAppRequestedAuthorityDiffSchema = z.strictObject({
  schema: z.literal(DEFT_APP_REQUESTED_AUTHORITY_DIFF_SCHEMA),
  kind: z.enum(['initial', 'unchanged', 'widening_or_incompatible']),
  carry_forward_eligible: z.boolean(),
  changed_atoms: z.array(DeftAppRequestedAuthorityAtomSchema),
  prior_requested_authority_digest: AppDigestSchema.nullable(),
  proposed_requested_authority_digest: AppDigestSchema,
});

export type DeftAppRequestedAuthorityDiff = z.infer<typeof DeftAppRequestedAuthorityDiffSchema>;

export const DeftAppLockV2Schema = z.strictObject({
  schema: z.literal('deft.app.lock.v2'),
  app_id: AppIdSchema,
  version: AppSemverSchema,
  package_digest: AppDigestSchema,
  manifest_digest: AppDigestSchema,
  artifacts: z.array(z.strictObject({
    path: AppArtifactPathSchema,
    digest: AppDigestSchema,
    byte_length: z.number().int().nonnegative().max(APP_LIMITS.artifact_bytes),
    media_type: z.literal(DEFT_MODULE_ARTIFACT_MEDIA_TYPE),
  })).min(1).max(APP_LIMITS.artifacts_per_app),
  permissions: z.array(z.never()).max(0),
  requested_authority_digest: AppDigestSchema,
  permission_diff: DeftAppRequestedAuthorityDiffSchema,
});

export type DeftAppLockV2 = z.infer<typeof DeftAppLockV2Schema>;

const AppAutomationSimulatorPinSchema = z.strictObject({
  revision: z.string().min(1).max(128),
  content_digest: AppDigestSchema,
});

export const DeftAppAutomationSimulationInputSchema = z.strictObject({
  manifest: DeftAppManifestV2Schema,
  request_key: AppAuthorityKeyV1Schema,
  occurrence: z.strictObject({
    logical_local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(128),
    now: z.string().datetime({ offset: true }),
    eligible_after: z.string().datetime({ offset: true }),
    eligible_before: z.string().datetime({ offset: true }).optional(),
  }),
  pins: z.strictObject({
    placement: z.strictObject({
      approved: AppAutomationSimulatorPinSchema,
      current: AppAutomationSimulatorPinSchema,
    }),
    selected: z.strictObject({
      approved: AppAutomationSimulatorPinSchema,
      current: AppAutomationSimulatorPinSchema,
    }),
  }),
  provider_input: z.unknown(),
});

export type DeftAppAutomationSimulationInput = z.input<typeof DeftAppAutomationSimulationInputSchema>;

/** Deterministic public authoring diff. This compares requested declarations
 * only; it never represents an effective host grant or approval decision. */
export async function diffDeftAppRequestedAuthority(input: Readonly<{
  prior?: DeftAppManifestInput | DeftAppManifest | null;
  proposed: DeftAppManifestInput | DeftAppManifest;
}>): Promise<DeftAppRequestedAuthorityDiff> {
  const proposed = projectDeftAppRequestedAuthority(input.proposed);
  const prior = input.prior === undefined || input.prior === null
    ? null
    : projectDeftAppRequestedAuthority(input.prior);
  const digest = (value: unknown) => digestText(JSON.stringify(canonicalizeJson(value)));
  const proposedDigest = await digest(proposed);
  const priorDigest = prior === null ? null : await digest(prior);
  const atoms = DeftAppRequestedAuthorityAtomSchema.options;
  const requirement = (value: DeftAppRequestedAuthorityProjectionAny, atom: typeof atoms[number]) => {
    if (atom === 'automation_requests') {
      return 'automation_requests' in value.requirements ? value.requirements.automation_requests : [];
    }
    return value.requirements[atom];
  };
  const changedAtoms = prior === null
    ? atoms.filter((atom) => requirement(proposed, atom).length > 0)
    : (await Promise.all(atoms.map(async (atom) => ({
        atom,
        changed: await digest(requirement(prior, atom)) !== await digest(requirement(proposed, atom)),
      })))).filter(({ changed }) => changed).map(({ atom }) => atom);
  return DeftAppRequestedAuthorityDiffSchema.parse({
    schema: DEFT_APP_REQUESTED_AUTHORITY_DIFF_SCHEMA,
    kind: priorDigest === null
      ? 'initial'
      : priorDigest === proposedDigest
        ? 'unchanged'
        : 'widening_or_incompatible',
    carry_forward_eligible: priorDigest !== null && priorDigest === proposedDigest,
    changed_atoms: changedAtoms,
    prior_requested_authority_digest: priorDigest,
    proposed_requested_authority_digest: proposedDigest,
  });
}

/** Pure non-executable simulator for the bounded v2 request. It calls the
 * exact schedule resolver/classifier and frozen provider-input validator used
 * by Deft contracts; it does not resolve workspace data or invoke a provider. */
export function simulateDeftAppAutomation(value: DeftAppAutomationSimulationInput) {
  const input = DeftAppAutomationSimulationInputSchema.parse(value);
  const request = input.manifest.automation_requests.find((item) => item.key === input.request_key);
  if (!request) throw new Error(`Automation request ${input.request_key} is not declared`);
  const occurrence = resolveAppAutomationOccurrence({
    logical_local_date: input.occurrence.logical_local_date,
    local_time: input.occurrence.local_time,
    timezone: input.occurrence.timezone,
  });
  const decision = classifyAppAutomationOccurrence({
    occurrence,
    now: new Date(input.occurrence.now),
    eligible_after: new Date(input.occurrence.eligible_after),
    ...(input.occurrence.eligible_before
      ? { eligible_before: new Date(input.occurrence.eligible_before) }
      : {}),
    catch_up_window_minutes: 15,
  });
  const changedPins = (['placement', 'selected'] as const).flatMap((key) => {
    const { approved, current } = input.pins[key];
    return [
      ...(approved.revision === current.revision ? [] : [`${key}.revision`]),
      ...(approved.content_digest === current.content_digest ? [] : [`${key}.content_digest`]),
    ];
  });
  const providerInput = SandboxEmailSendInputSchema.safeParse(input.provider_input);
  return Object.freeze({
    schema: DEFT_APP_AUTOMATION_SIMULATION_SCHEMA,
    request: Object.freeze({
      key: request.key,
      action_key: request.action_key,
      trigger: request.trigger,
    }),
    schedule: Object.freeze({
      decision: decision.kind,
      ...(decision.kind === 'skipped' ? { reason: decision.reason } : {}),
      resolution: occurrence.resolution.kind,
      ...(occurrence.resolution.kind === 'resolved'
        ? { resolved_at_utc: occurrence.resolution.resolved_at_utc.toISOString() }
        : {}),
    }),
    pinned_inputs: Object.freeze({
      status: changedPins.length === 0 ? 'ready' as const : 'stale' as const,
      changed: Object.freeze(changedPins),
    }),
    provider_input: Object.freeze({
      status: providerInput.success ? 'valid' as const : 'invalid' as const,
      issues: Object.freeze(providerInput.success
        ? []
        : providerInput.error.issues.map(({ path, message }) => ({ path, message }))),
    }),
    executable: false as const,
    provider_access: false as const,
  });
}

export const APP_AUTOMATION_SIMULATOR_CONFORMANCE_VECTORS = Object.freeze({
  schema: 'deft.app.automation_simulator.conformance.v1',
  occurrences: Object.freeze([
    Object.freeze({
      label: 'ordinary_pending', logical_local_date: '2026-02-10', local_time: '09:00',
      timezone: 'UTC', now: '2026-02-10T09:05:00.000Z', expected: 'pending',
    }),
    Object.freeze({
      label: 'dst_fold_earlier', logical_local_date: '2026-11-01', local_time: '01:30',
      timezone: 'America/New_York', now: '2026-11-01T05:35:00.000Z',
      expected: 'pending', resolved_at_utc: '2026-11-01T05:30:00.000Z',
    }),
    Object.freeze({
      label: 'dst_gap', logical_local_date: '2026-03-08', local_time: '02:30',
      timezone: 'America/New_York', now: '2026-03-08T08:00:00.000Z', expected: 'skipped',
    }),
    Object.freeze({
      label: 'misfire', logical_local_date: '2026-02-10', local_time: '09:00',
      timezone: 'UTC', now: '2026-02-10T09:16:00.000Z', expected: 'skipped',
    }),
  ]),
  pins: Object.freeze({
    ready: Object.freeze({ expected: 'ready', changed: Object.freeze([]) }),
    stale: Object.freeze({ expected: 'stale', changed: Object.freeze(['selected.revision']) }),
  }),
} as const);

/**
 * Project only App-authored requested authority. Host identities, effective
 * grants, connector/provider selection, tokens, and lineage never enter this
 * portable report.
 */
export function projectDeftAppRequestedAuthority(
  value: DeftAppManifestInput | DeftAppManifest,
): DeftAppRequestedAuthorityProjectionAny {
  const manifest = parseDeftAppManifest(value);
  const connected = manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION
    ? null
    : manifest;
  const projection = {
    requirements: connected
      ? {
          dependencies: connected.dependencies,
          resources: connected.resource_requirements,
          capabilities: connected.capability_requirements,
          connectors: connected.connector_requirements,
          actions: connected.actions,
        }
      : { dependencies: [], resources: [], capabilities: [], connectors: [], actions: [] },
    resource_rights: connected
      ? connected.resource_requirements.map((requirement) => ({
          requirement_key: requirement.key,
          source: requirement.source,
          resource_type: requirement.resource_type,
          fields: requirement.fields,
          right: 'read' as const,
        }))
      : [],
    classification: {
      authority_state: 'requested_only' as const,
      executable: false as const,
      provider_access: false as const,
      review_required: connected !== null,
      actions: connected
        ? connected.actions.map((action) => ({
            action_key: action.key,
            capability_requirement_key: action.capability_requirement_key,
            host_policy: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy,
          }))
        : [],
    },
  };
  if (manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION_V2) {
    return DeftAppRequestedAuthorityProjectionV2Schema.parse(canonicalizeJson({
      ...projection,
      requirements: {
        ...projection.requirements,
        automation_requests: manifest.automation_requests,
      },
    }));
  }
  return DeftAppRequestedAuthorityProjectionSchema.parse(canonicalizeJson(projection));
}

export function buildDeftAppRequestedAuthorityReport(
  value: DeftAppManifestInput | DeftAppManifest,
): DeftAppRequestedAuthorityReportAny {
  const manifest = parseDeftAppManifest(value);
  if (manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION_V2) {
    return DeftAppRequestedAuthorityReportV2Schema.parse({
      schema: DEFT_APP_REQUESTED_AUTHORITY_REPORT_SCHEMA_V2,
      app: {
        id: manifest.id,
        version: manifest.version,
        protocol_version: manifest.compatibility.app_protocol,
      },
      requested_authority: projectDeftAppRequestedAuthority(manifest),
    });
  }
  return DeftAppRequestedAuthorityReportSchema.parse({
    schema: DEFT_APP_REQUESTED_AUTHORITY_REPORT_SCHEMA,
    app: {
      id: manifest.id,
      version: manifest.version,
      protocol_version: manifest.compatibility.app_protocol,
    },
    requested_authority: projectDeftAppRequestedAuthority(manifest),
  });
}

export function canonicalDeftAppRequestedAuthorityReportJson(
  value: DeftAppManifestInput | DeftAppManifest,
): string {
  return JSON.stringify(canonicalizeJson(buildDeftAppRequestedAuthorityReport(value)), null, 2);
}

/**
 * Validate only portable authoring contracts. Package verification performs
 * the static Module/resource/action binding checks; this helper does not
 * inspect a workspace, resolve effective grants, or call a provider.
 */
export async function checkDeftAppDeveloperContract(input: {
  package_json: string;
  host_compatibility: unknown;
}) {
  const verified = await verifyDeftAppPackageJson(input.package_json);
  const protocol = verified.package.manifest.compatibility.app_protocol;
  const installFlow = resolveDeftAppDeveloperProtocolFlow(input.host_compatibility, protocol);
  if (installFlow.package_format !== verified.package.package_format) {
    throw new Error(`Host advertises an incompatible package format for App Protocol v${protocol}`);
  }
  return {
    schema: DEFT_APP_DEVELOPER_CONTRACT_CHECK_SCHEMA,
    package: {
      format: verified.package.package_format,
      digest: verified.digest,
      protocol_version: protocol,
    },
    install_flow: installFlow,
    requested_authority: buildDeftAppRequestedAuthorityReport(verified.package.manifest),
    sandbox_email_conformance: {
      schema: SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.schema,
      valid_input: SandboxEmailSendInputSchema.parse(SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.input),
      expected_output: SandboxEmailSendOutputSchema.parse(SANDBOX_EMAIL_SEND_CONFORMANCE_VECTORS.valid.output),
    },
    ...(protocol === DEFT_APP_PROTOCOL_VERSION_V2 ? {
      automation_simulator_conformance: APP_AUTOMATION_SIMULATOR_CONFORMANCE_VECTORS,
    } : {}),
  };
}

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
  // Preserve v0 rejection behavior exactly: anything not explicitly marked
  // v1 or v2 continues through the original direct v0 schema instead of a
  // union branch.
  const schemaVersion = recordWithString(value, 'schema_version');
  const manifest = schemaVersion === DEFT_APP_MANIFEST_SCHEMA_VERSION_V2
    ? DeftAppManifestV2Schema.parse(value)
    : schemaVersion === DEFT_APP_MANIFEST_SCHEMA_VERSION_V1
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

export function getDeftAppManifestV2JsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Deft bounded automation request manifest v2',
    ...z.toJSONSchema(DeftAppManifestV2Schema, { target: 'draft-2020-12', unrepresentable: 'any' }),
  } as Record<string, unknown>;
}

export function getDeftAppManifestJsonSchema(schemaVersion: string): Record<string, unknown> {
  if (schemaVersion === DEFT_APP_MANIFEST_SCHEMA_VERSION_V2) {
    return getDeftAppManifestV2JsonSchema();
  }
  if (schemaVersion === DEFT_APP_MANIFEST_SCHEMA_VERSION_V1) {
    return getDeftAppManifestV1JsonSchema();
  }
  if (schemaVersion === DEFT_APP_MANIFEST_SCHEMA_VERSION) {
    return getDeftAppManifestV0JsonSchema();
  }
  throw new Error(`App manifest schema v${schemaVersion} is not supported`);
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
  if (
    packageValue.manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION_V1
    || packageValue.manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION_V2
  ) {
    verifyV1ResourceBindings(packageValue.manifest, moduleManifests);
  }
}

function verifyV1ResourceBindings(
  manifest: DeftAppManifestV1 | DeftAppManifestV2,
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
  const packageInput = {
    manifest,
    manifest_digest: await digestAppManifest(manifest),
    artifacts: [...input.artifacts].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const packageValue: DeftAppPackage = manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION_V2
    ? DeftAppPackageV2Schema.parse({ package_format: DEFT_APP_PACKAGE_FORMAT_V2, ...packageInput })
    : manifest.schema_version === DEFT_APP_MANIFEST_SCHEMA_VERSION_V1
      ? DeftAppPackageV1Schema.parse({ package_format: DEFT_APP_PACKAGE_FORMAT_V1, ...packageInput })
      : DeftAppPackageV0Schema.parse({ package_format: DEFT_APP_PACKAGE_FORMAT, ...packageInput });
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
  // stable while allowing the explicitly versioned v1 and v2 formats.
  const packageFormat = recordWithString(raw, 'package_format');
  const packageValue = packageFormat === DEFT_APP_PACKAGE_FORMAT_V2
    ? DeftAppPackageV2Schema.parse(raw)
    : packageFormat === DEFT_APP_PACKAGE_FORMAT_V1
      ? DeftAppPackageV1Schema.parse(raw)
      : DeftAppPackageV0Schema.parse(raw);
  await verifyPackage(packageValue);
  const json = JSON.stringify(canonicalizeJson(packageValue));
  return { package: packageValue, json, digest: await digestText(json) };
}
