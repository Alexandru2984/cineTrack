import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { Navbar } from '@/components/Navbar';
import LoginPage from '@/pages/Login';
import RegisterPage from '@/pages/Register';
import Dashboard from '@/pages/Dashboard';
import SearchPage from '@/pages/Search';
import MediaDetail from '@/pages/MediaDetail';
import TrackingPage from '@/pages/Tracking';
import StatsPage from '@/pages/Stats';
import ProfilePage from '@/pages/Profile';

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
  return (
    <div className="min-h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <Navbar />
      <Routes>
        <Route path="/login" element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
        <Route path="/register" element={<PublicOnlyRoute><RegisterPage /></PublicOnlyRoute>} />
        <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/search" element={<ProtectedRoute><SearchPage /></ProtectedRoute>} />
        <Route path="/media/:id" element={<ProtectedRoute><MediaDetail /></ProtectedRoute>} />
        <Route path="/tracking" element={<ProtectedRoute><TrackingPage /></ProtectedRoute>} />
        <Route path="/stats" element={<ProtectedRoute><StatsPage /></ProtectedRoute>} />
        <Route path="/profile/:username" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
      </Routes>
    </div>
  );
}
