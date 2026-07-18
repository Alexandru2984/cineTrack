import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForgotPassword } from '@/hooks/useAuth';
import { getApiErrorMessage } from '@/lib/api';
import { Film, Loader2, MailCheck } from 'lucide-react';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const forgot = useForgotPassword();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    forgot.mutate({ email });
  };

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 md:min-h-[calc(100dvh-4rem)]">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <Film className="mx-auto h-12 w-12 text-[hsl(var(--primary))]" />
          <h1 className="mt-4 text-3xl font-bold">Reset password</h1>
          <p className="mt-2 text-[hsl(var(--muted-foreground))]">
            Enter your email and we'll send you a reset link
          </p>
        </div>

        {forgot.isSuccess ? (
          <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-4 text-center text-sm">
            <MailCheck className="mx-auto mb-2 h-8 w-8 text-[hsl(var(--primary))]" />
            If that email is registered, a reset link is on its way. Check your inbox.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="forgot-password-email" className="block text-sm font-medium mb-1">Email</label>
              <input
                id="forgot-password-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
                placeholder="you@example.com"
              />
            </div>

            {forgot.error && (
              <p className="text-sm text-[hsl(var(--destructive))]">
                {getApiErrorMessage(forgot.error, 'Something went wrong')}
              </p>
            )}

            <button
              type="submit"
              disabled={forgot.isPending}
              className="w-full rounded-md bg-[hsl(var(--primary))] py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {forgot.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Send reset link
            </button>
          </form>
        )}

        <p className="text-center text-sm text-[hsl(var(--muted-foreground))]">
          Remembered it?{' '}
          <Link to="/login" className="text-[hsl(var(--primary))] hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
