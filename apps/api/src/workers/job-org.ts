import type { JobData } from './types.js';

/**
 * The one org a tenant job belongs to, or null when it names none or more
 * than one. The payload's `org_id` / `orgId` aliases and the queue row's own
 * `org_id` (when the job came from the queue) must all agree.
 */
export function jobOrgId(job: Pick<JobData, 'data' | 'orgId'>): string | null {
  const data = (job.data ?? {}) as Record<string, unknown>;
  const named = [data.org_id, data.orgId, job.orgId].filter((v) => v !== undefined && v !== null);
  if (named.length === 0) return null;
  const first = named[0];
  if (typeof first !== 'string' || !first) return null;
  return named.every((v) => v === first) ? first : null;
}
