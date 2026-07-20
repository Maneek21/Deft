'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';
import { setUserTimezone } from './time';
import { useRouter } from 'next/navigation';

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
  logout: () => void;
  replaceUser: (nextUser: User) => void;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

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

  const fetchMe = useCallback(async () => {
    try {
      const res = await api.get('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
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
      setUser(null);
      setOrg(null);
    } finally {
      setLoading(false);
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

  const login = async (email: string, password: string) => {
    const res = await api.post('/api/auth/login', { email, password });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    api.setTokens(data.accessToken, data.refreshToken);
    await fetchMe();
    const redirect = sessionStorage.getItem('deft-redirect-after-login');
    if (redirect) {
      sessionStorage.removeItem('deft-redirect-after-login');
      router.push(redirect);
    } else {
      router.push('/dashboard');
    }
  };

  const signup = async (name: string, email: string, password: string, orgName: string) => {
    const res = await api.post('/api/auth/signup', { name, email, password, org_name: orgName });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Signup failed');
    }
    const data = await res.json();
    api.setTokens(data.accessToken, data.refreshToken);
    await fetchMe();
    router.push('/setup-ai');
  };

  const logout = async () => {
    const refreshToken = localStorage.getItem('deft-refresh-token');
    if (refreshToken) {
      // Best-effort server-side revocation — ignore failures so client still clears
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      await fetch(`${apiUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    }
    api.clearTokens();
    setUser(null);
    setOrg(null);
    router.push('/login');
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
