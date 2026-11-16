'use client';

import { useEffect, useRef, useState } from 'react';
import { captureLinkToken } from './link-token';

/** Keep the credential only in the mounted page's memory. */
export function useLinkToken(cleanPath: string, pathToken: string | null = null) {
  const captured = useRef<string | null | undefined>(undefined);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const capture = () => {
      if (active) setToken(captureLinkToken(captured, window.location, window.history, cleanPath, pathToken));
    };
    window.addEventListener('hashchange', capture);
    window.addEventListener('popstate', capture);
    // Parent AppRouter installs its history integration in a mount effect.
    // Capture after those effects so address cleanup also updates the router.
    queueMicrotask(capture);
    return () => {
      active = false;
      window.removeEventListener('hashchange', capture);
      window.removeEventListener('popstate', capture);
    };
  }, [cleanPath, pathToken]);
  return token;
}
