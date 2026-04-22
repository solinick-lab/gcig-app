import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Login from './pages/Login.jsx';
import AcceptInvite from './pages/AcceptInvite.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import AuditLog from './pages/AuditLog.jsx';
import Chat from './pages/Chat.jsx';
import InactivityTimer from './components/InactivityTimer.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Calendar from './pages/Calendar.jsx';
import PreviousPitches from './pages/PreviousPitches.jsx';
import Portfolio from './pages/Portfolio.jsx';
import Reports from './pages/Reports.jsx';
import Attendance from './pages/Attendance.jsx';
import Members from './pages/Members.jsx';
import Profile from './pages/Profile.jsx';
import Votes from './pages/Votes.jsx';
import Industries from './pages/Industries.jsx';
import Library from './pages/Library.jsx';
import Admin from './pages/Admin.jsx';
import PitchOutcomes from './pages/PitchOutcomes.jsx';
import Broadcast from './pages/Broadcast.jsx';
import AiChat from './pages/AiChat.jsx';
import Landing from './pages/Landing.jsx';

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
    <>
      <InactivityTimer />
      <Routes>
      {/* Public */}
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      {/* Authed app */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/calendar" element={<Calendar />} />
        {/* Legacy routes — keep so old bookmarks/links still work */}
        <Route path="/pitches" element={<Calendar />} />
        <Route path="/events" element={<Calendar />} />
        <Route path="/outcomes" element={<PitchOutcomes />} />
        <Route path="/library" element={<Library />} />
        <Route path="/admin" element={<Admin />} />
        {/* Legacy routes — keep old bookmarks working */}
        <Route path="/archive" element={<Library />} />
        <Route path="/reports" element={<Library />} />
        <Route path="/members" element={<Admin />} />
        <Route path="/audit" element={<Admin />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/votes" element={<Votes />} />
        <Route path="/industries" element={<Industries />} />
        <Route path="/attendance" element={<Attendance />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/broadcast" element={<Broadcast />} />
        <Route path="/ai-chat" element={<AiChat />} />
        <Route path="/profile" element={<Profile />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
