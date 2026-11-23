'use client';

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api';
import { clearEnrolToken, exchangeTwoStepChallenge, readTwoStepPending, storeEnrolToken, type TwoStepPending } from './two-step';
import { setUserTimezone } from './time';
import { usePathname, useRouter } from 'next/navigation';
import { disconnectSocket } from './socket';
import { createSessionCacheScope, setActiveSessionCacheScope } from './session-cache';
import { signupRequestBody } from './setup-link';
import { parsePausedNotice, type PausedNotice } from './paused-notice';

type NotificationPreferences = {
  keywords: string[];
  channels: {
    chat: boolean;
    tasks: boolean;
    approvals: boolean;
    calendar: boolean;
    agents: boolean;
  };
  push?: {
    enabled: boolean;
    email: boolean;
    chat: boolean;
    tasks: boolean;
    approvals: boolean;
    calendar: boolean;
    agents: boolean;
    quiet_hours: { enabled: boolean; start: string; end: string };
  };
};

type User = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  title: string | null;
  profile_summary: string | null;
  expertise_tags: string[] | null;
  status_emoji: string | null;
  status_text: string | null;
  status_expires_at: string | null;
  timezone: string | null;
  notification_keywords: string[] | null;
  notification_preferences: NotificationPreferences | null;
  show_read_receipts: boolean;
  role: 'owner' | 'admin' | 'member' | 'guest';
};

type Org = {
  id: string;
  name: string;
  slug: string;
};

type AuthContextType = {
  user: User | null;
  org: Org | null;
  /** Set while the workspace is paused (read-only), from GET /api/auth/me. */
  paused: PausedNotice | null;
  loading: boolean;
  sessionCacheScope: string | null;
  /** Resolves with a challenge when the account still needs its code. */
  login: (email: string, password: string) => Promise<TwoStepPending | void>;
  /** Second call of a sign-in: the challenge plus a code or a recovery code. */
  verifyTwoStep: (challengeToken: string, proof: { code: string } | { recovery_code: string }) => Promise<void>;
  signup: (name: string, email: string, password: string, orgName: string, setupToken?: string) => Promise<void>;
  logout: (options?: LogoutOptions) => Promise<void>;
  replaceUser: (nextUser: User) => void;
  refreshUser: () => Promise<void>;
  /** Taken before a request that may hand back a session later. */
  sessionTicket: () => SessionTicket;
  /** Installs that session only if nobody signed out or in since the ticket. */
  adoptSession: (ticket: SessionTicket, accessToken: string, refreshToken: string) => boolean;
};

type LogoutOptions = {
  revokeServer?: boolean;
  destination?: string;
};

const LOGOUT_TIMEOUT_MS = 3000;

export class AuthRequestGeneration {
  private value = 0;

  capture(): number {
    return this.value;
  }

  advance(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(value: number): boolean {
    return value === this.value;
  }
}

function sessionIdentity(token: string | null): string | null {
  if (!token) return null;
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as Record<string, unknown>;
    if (typeof payload.id !== 'string' || typeof payload.org_id !== 'string' || typeof payload.sid !== 'string') return null;
    return `${payload.id}:${payload.org_id}:${payload.sid}`;
  } catch {
    return null;
  }
}

export function isCrossTabSessionReplacement(oldRefresh: string | null, newRefresh: string | null): boolean {
  if (!newRefresh) return false;
  const oldIdentity = sessionIdentity(oldRefresh);
  const newIdentity = sessionIdentity(newRefresh);
  return oldIdentity === null || newIdentity === null || oldIdentity !== newIdentity;
}

/** Who was signed in, in this tab and in storage, when a flow began. */
export type SessionTicket = { generation: number; identity: string | null };

/** The signed-in session in shared storage (user, workspace, session), or null. */
export function storedSessionIdentity(): string | null {
  try {
    return sessionIdentity(localStorage.getItem('deft-refresh-token'));
  } catch {
    return null;
  }
}

/**
 * A session handed back by a slow request (finishing two-step setup) is
 * installed only if nobody signed out or in since the flow began: in this tab
 * (the generation) and in shared storage (the identity, which another tab
 * changes before this tab hears of it). Otherwise it would bring back a
 * session after logout, or replace someone else's.
 */
export function adoptSessionIfCurrent(generation: AuthRequestGeneration, ticket: SessionTicket, currentIdentity: string | null, install: () => void): boolean {
  if (!generation.isCurrent(ticket.generation) || ticket.identity !== currentIdentity) return false;
  install();
  return true;
}

export function isCurrentRefreshStorageEvent(eventValue: string | null, storedValue: string | null): boolean {
  return eventValue === storedValue;
}

export async function revokeWebSessionBestEffort(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = LOGOUT_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  try {
    await fetchImpl(`${apiUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
  } catch {
    // Local logout has already completed; server revocation is best effort.
  } finally {
    clearTimeout(timeout);
  }
}

const AuthContext = createContext<AuthContextType | null>(null);
const AUTH_PAGE_PATHS = new Set([
  '/login',
  '/two-step-setup',
  '/signup',
  '/forgot-password',
  '/reset-password',
]);

export function safePostLoginDestination(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return null;
  }

  try {
    const base = new URL('https://deft.local');
    const destination = new URL(value, base);
    const normalizedPath = destination.pathname.replace(/\/+$/, '') || '/';
    if (destination.origin !== base.origin || AUTH_PAGE_PATHS.has(normalizedPath.toLowerCase())) {
      return null;
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return null;
  }
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [paused, setPaused] = useState<PausedNotice | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionInterrupted, setConnectionInterrupted] = useState(false);
  const [sessionCacheScope, setSessionCacheScope] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  // These public forms do not require an authenticated session. Keeping them
  // mounted retains their in-memory credential while identity checks retry.
  const credentialPage = pathname === '/reset-password' || pathname === '/invite' || pathname?.startsWith('/invite/');
  const authGeneration = useRef(new AuthRequestGeneration());
  const sessionCacheEpoch = useRef(0);
  const identityRequest = useRef<number | null>(null);

  const clearSessionCacheScope = useCallback(() => {
    setActiveSessionCacheScope(null);
    setSessionCacheScope(null);
  }, []);

  const fetchMe = useCallback(async () => {
    const generation = authGeneration.current.capture();
    if (identityRequest.current === generation) return;
    identityRequest.current = generation;
    try {
      const res = await api.fetch('/api/auth/me', { signal: AbortSignal.timeout(10_000) });
      if (!authGeneration.current.isCurrent(generation)) return;
      if (res.ok) {
        const data = await res.json();
        if (!authGeneration.current.isCurrent(generation)) return;
        const cacheScope = createSessionCacheScope({
          accessToken: localStorage.getItem('deft-access-token'),
          authenticatedUserId: data.user.id,
          authenticatedOrgId: data.org.id,
          authEpoch: sessionCacheEpoch.current,
        });
        setActiveSessionCacheScope(cacheScope);
        setSessionCacheScope(cacheScope);
        setUser(data.user);
        setOrg(data.org);
        setPaused(parsePausedNotice(data.paused));
        setConnectionInterrupted(false);
        // Use browser timezone if DB has default 'UTC' (means not yet auto-detected)
        const storedTz = data.user.timezone;
        const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        setUserTimezone(storedTz && storedTz !== 'UTC' ? storedTz : browserTz);
      } else if (res.status === 401 || res.status === 403) {
        setConnectionInterrupted(false);
        clearSessionCacheScope();
        setUser(null);
        setOrg(null);
        setPaused(null);
      } else {
        setConnectionInterrupted(true);
      }
    } catch {
      if (!authGeneration.current.isCurrent(generation)) return;
      // Unavailable identity checks cannot establish either access or logout.
      // Hide workspace content while retrying, retaining credentials and drafts.
      setConnectionInterrupted(true);
    } finally {
      if (identityRequest.current === generation) identityRequest.current = null;
      if (authGeneration.current.isCurrent(generation)) setLoading(false);
    }
  }, [clearSessionCacheScope]);

  useEffect(() => {
    const token = localStorage.getItem('deft-access-token') ?? localStorage.getItem('deft-refresh-token');
    if (token) {
      fetchMe();
    } else {
      clearSessionCacheScope();
      setLoading(false);
    }
  }, [clearSessionCacheScope, fetchMe]);

  useEffect(() => {
    if (!connectionInterrupted) return;
    const retry = () => { if (!document.hidden) void fetchMe(); };
    const timer = setInterval(retry, 5000);
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [connectionInterrupted, fetchMe]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== 'deft-refresh-token') return;
      if (!isCurrentRefreshStorageEvent(event.newValue, localStorage.getItem('deft-refresh-token'))) return;
      if (event.newValue === null) {
        setConnectionInterrupted(false);
        authGeneration.current.advance();
        sessionCacheEpoch.current += 1;
        api.clearTokens();
        disconnectSocket();
        clearSessionCacheScope();
        setUser(null);
        setOrg(null);
        setPaused(null);
        setLoading(false);
        router.replace('/login');
        return;
      }
      const accessToken = localStorage.getItem('deft-access-token');
      if (!accessToken) return;
      api.setTokens(accessToken, event.newValue);
      if (!isCrossTabSessionReplacement(event.oldValue, event.newValue)) return;
      authGeneration.current.advance();
      setConnectionInterrupted(false);
      sessionCacheEpoch.current += 1;
      disconnectSocket();
      clearSessionCacheScope();
      setUser(null);
      setOrg(null);
      setPaused(null);
      setLoading(true);
      void fetchMe();
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [clearSessionCacheScope, fetchMe, router]);

  const login = async (email: string, password: string) => {
    setConnectionInterrupted(false);
    // A sign-in ends any unfinished two-step setup in this tab.
    clearEnrolToken();
    const generation = authGeneration.current.advance();
    sessionCacheEpoch.current += 1;
    api.clearTokens();
    disconnectSocket();
    clearSessionCacheScope();
    setUser(null);
    setOrg(null);
    setPaused(null);
    setLoading(true);
    try {
      const res = await api.post('/api/auth/login', { email, password });
      if (!authGeneration.current.isCurrent(generation)) return;
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Login failed');
      }
      const data = await res.json();
      if (!authGeneration.current.isCurrent(generation)) return;
      // The password was right but the account needs its second step: there
      // is no session yet. A code is asked for on the sign-in page; an
      // owner or admin who must set it up first is sent to do that.
      const pending = readTwoStepPending(data);
      if (pending) {
        setLoading(false);
        if (pending.status === 'enrolment_required') {
          storeEnrolToken(pending.token);
          router.push('/two-step-setup');
          return;
        }
        return pending;
      }
      api.setTokens(data.accessToken, data.refreshToken);
      await fetchMe();
      if (!authGeneration.current.isCurrent(generation)) return;
      const redirect = safePostLoginDestination(
        sessionStorage.getItem('deft-redirect-after-login'),
      );
      sessionStorage.removeItem('deft-redirect-after-login');
      router.push(redirect ?? '/dashboard');
    } catch (error) {
      if (authGeneration.current.isCurrent(generation)) {
        clearSessionCacheScope();
        setUser(null);
        setOrg(null);
        setPaused(null);
        setLoading(false);
      }
      throw error;
    }
  };

  const sessionTicket = (): SessionTicket => ({ generation: authGeneration.current.capture(), identity: storedSessionIdentity() });
  const adoptSession = (ticket: SessionTicket, accessToken: string, refreshToken: string) => adoptSessionIfCurrent(authGeneration.current, ticket, storedSessionIdentity(), () => {
    sessionCacheEpoch.current += 1;
    api.setTokens(accessToken, refreshToken);
  });

  const verifyTwoStep = async (challengeToken: string, proof: { code: string } | { recovery_code: string }) => {
    const generation = authGeneration.current.advance();
    const session = await exchangeTwoStepChallenge(challengeToken, proof);
    if (!authGeneration.current.isCurrent(generation)) return;
    // A recovery code: no session yet. A new authenticator comes first.
    if ('token' in session) {
      storeEnrolToken(session.token, session.reason);
      router.push('/two-step-setup');
      return;
    }
    sessionCacheEpoch.current += 1;
    api.setTokens(session.accessToken, session.refreshToken);
    setLoading(true);
    await fetchMe();
    if (!authGeneration.current.isCurrent(generation)) return;
    const redirect = safePostLoginDestination(
      sessionStorage.getItem('deft-redirect-after-login'),
    );
    sessionStorage.removeItem('deft-redirect-after-login');
    router.push(redirect ?? '/dashboard');
  };

  const signup = async (name: string, email: string, password: string, orgName: string, setupToken?: string) => {
    setConnectionInterrupted(false);
    clearEnrolToken();
    const generation = authGeneration.current.advance();
    sessionCacheEpoch.current += 1;
    api.clearTokens();
    disconnectSocket();
    clearSessionCacheScope();
    setUser(null);
    setOrg(null);
    setPaused(null);
    setLoading(true);
    try {
      // Hosted workspaces: the one-time setup token goes in the body, never in a URL.
      const res = await api.post('/api/auth/signup', signupRequestBody(name, email, password, orgName, setupToken));
      if (!authGeneration.current.isCurrent(generation)) return;
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Signup failed');
      }
      const data = await res.json();
      if (!authGeneration.current.isCurrent(generation)) return;
      // Hosted: the first owner sets up two-step verification before anything else.
      const pending = readTwoStepPending(data);
      if (pending) {
        setLoading(false);
        storeEnrolToken(pending.token);
        sessionStorage.setItem('deft-redirect-after-login', '/setup-ai');
        router.push('/two-step-setup');
        return;
      }
      api.setTokens(data.accessToken, data.refreshToken);
      await fetchMe();
      if (!authGeneration.current.isCurrent(generation)) return;
      router.push('/setup-ai');
    } catch (error) {
      if (authGeneration.current.isCurrent(generation)) {
        clearSessionCacheScope();
        setUser(null);
        setOrg(null);
        setPaused(null);
        setLoading(false);
      }
      throw error;
    }
  };

  const logout = async (options: LogoutOptions = {}) => {
    setConnectionInterrupted(false);
    clearEnrolToken();
    const refreshToken = localStorage.getItem('deft-refresh-token');
    authGeneration.current.advance();
    sessionCacheEpoch.current += 1;
    api.clearTokens();
    disconnectSocket();
    clearSessionCacheScope();
    setUser(null);
    setOrg(null);
    setPaused(null);
    router.replace(options.destination ?? '/login');
    if (refreshToken && options.revokeServer !== false) {
      await revokeWebSessionBestEffort(refreshToken);
    }
  };

  const replaceUser = useCallback((nextUser: User) => {
    setUser(nextUser);
    const storedTz = nextUser.timezone;
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setUserTimezone(storedTz && storedTz !== 'UTC' ? storedTz : browserTz);
  }, []);

  return (
    <AuthContext.Provider value={{ user, org, paused, loading, sessionCacheScope, login, verifyTwoStep, signup, logout, replaceUser, refreshUser: fetchMe, sessionTicket, adoptSession }}>
      {connectionInterrupted && !credentialPage ? <main className="min-h-dvh flex items-center justify-center bg-[var(--background)] p-6 text-[var(--on-surface)]">
        <div className="max-w-sm space-y-4 text-center" role="status">
          <h1 className="text-xl font-semibold">Reconnecting to Deft</h1>
          <p className="text-sm text-[var(--on-surface-variant)]">We can’t reach your workspace. We’ll try again automatically when the connection returns.</p>
          <button type="button" onClick={() => { void fetchMe(); }} className="min-h-11 rounded-full border border-[var(--outline-variant)] px-5 text-sm">Try again</button>
        </div>
      </main> : children}
    </AuthContext.Provider>
  );
}
