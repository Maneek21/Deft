export type RuntimeAppReview = Readonly<{
  run_id: string;
  action_key: string;
  app_installation_id: string;
  app_version_id: string;
  grant_snapshot_id: string;
  runtime_binding_id: string;
  contract_digest: string;
  policy: Readonly<{
    risk_class: 'external_write';
    review_requirement: 'always';
    review_scope: 'per_invocation';
    retry_class: 'unsafe_or_unknown';
  }>;
  input: Readonly<Record<string, string | number | boolean>>;
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Parse the transient server response before letting the card enable approval. */
export function parseRuntimeAppReview(value: unknown, runId: string, bindingId: string): RuntimeAppReview | null {
  if (!record(value) || !exact(value, ['review']) || !record(value.review)) return null;
  const review = value.review;
  if (!exact(review, ['run_id', 'action_key', 'app_installation_id', 'app_version_id',
    'grant_snapshot_id', 'runtime_binding_id', 'contract_digest', 'policy', 'input'])
    || review.run_id !== runId || review.runtime_binding_id !== bindingId
    || typeof review.action_key !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(review.action_key)
    || typeof review.app_installation_id !== 'string' || !review.app_installation_id
    || typeof review.app_version_id !== 'string' || !review.app_version_id
    || typeof review.grant_snapshot_id !== 'string' || !review.grant_snapshot_id
    || typeof review.contract_digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(review.contract_digest)
    || !record(review.policy) || !exact(review.policy,
      ['risk_class', 'review_requirement', 'review_scope', 'retry_class'])
    || review.policy.risk_class !== 'external_write'
    || review.policy.review_requirement !== 'always'
    || review.policy.review_scope !== 'per_invocation'
    || review.policy.retry_class !== 'unsafe_or_unknown'
    || !record(review.input)) return null;
  const entries = Object.entries(review.input);
  if (entries.length > 32 || entries.some(([key, item]) =>
    !/^[a-z][a-z0-9_]{0,47}$/.test(key)
    || (typeof item !== 'boolean' && typeof item !== 'string'
      && !(typeof item === 'number' && Number.isFinite(item)))
    || (typeof item === 'string' && item.length > 16_384))) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(review.input)).byteLength > 65_536) return null;
  } catch { return null; }
  return review as RuntimeAppReview;
}
