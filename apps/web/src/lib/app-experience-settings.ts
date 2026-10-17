/** Display state supplied by the authenticated host, never by an App Worker. */
export type ExperienceSettingsAccount = Readonly<{
  key: string;
  label: string;
  statusLabel?: string;
  detail?: string;
}>;

export type ExperienceSettingsGrant = Readonly<{
  key: string;
  label: string;
  detail?: string;
}>;

export type ExperienceSettingsAccess = Readonly<{
  state: 'active' | 'review_required' | 'unavailable';
  summary?: string;
  grants?: readonly ExperienceSettingsGrant[];
}>;

export type ExperienceSettingsSection = 'accounts' | 'access' | 'approvals' | 'preferences';
