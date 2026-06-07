import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import TerminalShell from '../terminal/TerminalShell.jsx';
import '../terminal/theme.css';

// Terminal page. Gated to Executive (President/CIO) and Advisory Board /
// Faculty Advisor; will open up to PM+ once we have load-test confidence.
// Renders full-bleed by hiding the standard app chrome via the
// `data-theme="terminal"` wrapper.

export default function Terminal() {
  const { user, isExecutive, isAdvisory } = useAuth();
  const navigate = useNavigate();

  // Hide page scroll while terminal is mounted (we own the whole viewport).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!user) return <Navigate to="/login" replace />;
  if (!isExecutive && !isAdvisory) return <Navigate to="/dashboard" replace />;

  return <TerminalShell onExit={() => navigate('/dashboard')} />;
}
