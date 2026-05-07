'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

type Ctx = {
  pageContext: ReactNode;
  setPageContext: (node: ReactNode) => void;
};

const AppHeaderContext = createContext<Ctx | null>(null);

export function AppHeaderProvider({ children }: { children: ReactNode }) {
  const [pageContext, setPageContext] = useState<ReactNode>(null);
  return (
    <AppHeaderContext.Provider value={{ pageContext, setPageContext }}>
      {children}
    </AppHeaderContext.Provider>
  );
}

export function useAppHeaderContext() {
  const ctx = useContext(AppHeaderContext);
  if (!ctx) throw new Error('useAppHeaderContext must be used inside AppHeaderProvider');
  return ctx;
}

/** Hook for pages: call once at the top of a client component to set header context. */
// eslint-disable-next-line react-hooks/exhaustive-deps
export function useSetPageContext(node: ReactNode, deps: unknown[] = []) {
  const { setPageContext } = useAppHeaderContext();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPageContext(node); return () => setPageContext(null); }, deps);
}
