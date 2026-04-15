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

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('gcig_token');
      localStorage.removeItem('gcig_user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
