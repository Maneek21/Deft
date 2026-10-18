'use client';

import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from '@/lib/auth-context';
import { useEffect } from 'react';
import { APPS_ENABLED, APP_RESOURCE_SYNC_ENABLED, APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Nonsecret release diagnostic. Set only by hydrated browser code so release
    // verification cannot mistake runtime environment values for compiled flags.
    document.documentElement.setAttribute('data-deft-browser-features', JSON.stringify({
      apps: APPS_ENABLED,
      resource_sync: APP_RESOURCE_SYNC_ENABLED,
      attachment_broker: APP_ATTACHMENT_BROKER_ENABLED,
    }));
    return () => document.documentElement.removeAttribute('data-deft-browser-features');
  }, []);

  return (
    <ThemeProvider>
      <AuthProvider>{children}</AuthProvider>
    </ThemeProvider>
  );
}
