'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { captureLinkToken } from './link-token';
import { usePathname } from 'next/navigation';

const LinkTokenContext = createContext<string | null | undefined>(undefined);

/** Keep transient credential memory above ThemeProvider's hydration remount. */
export function LinkTokenBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const cleanPath = pathname === '/invite' ? '/invite' : pathname === '/reset-password' ? '/reset-password' : null;
  const captured = useRef<string | null | undefined>(undefined);
  const scope = useRef<string | null>(null);
  const [credential, setCredential] = useState<{ path: string; token: string | null }>();
  useEffect(() => {
    if (scope.current !== cleanPath) { captured.current = undefined; scope.current = cleanPath; }
    if (!cleanPath) { setCredential(undefined); return; }
    let active = true;
    const capture = () => {
      if (!active) return;
      setCredential({ path: cleanPath, token: captureLinkToken(captured, window.location, window.history, cleanPath) });
    };
    window.addEventListener('hashchange', capture);
    window.addEventListener('popstate', capture);
    // Parent AppRouter installs its external history integration in an effect.
    queueMicrotask(capture);
    return () => {
      active = false;
      window.removeEventListener('hashchange', capture);
      window.removeEventListener('popstate', capture);
    };
  }, [cleanPath]);
  return <LinkTokenContext.Provider value={credential?.path === cleanPath ? credential.token : undefined}>{children}</LinkTokenContext.Provider>;
}

export function useLinkToken() { return useContext(LinkTokenContext); }
