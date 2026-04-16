import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Login from './pages/Login.jsx';
import AcceptInvite from './pages/AcceptInvite.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Pitches from './pages/Pitches.jsx';
import Events from './pages/Events.jsx';
import PreviousPitches from './pages/PreviousPitches.jsx';
import Portfolio from './pages/Portfolio.jsx';
import Reports from './pages/Reports.jsx';
import Attendance from './pages/Attendance.jsx';
import Members from './pages/Members.jsx';
import Profile from './pages/Profile.jsx';
import Votes from './pages/Votes.jsx';

export default function App() {
  const { loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-navy">
        Loading…
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="pitches" element={<Pitches />} />
        <Route path="events" element={<Events />} />
        <Route path="archive" element={<PreviousPitches />} />
        <Route path="portfolio" element={<Portfolio />} />
        <Route path="votes" element={<Votes />} />
        <Route path="reports" element={<Reports />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="members" element={<Members />} />
        <Route path="profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
