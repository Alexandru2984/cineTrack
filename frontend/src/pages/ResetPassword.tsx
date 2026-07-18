import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useResetPassword } from '@/hooks/useAuth';
import { getApiErrorMessage } from '@/lib/api';
import { Film, Loader2 } from 'lucide-react';

export default function ResetPasswordPage() {
  const [token] = useState(() => {
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
    const legacyQueryToken = new URLSearchParams(window.location.search).get('token');
    return fragmentToken ?? legacyQueryToken ?? '';
  });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const reset = useResetPassword();
  const navigate = useNavigate();

  useEffect(() => {
    if (window.location.hash || window.location.search.includes('token=')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    reset.mutate(
      { token, new_password: password },
      { onSuccess: () => setTimeout(() => navigate('/login'), 1500) }
    );
  };

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 md:min-h-[calc(100dvh-4rem)]">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <Film className="mx-auto h-12 w-12 text-[hsl(var(--primary))]" />
          <h1 className="mt-4 text-3xl font-bold">Choose a new password</h1>
        </div>

        {!token ? (
          <div className="rounded-md border border-[hsl(var(--border))] p-4 text-center text-sm text-[hsl(var(--destructive))]">
            This reset link is missing its token. Request a new one from the{' '}
            <Link to="/forgot-password" className="text-[hsl(var(--primary))] hover:underline">
              forgot password
            </Link>{' '}
            page.
          </div>
        ) : reset.isSuccess ? (
          <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-4 text-center text-sm">
            Password updated. Redirecting you to sign in…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="reset-new-password" className="block text-sm font-medium mb-1">New password</label>
              <input
                id="reset-new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
                placeholder="Min 8 characters"
              />
            </div>
            <div>
              <label htmlFor="reset-confirm-password" className="block text-sm font-medium mb-1">Confirm new password</label>
              <input
                id="reset-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
                placeholder="Repeat new password"
              />
            </div>

            {mismatch && (
              <p className="text-sm text-[hsl(var(--destructive))]">Passwords do not match</p>
            )}
            {reset.error && (
              <p className="text-sm text-[hsl(var(--destructive))]">
                {getApiErrorMessage(reset.error, 'Could not reset password')}
              </p>
            )}

            <button
              type="submit"
              disabled={reset.isPending}
              className="w-full rounded-md bg-[hsl(var(--primary))] py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {reset.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Set new password
            </button>
          </form>
        )}

        <p className="text-center text-sm text-[hsl(var(--muted-foreground))]">
          <Link to="/login" className="text-[hsl(var(--primary))] hover:underline">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
