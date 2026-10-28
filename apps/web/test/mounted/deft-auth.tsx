/**
 * Auth boundary for the mounted chat tests. The real auth provider would need
 * a session round-trip; the surfaces under test only read the current user and
 * session scope.
 */
'use client';

import { useAuth as realUseAuth } from '../../src/lib/auth-context';

export * from '../../src/lib/auth-context';

const user = {
  id: 'u-priya',
  name: 'Priya Shah',
  email: 'priya@deft.test',
  avatar_url: null,
  title: null,
  profile_summary: null,
  expertise_tags: null,
  status_emoji: null,
  status_text: null,
  status_expires_at: null,
  timezone: 'UTC',
  notification_keywords: null,
  notification_preferences: null,
  show_read_receipts: true,
  role: 'member' as const,
};

export function useAuth(): ReturnType<typeof realUseAuth> {
  return {
    user,
    org: { id: 'org-1', name: 'Deft', slug: 'deft' },
    loading: false,
    sessionCacheScope: 'mounted-session',
    login: async () => {},
    signup: async () => {},
    logout: async () => {},
    replaceUser: () => {},
    refreshUser: async () => {},
  };
}
