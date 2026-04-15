import { useAuth } from '../context/AuthContext.jsx';

export default function AdminOnly({ children, fallback = null }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return fallback;
  return children;
}
