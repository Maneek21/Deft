'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import type { ExperienceNavigationItem } from '@/lib/app-experience-bridge';

type Navigation = {
  owner: symbol; installationId: string; pathname: string; scope: string;
  items: readonly ExperienceNavigationItem[]; select: (id: string) => void;
};
type Context = {
  navigation: Navigation | null;
  publishNavigation: (navigation: Navigation) => void;
  clearNavigation: (owner: symbol) => void;
};
const ExperienceNavigationContext = createContext<Context | null>(null);

/** Only the mounted, authorized app can populate its current sidebar section. */
export function ExperienceNavigationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Navigation | null>(null);
  const pathname = usePathname();
  const { sessionCacheScope } = useAuth();
  const publishNavigation = useCallback((navigation: Navigation) => setState(navigation), []);
  const clearNavigation = useCallback((owner: symbol) => setState(current => current?.owner === owner ? null : current), []);
  const navigation = state?.pathname === pathname && state.scope === sessionCacheScope ? state : null;
  const value = useMemo(() => ({ navigation, publishNavigation, clearNavigation }), [navigation, publishNavigation, clearNavigation]);
  return <ExperienceNavigationContext.Provider value={value}>{children}</ExperienceNavigationContext.Provider>;
}

export function useExperienceNavigation() {
  const context = useContext(ExperienceNavigationContext);
  if (!context) throw new Error('Experience navigation requires its workspace provider');
  return context;
}
