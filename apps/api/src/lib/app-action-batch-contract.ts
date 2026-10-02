import { z } from 'zod';
export const ActionBatchProposalSchema = z.strictObject({
  runtime_binding_id: z.string().uuid(), idempotency_key: z.string().min(1).max(80), title: z.string().min(1).max(200),
  items: z.array(z.strictObject({ key: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/), label: z.string().min(1).max(200),
    input: z.record(z.string().min(1).max(64), z.union([z.string().max(16_384), z.number().finite(), z.boolean()]))
      .refine(v => Object.keys(v).length <= 32 && Buffer.byteLength(JSON.stringify(v)) <= 65_536) })).min(1).max(10)
    .refine(v => new Set(v.map(i => i.key)).size === v.length),
}).refine(v => Buffer.byteLength(JSON.stringify(v)) <= 65_536);
export const ActionBatchApproveSchema = z.strictObject({ ticket: z.string().min(1).max(100_000), expected_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) });
export type ActionBatchCaller = Readonly<{ org_id: string; user_id: string; employee_id?: string; agent_employee_id?: string;
  source: 'defty' | 'personal_mcp' | 'employee_mcp'; token_id?: string; token_kind?: 'mcp' | 'oauth'; scopes?: readonly string[] }>;
export const BatchProposeSchema = ActionBatchProposalSchema;
export const BatchIdSchema = z.strictObject({ batch_id: z.string().uuid() });
