import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppRunError } from './app-run-errors.js';
import { getAppRunRuntime } from './app-run-runtime.js';
const Input = z.strictObject({ runtime_binding_id: z.string().uuid(), idempotency_key: z.string().min(1).max(80),
  input: z.record(z.string().min(1).max(64), z.union([z.string().max(16_384), z.number().finite(), z.boolean()])) });
/** Called only by the existing hosted tool executor with its trusted employee context. */
export async function requestRuntimeActionForAgent(orgId: string, employeeId: string | undefined, raw: unknown) {
  if (!employeeId) throw new AppRunError('APP_RUN_ACCESS_DENIED');
  const request = Input.parse(raw);
  if (Buffer.byteLength(JSON.stringify(request.input)) > 65_536 || Object.keys(request.input).length > 32) throw new AppRunError('APP_RUN_INPUT_TOO_LARGE');
  const run = await (await getAppRunRuntime()).service.submitReviewedRuntimeAgent({ org_id: orgId, agent_employee_id: employeeId }, {
    ...request, idempotency_key: `agent-runtime:${employeeId}:${createHash('sha256').update(request.idempotency_key).digest('hex')}`,
  });
  return { run_id: run.id, state: run.state, approval_required: true as const };
}
