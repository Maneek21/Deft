import type { AppInstallation, AppOwnerConnectionPolicy } from './apps';

/** Who sees the admission screen. It matches what the server allows today
 * (owner or admin, `assertCurrentModuleManagerWithExecutor`). The owner of Deft
 * has not yet chosen between this and the owner alone; narrowing it is this
 * one line and its test. */
export const ACCOUNT_OPERATOR_ADMISSION_ROLES: readonly string[] = ['owner', 'admin'];
export const canAdmitAccountOperators = (role: string | undefined) => !!role && ACCOUNT_OPERATOR_ADMISSION_ROLES.includes(role);

/** Members the server accepts as an account operator: active people, never agents or guests. */
export const accountOperatorChoices = (members: readonly { id: string; name: string; kind?: string; role?: string }[]) =>
  members.filter(member => member.kind === 'human' && ['owner', 'admin', 'member'].includes(member.role ?? ''));

export type AdmissionLimits = { max_records_per_page: number; max_page_bytes: number; max_retained_records: number; max_retained_bytes: number; min_interval_seconds: number };
/** Ceilings each member's own account permission must stay within. Bounds are the server's (APP_RESOURCE_SYNC_LIMIT_BOUNDS). */
export const ADMISSION_LIMIT_FIELDS: readonly { key: keyof AdmissionLimits; label: string; min: number; max: number }[] = [
  { key: 'max_records_per_page', label: 'Records per sync page', min: 1, max: 100 },
  { key: 'max_page_bytes', label: 'Bytes per sync page', min: 1, max: 524_288 },
  { key: 'max_retained_records', label: 'Saved records per account', min: 1, max: 100_000 },
  { key: 'max_retained_bytes', label: 'Saved bytes per account', min: 1, max: 1_073_741_824 },
  { key: 'min_interval_seconds', label: 'Seconds between syncs, at least', min: 60, max: 86_400 },
];
export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = { max_records_per_page: 50, max_page_bytes: 262_144,
  max_retained_records: 10_000, max_retained_bytes: 104_857_600, min_interval_seconds: 300 };

export type AdmissionRequest = { installation_id: string; policy_key: string; operator_user_id: string; limits: AdmissionLimits;
  expected_app_version_id: string; expected_package_digest: string; expected_grant_snapshot_digest: string;
  expected_lifecycle_epoch: number; expected_grant_epoch: number };

type Grants = { installation?: { id?: unknown; state?: unknown; active_version_id?: unknown; active_grant_snapshot_id?: unknown; lifecycle_epoch?: unknown; grant_epoch?: unknown };
  versions?: { id?: unknown; package_digest?: unknown }[]; snapshots?: { id?: unknown; snapshot_digest?: unknown }[] };
/** Pins come from the current `GET /api/apps/:id/grants` read; the server refuses any that changed. */
export function admissionRequest(app: AppInstallation, value: unknown, policy: AppOwnerConnectionPolicy,
  operatorId: string, limits: AdmissionLimits): AdmissionRequest {
  const grants = ((value as { grants?: Grants } | null)?.grants ?? {}) as Grants, installation = grants.installation;
  const version = Array.isArray(grants.versions) ? grants.versions.find(row => row.id === installation?.active_version_id) : undefined;
  const snapshot = Array.isArray(grants.snapshots) ? grants.snapshots.find(row => row.id === installation?.active_grant_snapshot_id) : undefined;
  if (!installation || installation.id !== app.id || installation.state !== 'active' || !version || !snapshot
    || typeof version.id !== 'string' || typeof version.package_digest !== 'string' || typeof snapshot.snapshot_digest !== 'string'
    || !Number.isSafeInteger(installation.lifecycle_epoch) || !Number.isSafeInteger(installation.grant_epoch))
    throw new Error('This App changed. Reload it before admitting an account connection.');
  for (const field of ADMISSION_LIMIT_FIELDS) {
    const value = limits[field.key];
    if (!Number.isSafeInteger(value) || value < field.min || value > field.max) throw new Error(`${field.label} must be between ${field.min} and ${field.max}.`);
  }
  return { installation_id: app.id, policy_key: policy.key, operator_user_id: operatorId, limits,
    expected_app_version_id: version.id, expected_package_digest: version.package_digest, expected_grant_snapshot_digest: snapshot.snapshot_digest,
    expected_lifecycle_epoch: installation.lifecycle_epoch as number, expected_grant_epoch: installation.grant_epoch as number };
}

export type AdmissionReview = { digest: string; resource_key: string; action_keys: string[]; limits: AdmissionLimits;
  profile: { key: string; provider_id: string; authorization_origin: string } | null };
const same = (a: unknown, b: unknown) => JSON.stringify(a, Object.keys(a as object).sort()) === JSON.stringify(b, Object.keys(b as object).sort());

/** The server's review must describe exactly what was asked for. */
export function admissionReview(value: unknown, request: AdmissionRequest): AdmissionReview {
  const fail = () => { throw new Error('The admission review changed. Review it again.'); };
  const review = (value as { review?: { review_digest?: unknown; snapshot?: Record<string, any> } } | null)?.review;
  const snapshot = review?.snapshot;
  if (!snapshot || typeof review.review_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(review.review_digest)
    || snapshot.schema_version !== 'deft.owner_connection_admission.v1' || snapshot.installation_id !== request.installation_id
    || snapshot.app_version_id !== request.expected_app_version_id || snapshot.operator_user_id !== request.operator_user_id
    || snapshot.package_digest !== request.expected_package_digest || snapshot.grant_snapshot_digest !== request.expected_grant_snapshot_digest
    || snapshot.policy?.key !== request.policy_key || typeof snapshot.policy?.resource_key !== 'string'
    || !Array.isArray(snapshot.policy?.action_keys) || !snapshot.limits || !same(snapshot.limits, request.limits)) return fail();
  const profile = snapshot.connection_profile;
  if (profile && (profile.operator_user_id !== request.operator_user_id || typeof profile.key !== 'string'
    || typeof profile.provider_id !== 'string' || typeof profile.authorization_origin !== 'string')) return fail();
  return { digest: review.review_digest, resource_key: snapshot.policy.resource_key, action_keys: [...snapshot.policy.action_keys],
    limits: snapshot.limits, profile: profile ? { key: profile.key, provider_id: profile.provider_id, authorization_origin: profile.authorization_origin } : null };
}
