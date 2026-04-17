import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/client.js';

const AuthContext = createContext(null);

function saveSession(token, user) {
  localStorage.setItem('gcig_token', token);
  localStorage.setItem('gcig_user', JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem('gcig_token');
  localStorage.removeItem('gcig_user');
}

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
        clearSession();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  // Returns either { user } on full success, or { twoFactorRequired, challengeToken }
  // when the user has 2FA enabled. The caller then collects a code and calls
  // verifyTwoFactor().
  async function login(email, password) {
    const res = await api.post('/auth/login', { email, password });
    if (res.data.twoFactorRequired) {
      return {
        twoFactorRequired: true,
        challengeToken: res.data.challengeToken,
        methods: res.data.methods || {}, // { totp: bool, email: bool }
      };
    }
    saveSession(res.data.token, res.data.user);
    setUser(res.data.user);
    return { user: res.data.user };
  }

  async function verifyTwoFactor(challengeToken, code) {
    const res = await api.post('/2fa/login', { challengeToken, code });
    saveSession(res.data.token, res.data.user);
    setUser(res.data.user);
    return res.data.user;
  }

  async function signup(name, email, password) {
    const res = await api.post('/auth/signup', { name, email, password });
    return res.data;
  }

  async function verify(email, code) {
    const res = await api.post('/auth/verify', { email, code });
    saveSession(res.data.token, res.data.user);
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
    clearSession();
    setUser(null);
  }

  async function logoutEverywhere() {
    await api.post('/auth/logout-everywhere');
    clearSession();
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
        verifyTwoFactor,
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
