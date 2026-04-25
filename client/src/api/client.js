import axios from 'axios';

// In dev, Vite proxies `/api` → http://localhost:4000. In prod, set
// VITE_API_BASE_URL (e.g. https://gcig-api.onrender.com) at build time.
const BASE =
  (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '') + '/api';

export const API_BASE = BASE;

const api = axios.create({ baseURL: BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('gcig_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Silent token rotation. The server's verifyJwt middleware sets
// `X-New-Token` on responses whenever the caller's JWT is past its
// 12h half-life. We swap it into localStorage transparently so the
// next request carries the fresh token — active users never hit the
// 24h expiration, inactive users do (which is the whole point).
//
// Only rotate on actual 2xx responses. Error responses (401/403/etc.)
// can't have come from a successful verifyJwt → no valid X-New-Token
// could have been set. Reading from those responses risks writing
// garbage into localStorage from a malicious or buggy reverse proxy.
function maybeRotateToken(res) {
  if (!res || res.status < 200 || res.status >= 300) return;
  const fresh =
    res?.headers?.['x-new-token'] || res?.headers?.['X-New-Token'];
  if (fresh && typeof fresh === 'string' && fresh.length > 20) {
    const prev = localStorage.getItem('gcig_token');
    if (fresh !== prev) {
      localStorage.setItem('gcig_token', fresh);
    }
  }
}

// Wall-clock of the most recent successful response. Used to ignore
// "stale 401" races: when we just toggle 2FA / change password / log
// out everywhere, the SERVER bumps tokenVersion mid-flight. Any
// concurrent in-flight request carrying the OLD token then 401s. If
// we treated those 401s as "session ended" we'd wipe localStorage
// even though the user just got a fresh token from the same flow.
//
// The grace window means: if anything succeeded in the last 8s, we
// trust the session and ignore the lone 401.
let lastSuccessAt = 0;
const STALE_401_WINDOW_MS = 8_000;

api.interceptors.response.use(
  (res) => {
    lastSuccessAt = Date.now();
    maybeRotateToken(res);
    return res;
  },
  (err) => {
    if (err.response?.status === 401) {
      const recentlyValid =
        lastSuccessAt > 0 && Date.now() - lastSuccessAt < STALE_401_WINDOW_MS;
      if (recentlyValid) {
        // Stale-request race — concurrent in-flight request hit a
        // tokenVersion bump it didn't know about. The token in
        // localStorage is fresh from the same flow. Reject the
        // promise so the caller sees the failure but DON'T nuke the
        // session — that would kick the user out of an otherwise
        // healthy login.
        return Promise.reject(err);
      }
      localStorage.removeItem('gcig_token');
      localStorage.removeItem('gcig_user');
      const path = window.location.pathname;
      const publicPaths = ['/login', '/accept-invite', '/forgot-password', '/reset-password'];
      if (!publicPaths.includes(path)) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
