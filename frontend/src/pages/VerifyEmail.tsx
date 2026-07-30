import { useEffect } from 'react';
import { Link } from 'react-router';
import { useMutationState } from '@tanstack/react-query';
import { useVerifyEmail, VERIFY_EMAIL_MUTATION_KEY } from '@/hooks/useAuth';
import { useAuthStore } from '@/store/auth';
import { getApiErrorMessage } from '@/lib/api';
import { readFragmentOneTimeToken, scrubOneTimeTokenUrl } from '@/lib/oneTimeToken';
import { CheckCircle2, Film, Loader2, XCircle } from 'lucide-react';
import { useT } from '@/hooks/useT';

/**
 * The confirmation token is a one-time credential that only exists in the URL,
 * and the first effect strips it so it cannot leak through history or a shared
 * screenshot. React mounts this route more than once — StrictMode in
 * development, and the session bootstrap swapping the tree once `authStatus`
 * leaves `loading` — so both the token and the "already sent" flag live at
 * module scope. Held in component state, the instance that performed the
 * request was discarded before it could render the result: the token was gone
 * from the URL by then, so the page spun forever on "Confirming".
 */
let capturedToken: string | null = null;
let submitted = false;

function readTokenOnce(): string {
  if (capturedToken === null) {
    capturedToken = readFragmentOneTimeToken(window.location.hash);
  }
  return capturedToken;
}

export default function VerifyEmailPage() {
  const t = useT();
  const token = readTokenOnce();
  const isAuthenticated = useAuthStore((s) => s.status === 'authenticated');
  const verify = useVerifyEmail();
  // Read the attempt from the mutation cache, which outlives this component,
  // rather than from this instance's own observer.
  const attempt = useMutationState({
    filters: { mutationKey: VERIFY_EMAIL_MUTATION_KEY },
    select: (mutation) => mutation.state,
  }).at(-1);

  useEffect(() => {
    scrubOneTimeTokenUrl();
  }, []);

  useEffect(() => {
    if (token && !submitted) {
      submitted = true;
      verify.mutate({ token });
    }
  }, [token, verify]);

  const pending = !attempt || attempt.status === 'pending';
  const succeeded = attempt?.status === 'success';

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 md:min-h-[calc(100dvh-4rem)]">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <Film className="mx-auto h-12 w-12 text-[hsl(var(--primary))]" />
          <h1 className="mt-4 text-3xl font-bold">{t('auth.confirmEmail')}</h1>
        </div>

        {!token ? (
          <div className="rounded-md border border-[hsl(var(--border))] p-4 text-sm text-[hsl(var(--destructive))]">
            {t('auth.verifyMissingToken')}
          </div>
        ) : pending ? (
          <div className="flex items-center justify-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Loader2 className="h-5 w-5 animate-spin" /> {t('auth.confirmingEmail')}
          </div>
        ) : succeeded ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-4 text-sm">
              <CheckCircle2 className="h-5 w-5 text-[hsl(var(--primary))]" />
              {t('auth.emailConfirmed')}
            </div>
            <Link
              to={isAuthenticated ? '/' : '/login'}
              className="inline-block rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
            >
              {isAuthenticated ? t('auth.goToDashboard') : t('auth.signIn')}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--border))] p-4 text-sm text-[hsl(var(--destructive))]">
              <XCircle className="h-5 w-5" />
              {getApiErrorMessage(attempt?.error, t('auth.verifyInvalid'))}
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              {t('auth.verifyRequestFresh')}
            </p>
            <Link
              to={isAuthenticated ? '/settings' : '/login'}
              className="inline-block rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))]"
            >
              {isAuthenticated ? t('auth.goToSettings') : t('auth.signIn')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
