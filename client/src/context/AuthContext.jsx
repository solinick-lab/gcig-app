import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On mount, ask the server who we are. If the session cookie is valid it
  // responds with the user. Otherwise we stay logged out.
  useEffect(() => {
    api
      .get('/auth/me')
      .then((res) => setUser(res.data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password });
    setUser(res.data.user);
    return res.data.user;
  }

  async function signup(name, email, password) {
    const res = await api.post('/auth/signup', { name, email, password });
    return res.data; // { message, email } — no cookie yet, needs verification
  }

  async function verify(email, code) {
    const res = await api.post('/auth/verify', { email, code });
    setUser(res.data.user);
    return res.data.user;
  }

  async function resendCode(email) {
    const res = await api.post('/auth/resend-code', { email });
    return res.data;
  }

  async function forgotPassword(email) {
    await api.post('/auth/forgot-password', { email });
  }

  async function resetPassword(token, password) {
    await api.post(`/auth/reset/${token}`, { password });
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    setUser(null);
  }

  async function logoutEverywhere() {
    await api.post('/auth/logout-everywhere');
    setUser(null);
  }

  const isAdmin = user?.role === 'President';
  const isExecutive = user?.role === 'President' || user?.role === 'CIO';

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        signup,
        verify,
        resendCode,
        forgotPassword,
        resetPassword,
        logout,
        logoutEverywhere,
        isAdmin,
        isExecutive,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
