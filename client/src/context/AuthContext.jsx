import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('gcig_user');
    return raw ? JSON.parse(raw) : null;
  });
  const [loading, setLoading] = useState(!!localStorage.getItem('gcig_token'));

  useEffect(() => {
    const token = localStorage.getItem('gcig_token');
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then((res) => {
        setUser(res.data);
        localStorage.setItem('gcig_user', JSON.stringify(res.data));
      })
      .catch(() => {
        localStorage.removeItem('gcig_token');
        localStorage.removeItem('gcig_user');
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password });
    localStorage.setItem('gcig_token', res.data.token);
    localStorage.setItem('gcig_user', JSON.stringify(res.data.user));
    setUser(res.data.user);
    return res.data.user;
  }

  async function signup(name, email, password) {
    const res = await api.post('/auth/signup', { name, email, password });
    return res.data; // { message, email } — no token yet, needs verification
  }

  async function verify(email, code) {
    const res = await api.post('/auth/verify', { email, code });
    localStorage.setItem('gcig_token', res.data.token);
    localStorage.setItem('gcig_user', JSON.stringify(res.data.user));
    setUser(res.data.user);
    return res.data.user;
  }

  async function resendCode(email) {
    const res = await api.post('/auth/resend-code', { email });
    return res.data;
  }

  function logout() {
    localStorage.removeItem('gcig_token');
    localStorage.removeItem('gcig_user');
    setUser(null);
  }

  const isAdmin = user?.role === 'President';

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, verify, resendCode, logout, isAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
