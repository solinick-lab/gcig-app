import axios from 'axios';

// In dev, Vite proxies `/api` → http://localhost:4000. In prod, set
// VITE_API_BASE_URL (e.g. https://gcig-api.onrender.com) at build time.
const BASE =
  (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '') + '/api';

export const API_BASE = BASE;

// withCredentials: true so the httpOnly session cookie travels on every
// cross-origin request.
const api = axios.create({ baseURL: BASE, withCredentials: true });

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // Clear any legacy localStorage state, then redirect to login.
      localStorage.removeItem('gcig_token');
      localStorage.removeItem('gcig_user');
      if (
        window.location.pathname !== '/login' &&
        window.location.pathname !== '/accept-invite' &&
        window.location.pathname !== '/reset-password' &&
        window.location.pathname !== '/forgot-password'
      ) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
