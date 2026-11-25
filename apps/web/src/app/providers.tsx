'use client';

import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from '@/lib/auth-context';
import { LinkTokenBoundary } from '@/lib/use-link-token';
import { useEffect } from 'react';
import { documentServedWithoutCoop, followLinksWithFullLoads } from '@/lib/oauth-popup-marker';
import { APPS_ENABLED, APP_RESOURCE_SYNC_ENABLED, APP_ATTACHMENT_BROKER_ENABLED } from '@/lib/feature-flags';
import { installErrorTelemetry } from '@/lib/error-telemetry';

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
  // Uncaught errors go to this workspace's own server (lib/error-telemetry.ts).
  useEffect(() => installErrorTelemetry(), []);
  // A document served without COOP (an outside client's OAuth pop-up) leaves
  // by full loads only, so no other page of the app runs inside it.
  useEffect(() => (documentServedWithoutCoop() ? followLinksWithFullLoads() : undefined), []);

  return (
    <LinkTokenBoundary>
      <ThemeProvider><AuthProvider>{children}</AuthProvider></ThemeProvider>
    </LinkTokenBoundary>
  );
}
