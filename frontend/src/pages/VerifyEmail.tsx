import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useVerifyEmail } from '@/hooks/useAuth';
import { useAuthStore } from '@/store/auth';
import { getApiErrorMessage } from '@/lib/api';
import { CheckCircle2, Film, Loader2, XCircle } from 'lucide-react';

export default function VerifyEmailPage() {
  const [token] = useState(() => {
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
    const legacyQueryToken = new URLSearchParams(window.location.search).get('token');
    return fragmentToken ?? legacyQueryToken ?? '';
  });
  const isAuthenticated = useAuthStore((s) => s.status === 'authenticated');
  const verify = useVerifyEmail();
  // Guard against React 18 StrictMode double-invoking the effect in dev, which
  // would consume the one-time token twice and surface a spurious failure.
  const attempted = useRef(false);

  useEffect(() => {
    if (window.location.hash || window.location.search.includes('token=')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (token && !attempted.current) {
      attempted.current = true;
      verify.mutate({ token });
    }
  }, [token, verify]);

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 md:min-h-[calc(100dvh-4rem)]">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <Film className="mx-auto h-12 w-12 text-[hsl(var(--primary))]" />
          <h1 className="mt-4 text-3xl font-bold">Confirm your email</h1>
        </div>

        {!token ? (
          <div className="rounded-md border border-[hsl(var(--border))] p-4 text-sm text-[hsl(var(--destructive))]">
            This confirmation link is missing its token. Open the most recent link from your
            inbox, or request a new one from your account settings.
          </div>
        ) : verify.isPending ? (
          <div className="flex items-center justify-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Loader2 className="h-5 w-5 animate-spin" /> Confirming your email…
          </div>
        ) : verify.isSuccess ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-4 text-sm">
              <CheckCircle2 className="h-5 w-5 text-[hsl(var(--primary))]" />
              Your email is confirmed. Thanks!
            </div>
            <Link
              to={isAuthenticated ? '/' : '/login'}
              className="inline-block rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {isAuthenticated ? 'Go to your dashboard' : 'Sign in'}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--border))] p-4 text-sm text-[hsl(var(--destructive))]">
              <XCircle className="h-5 w-5" />
              {getApiErrorMessage(verify.error, 'This confirmation link is invalid or has expired.')}
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              You can request a fresh link from your account settings after signing in.
            </p>
            <Link
              to={isAuthenticated ? '/settings' : '/login'}
              className="inline-block rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))]"
            >
              {isAuthenticated ? 'Go to settings' : 'Sign in'}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
