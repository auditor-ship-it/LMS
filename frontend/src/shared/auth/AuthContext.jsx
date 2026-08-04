import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as authApi from './auth.api.js';
import { getStoredToken, setStoredToken, registerUnauthorizedHandler } from './client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // { empId, name, email }
  const [access, setAccess] = useState({ perms: {}, sidebar: {} });
  const [loading, setLoading] = useState(true);

  const clearSession = useCallback(() => {
    setStoredToken('');
    setUser(null);
    setAccess({ perms: {}, sidebar: {} });
  }, []);

  useEffect(() => {
    registerUnauthorizedHandler(clearSession);
  }, [clearSession]);

  const loadSession = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const [meRes, bundle] = await Promise.all([authApi.me(), authApi.accessBundle()]);
      setUser(meRes);
      setAccess(bundle);
    } catch (e) {
      clearSession();
    } finally {
      setLoading(false);
    }
  }, [clearSession]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Heartbeat every minute while logged in — mirrors the original's empHeartbeat ping.
  useEffect(() => {
    if (!user) return undefined;
    const id = setInterval(() => {
      authApi.heartbeat().catch(() => {});
    }, 60000);
    return () => clearInterval(id);
  }, [user]);

  const login = useCallback(async (empId, password) => {
    const res = await authApi.login(empId, password);
    if (!res.ok) return res;
    setStoredToken(res.token);
    const bundle = await authApi.accessBundle();
    setUser({ empId: res.empId, name: res.name, email: res.email });
    setAccess(bundle);
    return res;
  }, []);

  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch (e) { /* best-effort, matches original */ }
    clearSession();
  }, [clearSession]);

  const value = useMemo(() => ({
    user,
    loading,
    perms: access.perms || {},
    sidebar: access.sidebar || {},
    isAuthenticated: !!user,
    login,
    logout,
    reload: loadSession
  }), [user, loading, access, login, logout, loadSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
