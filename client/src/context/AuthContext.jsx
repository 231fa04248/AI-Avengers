import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);
const storedUser = () => { try { return JSON.parse(localStorage.getItem('civicai_user') || 'null'); } catch { return null; } };

export function AuthProvider({ children }) {
  const [user, setUser] = useState(storedUser);
  const [loading, setLoading] = useState(Boolean(localStorage.getItem('civicai_token')));

  useEffect(() => {
    if (!localStorage.getItem('civicai_token')) return setLoading(false);
    api.get('/auth/profile').then(({ data }) => setUser(data.user)).catch(() => { localStorage.clear(); setUser(null); }).finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    localStorage.setItem('civicai_token', data.token); localStorage.setItem('civicai_user', JSON.stringify(data.user)); setUser(data.user); return data.user;
  };
  const register = async (payload) => {
    const { data } = await api.post('/auth/register', payload);
    localStorage.setItem('civicai_token', data.token); localStorage.setItem('civicai_user', JSON.stringify(data.user)); setUser(data.user); return data.user;
  };
  const logout = () => { localStorage.removeItem('civicai_token'); localStorage.removeItem('civicai_user'); setUser(null); };
  const value = useMemo(() => ({ user, loading, login, register, logout, isAuthenticated: Boolean(user) }), [user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }

