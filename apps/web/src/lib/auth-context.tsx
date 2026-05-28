'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';
import { setUserTimezone } from './time';
import { useRouter } from 'next/navigation';

type User = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  title: string | null;
  status_emoji: string | null;
  status_text: string | null;
  timezone: string | null;
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
    router.push('/dashboard');
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

  return (
    <AuthContext.Provider value={{ user, org, loading, login, signup, logout, refreshUser: fetchMe }}>
      {children}
    </AuthContext.Provider>
  );
}
