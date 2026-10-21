import {z} from 'zod';
import {registerPrivateInterfaceProfile} from '../../private-interface-registry.js';
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


registerPrivateInterfaceProfile(Object.freeze({descriptor:SANDBOX_EMAIL_SEND_PRIVATE_INTERFACE,input:SandboxEmailSendInputSchema,automation:APP_AUTOMATION_POLICY_V1,requiredInputs:['to','subject','body_text'],validateBinding:(binding:{input_key:string;source:{kind:string;input_type?:string}})=>{if(binding.source.kind!=='user_input')return;const type=binding.input_key==='to'?'email':'text';return binding.source.input_type===type?undefined:`${binding.input_key} user input must use ${type}`;}}));
