import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useMutationState } from '@tanstack/react-query';
import {
  CONFIRM_EMAIL_CHANGE_MUTATION_KEY,
  useConfirmEmailChange,
} from '@/hooks/useAuth';
import { useAuthStore } from '@/store/auth';
import { getApiErrorMessage } from '@/lib/api';
import { readFragmentOneTimeToken, scrubOneTimeTokenUrl } from '@/lib/oneTimeToken';
import { CheckCircle2, Film, Loader2, XCircle } from 'lucide-react';

/**
 * Same one-time-token handling as `VerifyEmail`, and for the same reasons: the
 * token exists only in the URL and is stripped on mount so it cannot leak
 * through history or a screenshot, while the token and the "already sent" flag
 * live at module scope because React remounts this route (StrictMode, and the
 * session bootstrap swapping the tree) and a component-scoped copy would be
 * discarded mid-request, leaving the page spinning forever.
 */
let capturedToken: string | null = null;
let submitted = false;

function readTokenOnce(): string {
  if (capturedToken === null) {
    capturedToken = readFragmentOneTimeToken(window.location.hash);
  }
  return capturedToken;
}

export default function ConfirmEmailChangePage() {
  const token = readTokenOnce();
  const isAuthenticated = useAuthStore((s) => s.status === 'authenticated');
  const confirm = useConfirmEmailChange();
  const attempt = useMutationState({
    filters: { mutationKey: CONFIRM_EMAIL_CHANGE_MUTATION_KEY },
    select: (mutation) => mutation.state,
  }).at(-1);

  useEffect(() => {
    scrubOneTimeTokenUrl();
  }, []);

  useEffect(() => {
    if (token && !submitted) {
      submitted = true;
      confirm.mutate({ token });
    }
  }, [token, confirm]);

  const pending = !attempt || attempt.status === 'pending';
  const succeeded = attempt?.status === 'success';

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 md:min-h-[calc(100dvh-4rem)]">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <Film className="mx-auto h-12 w-12 text-[hsl(var(--primary))]" />
          <h1 className="mt-4 text-3xl font-bold">Confirm your new email</h1>
        </div>

        {!token ? (
          <div className="rounded-md border border-[hsl(var(--border))] p-4 text-sm text-[hsl(var(--destructive))]">
            This confirmation link is missing its token. Open the most recent link from your
            inbox, or start the change again from your account settings.
          </div>
        ) : pending ? (
          <div className="flex items-center justify-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Loader2 className="h-5 w-5 animate-spin" /> Confirming your new address…
          </div>
        ) : succeeded ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-4 text-sm">
              <CheckCircle2 className="h-5 w-5 text-[hsl(var(--primary))]" />
              This address is now the one on your account. Sign in with it from now on.
            </div>
            <Link
              to={isAuthenticated ? '/settings' : '/login'}
              className="inline-block rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {isAuthenticated ? 'Back to settings' : 'Sign in'}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--border))] p-4 text-sm text-[hsl(var(--destructive))]">
              <XCircle className="h-5 w-5" />
              {getApiErrorMessage(
                attempt?.error,
                'This confirmation link is invalid or has expired.',
              )}
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Your account keeps the address it had. You can start the change again from
              settings.
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
