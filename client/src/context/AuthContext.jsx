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
    // Snapshot the token at the very start. If it changes mid-flight
    // (e.g. user completes a Google sign-in while /auth/me is still
    // pending — easy on Safari, where the first fetch can take a
    // moment), we ignore the response. Otherwise a stale-token 401
    // would clobber the fresh login by running clearSession in the
    // catch, kicking the user out on their first click.
    const initialToken = localStorage.getItem('gcig_token');
    if (!initialToken) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then((res) => {
        if (localStorage.getItem('gcig_token') !== initialToken) return;
        setUser(res.data);
        localStorage.setItem('gcig_user', JSON.stringify(res.data));
      })
      .catch(() => {
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
