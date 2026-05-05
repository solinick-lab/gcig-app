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
    // Safari has occasionally been observed to leave malformed JSON in
    // localStorage after a forced reload mid-write. Treat any parse
    // failure as "no user" instead of crashing the whole app — the
    // /auth/me call below will recover if a valid token is present.
    const raw = localStorage.getItem('gcig_user');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      localStorage.removeItem('gcig_user');
      return null;
    }
  });
  const [loading, setLoading] = useState(!!localStorage.getItem('gcig_token'));

  useEffect(() => {
    const initialToken = localStorage.getItem('gcig_token');
    if (!initialToken) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then((res) => {
        // 304 with an empty body would set user to undefined and kick
        // the user to /login on the next render. The /auth/me route
        // sets Cache-Control: no-store so 304 shouldn't happen here,
        // but be defensive in case a proxy or older deploy serves one.
        if (!res || !res.data || typeof res.data !== 'object') return;
        setUser(res.data);
        localStorage.setItem('gcig_user', JSON.stringify(res.data));
      })
      .catch(() => {
        // Only clear if the token in localStorage is still the one we
        // sent. If something else (e.g. a concurrent Google sign-in)
        // wrote a fresh token mid-flight, this 401 is for the OLD
        // session — clearing would clobber the new login and kick the
        // user out on their first click.
        if (localStorage.getItem('gcig_token') !== initialToken) return;
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

  async function googleSignIn(credential) {
    const res = await api.post('/auth/google', { credential });
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
  const isAdvisory =
    user?.role === 'AdvisoryBoardMember' || user?.role === 'FacultyAdvisory';
  // Owner-only tier above President. Identified by email via SUPER_ADMIN_EMAIL
  // on the server. Gates irreversible / sensitive operations.
  const isSuperAdmin = !!user?.isSuperAdmin;

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        verifyTwoFactor,
        googleSignIn,
        signup,
        verify,
        resendCode,
        forgotPassword,
        resetPassword,
        logout,
        logoutEverywhere,
        isAdmin,
        isExecutive,
        isAdvisory,
        isSuperAdmin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
