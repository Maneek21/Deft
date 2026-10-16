import type { OrgRole } from './org-membership.js';

/** Resolved by the host from a live web session and current membership. */
export type NativeResourceSubject = Readonly<{
  org_id: string;
  user_id: string;
  role: OrgRole;
}>;

/** Owner-authored display data only; no body, provider URL or storage handle. */
export type NativeResourceDisplay = Readonly<{
  label: string;
  href?: string;
  revision?: string;
  updated_at?: string;
}>;
