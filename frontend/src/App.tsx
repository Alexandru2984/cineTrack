import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { bootstrapSession } from '@/lib/api';
import { Navbar } from '@/components/Navbar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import LoginPage from '@/pages/Login';
import RegisterPage from '@/pages/Register';
import ForgotPasswordPage from '@/pages/ForgotPassword';
import ResetPasswordPage from '@/pages/ResetPassword';
import Dashboard from '@/pages/Dashboard';
import SearchPage from '@/pages/Search';
import MediaDetail from '@/pages/MediaDetail';
import TrackingPage from '@/pages/Tracking';
import StatsPage from '@/pages/Stats';
import ProfilePage from '@/pages/Profile';
import SettingsPage from '@/pages/Settings';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)();
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  // Reset the boundary on navigation so a crashed page recovers once the user
  // moves elsewhere, instead of staying stuck on the fallback.
  const location = useLocation();
  const authStatus = useAuthStore((state) => state.status);

  useEffect(() => {
    void bootstrapSession();
  }, []);

  if (authStatus === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[hsl(var(--background))]">
        <Loader2
          className="h-6 w-6 animate-spin text-[hsl(var(--primary))]"
          aria-label="Loading session"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <Navbar />
      <ErrorBoundary key={location.pathname}>
        <Routes>
          <Route path="/login" element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
          <Route path="/register" element={<PublicOnlyRoute><RegisterPage /></PublicOnlyRoute>} />
          <Route path="/forgot-password" element={<PublicOnlyRoute><ForgotPasswordPage /></PublicOnlyRoute>} />
          <Route path="/reset-password" element={<PublicOnlyRoute><ResetPasswordPage /></PublicOnlyRoute>} />
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/search" element={<ProtectedRoute><SearchPage /></ProtectedRoute>} />
          <Route path="/media/:id" element={<ProtectedRoute><MediaDetail /></ProtectedRoute>} />
          <Route path="/tracking" element={<ProtectedRoute><TrackingPage /></ProtectedRoute>} />
          <Route path="/stats" element={<ProtectedRoute><StatsPage /></ProtectedRoute>} />
          <Route path="/profile/:username" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        </Routes>
      </ErrorBoundary>
    </div>
  );
}
