export type ExperienceRunReviewTarget = { runId: string; state: string; bindingId: string; approvalId: string | null };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function experienceRunReviewTarget(value: unknown, expectedRunId: string): ExperienceRunReviewTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request unavailable');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'approval_id,run_id,run_state,runtime_binding_id,schema_version'
    || row.schema_version !== 'deft.experience_run_review_target.v1' || row.run_id !== expectedRunId || !uuid(row.run_id)
    || !uuid(row.runtime_binding_id) || typeof row.run_state !== 'string'
    || !['pending_approval','pending','running','waiting_external','succeeded','failed','cancelled','expired','unknown_outcome'].includes(row.run_state)
    || (row.run_state === 'pending_approval' ? !uuid(row.approval_id) : row.approval_id !== null)) throw new Error('Request unavailable');
  return { runId: row.run_id, state: row.run_state, bindingId: row.runtime_binding_id, approvalId: row.approval_id as string | null };
}
