'use client';

import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api';
import { setUserTimezone } from './time';
import { useRouter } from 'next/navigation';
import { disconnectSocket } from './socket';

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
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string, orgName: string) => Promise<void>;
  logout: (options?: LogoutOptions) => Promise<void>;
  replaceUser: (nextUser: User) => void;
  refreshUser: () => Promise<void>;
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
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const authGeneration = useRef(new AuthRequestGeneration());

  const fetchMe = useCallback(async () => {
    const generation = authGeneration.current.capture();
    try {
      const res = await api.get('/api/auth/me');
      if (!authGeneration.current.isCurrent(generation)) return;
      if (res.ok) {
        const data = await res.json();
        if (!authGeneration.current.isCurrent(generation)) return;
        setUser(data.user);
        setOrg(data.org);
        // Use browser timezone if DB has default 'UTC' (means not yet auto-detected)
        const storedTz = data.user.timezone;
        const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        setUserTimezone(storedTz && storedTz !== 'UTC' ? storedTz : browserTz);
      } else if (res.status === 429) {
        console.warn('[auth] /me rate limited; preserving current session state');
      } else {
        setUser(null);
        setOrg(null);
      }
    } catch {
      if (!authGeneration.current.isCurrent(generation)) return;
      setUser(null);
      setOrg(null);
    } finally {
      if (authGeneration.current.isCurrent(generation)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (token) {
      fetchMe();
    } else {
      setLoading(false);
    }
  }, [fetchMe]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== 'deft-refresh-token') return;
      if (!isCurrentRefreshStorageEvent(event.newValue, localStorage.getItem('deft-refresh-token'))) return;
      if (event.newValue === null) {
        authGeneration.current.advance();
        api.clearTokens();
        disconnectSocket();
        setUser(null);
        setOrg(null);
        setLoading(false);
        router.replace('/login');
        return;
      }
      const accessToken = localStorage.getItem('deft-access-token');
      if (!accessToken) return;
      api.setTokens(accessToken, event.newValue);
      if (!isCrossTabSessionReplacement(event.oldValue, event.newValue)) return;
      authGeneration.current.advance();
      disconnectSocket();
      setUser(null);
      setOrg(null);
      setLoading(true);
      void fetchMe();
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [fetchMe, router]);

  const login = async (email: string, password: string) => {
    const generation = authGeneration.current.advance();
    const res = await api.post('/api/auth/login', { email, password });
    if (!authGeneration.current.isCurrent(generation)) return;
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    if (!authGeneration.current.isCurrent(generation)) return;
    api.setTokens(data.accessToken, data.refreshToken);
    await fetchMe();
    if (!authGeneration.current.isCurrent(generation)) return;
    const redirect = safePostLoginDestination(
      sessionStorage.getItem('deft-redirect-after-login'),
    );
    sessionStorage.removeItem('deft-redirect-after-login');
    router.push(redirect ?? '/dashboard');
  };

  const signup = async (name: string, email: string, password: string, orgName: string) => {
    const generation = authGeneration.current.advance();
    const res = await api.post('/api/auth/signup', { name, email, password, org_name: orgName });
    if (!authGeneration.current.isCurrent(generation)) return;
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Signup failed');
    }
    const data = await res.json();
    if (!authGeneration.current.isCurrent(generation)) return;
    api.setTokens(data.accessToken, data.refreshToken);
    await fetchMe();
    if (!authGeneration.current.isCurrent(generation)) return;
    router.push('/setup-ai');
  };

  const logout = async (options: LogoutOptions = {}) => {
    const refreshToken = localStorage.getItem('deft-refresh-token');
    authGeneration.current.advance();
    api.clearTokens();
    disconnectSocket();
    setUser(null);
    setOrg(null);
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
    <AuthContext.Provider value={{ user, org, loading, login, signup, logout, replaceUser, refreshUser: fetchMe }}>
      {children}
    </AuthContext.Provider>
  );
}
