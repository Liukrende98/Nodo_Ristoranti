'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

// ─── Types ───────────────────────────────────────────────

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
  tenant: {
    id: string;
    name: string;
    slug: string;
    settings: any;
  };
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
  refreshAuth: async () => {},
});

// ─── API Client ──────────────────────────────────────────

export async function apiFetch(
  url: string,
  options: RequestInit = {}
): Promise<any> {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Auto-refresh on 401
  if (res.status === 401 && !url.includes('/auth/')) {
    const refreshRes = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });

    if (refreshRes.ok) {
      // Retry original request
      const retryRes = await fetch(url, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      if (!retryRes.ok) {
        const err = await retryRes.json().catch(() => ({ error: 'Errore' }));
        throw new Error(err.error || `HTTP ${retryRes.status}`);
      }
      return retryRes.json();
    } else {
      // Refresh failed, redirect to login
      window.location.href = '/login';
      throw new Error('Sessione scaduta');
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Errore di rete' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// ─── Provider ────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshAuth = useCallback(async () => {
    try {
      const data = await apiFetch('/api/auth/me');
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  const login = async (email: string, password: string) => {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setUser(data.user);
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
    window.location.href = '/login';
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export default AuthContext;
