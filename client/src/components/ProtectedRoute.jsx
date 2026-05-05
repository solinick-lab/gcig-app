import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  // While AuthProvider is still verifying a stored token (initial /auth/me
  // call), don't make a routing decision — neither flash the dashboard
  // (we don't know if they're authenticated) nor bounce to login (we'd
  // kick out a perfectly valid session that's just still loading). App.jsx
  // already shows a loading screen at this stage.
  if (loading) return null;
  // Belt-and-suspenders: if React state hasn't propagated yet (post-login
  // reload, render-timing edge cases on Safari) but a token + user are
  // sitting in localStorage, treat that as authenticated. AuthProvider
  // will catch up on the next render. Without this fallback, a single
  // unlucky render cycle bounces a freshly-logged-in user back to /login.
  if (!user) {
    const hasToken = !!localStorage.getItem('gcig_token');
    const hasUser = !!localStorage.getItem('gcig_user');
    if (hasToken && hasUser) return children;
    return <Navigate to="/login" replace />;
  }
  return children;
}
