import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { bootstrapSession } from '@/lib/api';
import { Navbar } from '@/components/Navbar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MobileTabBar } from '@/components/MobileTabBar';
import { EmailVerificationBanner } from '@/components/EmailVerificationBanner';
import { loginPathFor, safeReturnTo } from '@/lib/navigation';

const LoginPage = lazy(() => import('@/pages/Login'));
const RegisterPage = lazy(() => import('@/pages/Register'));
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPassword'));
const ResetPasswordPage = lazy(() => import('@/pages/ResetPassword'));
const VerifyEmailPage = lazy(() => import('@/pages/VerifyEmail'));
const ConfirmEmailChangePage = lazy(() => import('@/pages/ConfirmEmailChange'));
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const SearchPage = lazy(() => import('@/pages/Search'));
const CalendarPage = lazy(() => import('@/pages/Calendar'));
const MediaDetail = lazy(() => import('@/pages/MediaDetail'));
const EpisodeDetailPage = lazy(() => import('@/pages/EpisodeDetail'));
const TrackingPage = lazy(() => import('@/pages/Tracking'));
const StatsPage = lazy(() => import('@/pages/Stats'));
const WrappedPage = lazy(() => import('@/pages/Wrapped'));
const ProfilePage = lazy(() => import('@/pages/Profile'));
const SettingsPage = lazy(() => import('@/pages/Settings'));
const NotificationsPage = lazy(() => import('@/pages/Notifications'));
const ListsPage = lazy(() => import('@/pages/Lists'));
const ListDetailPage = lazy(() => import('@/pages/ListDetail'));
const AboutPage = lazy(() => import('@/pages/About'));
const PrivacyPage = lazy(() => import('@/pages/Privacy'));
const AccountDeletionPage = lazy(() => import('@/pages/AccountDeletion'));

function PageLoader() {
  return (
    <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center">
      <Loader2
        className="h-6 w-6 animate-spin text-[hsl(var(--primary))]"
        aria-label="Loading page"
      />
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)();
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  if (!isAuthenticated) return <Navigate to={loginPathFor(returnTo)} replace />;
  return <>{children}</>;
}

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)();
  const location = useLocation();
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'));
  if (isAuthenticated) return <Navigate to={returnTo} replace />;
  return <>{children}</>;
}

export default function App() {
  // Reset the boundary on navigation so a crashed page recovers once the user
  // moves elsewhere, instead of staying stuck on the fallback.
  const location = useLocation();
  const authStatus = useAuthStore((state) => state.status);
  const authenticated = authStatus === 'authenticated';

  useEffect(() => {
    void bootstrapSession();
  }, []);

  if (authStatus === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[hsl(var(--background))]">
        <Loader2
          className="h-6 w-6 animate-spin text-[hsl(var(--primary))]"
          aria-label="Loading session"
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <Navbar />
      {authenticated && <EmailVerificationBanner />}
      <main
        className={`flex-1 ${
          authenticated
            ? 'pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0'
            : ''
        }`}
      >
        <ErrorBoundary key={location.pathname}>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/login" element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
              <Route path="/register" element={<PublicOnlyRoute><RegisterPage /></PublicOnlyRoute>} />
              <Route path="/forgot-password" element={<PublicOnlyRoute><ForgotPasswordPage /></PublicOnlyRoute>} />
              <Route path="/reset-password" element={<PublicOnlyRoute><ResetPasswordPage /></PublicOnlyRoute>} />
              {/* Reachable whether or not a session is active — a user may open the link on any device. */}
              <Route path="/verify-email" element={<VerifyEmailPage />} />
              {/* Not PublicOnly: the link is opened from an inbox, which may or
                  may not be the browser holding the session. */}
              <Route path="/confirm-email-change" element={<ConfirmEmailChangePage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/account-deletion" element={<AccountDeletionPage />} />
              <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
              <Route path="/search" element={<ProtectedRoute><SearchPage /></ProtectedRoute>} />
              <Route path="/calendar" element={<ProtectedRoute><CalendarPage /></ProtectedRoute>} />
              <Route path="/media/:id" element={<ProtectedRoute><MediaDetail /></ProtectedRoute>} />
              <Route path="/episodes/:id" element={<ProtectedRoute><EpisodeDetailPage /></ProtectedRoute>} />
              <Route path="/tracking" element={<ProtectedRoute><TrackingPage /></ProtectedRoute>} />
              <Route path="/stats" element={<ProtectedRoute><StatsPage /></ProtectedRoute>} />
              <Route path="/wrapped" element={<ProtectedRoute><WrappedPage /></ProtectedRoute>} />
              <Route path="/profile/:username" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
              <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />
              <Route path="/lists" element={<ProtectedRoute><ListsPage /></ProtectedRoute>} />
              <Route path="/lists/:id" element={<ListDetailPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      {authenticated && <MobileTabBar />}
    </div>
  );
}
