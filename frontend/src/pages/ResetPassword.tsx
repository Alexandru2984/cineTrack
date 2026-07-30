import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useResetPassword } from '@/hooks/useAuth';
import { getApiErrorMessage } from '@/lib/api';
import { readFragmentOneTimeToken, scrubOneTimeTokenUrl } from '@/lib/oneTimeToken';
import { Film, Loader2 } from 'lucide-react';
import { useT } from '@/hooks/useT';

export default function ResetPasswordPage() {
  const t = useT();
  const [token] = useState(() => readFragmentOneTimeToken(window.location.hash));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const reset = useResetPassword();
  const navigate = useNavigate();

  useEffect(() => {
    scrubOneTimeTokenUrl();
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
          <h1 className="mt-4 text-3xl font-bold">{t('auth.chooseNewPassword')}</h1>
        </div>

        {!token ? (
          <div className="rounded-md border border-[hsl(var(--border))] p-4 text-center text-sm text-[hsl(var(--destructive))]">
            {t('auth.resetMissingTokenPre')}{' '}
            <Link to="/forgot-password" className="text-[hsl(var(--primary))] underline underline-offset-2">
              {t('auth.forgotPasswordLink')}
            </Link>{' '}
            {t('auth.resetMissingTokenPost')}
          </div>
        ) : reset.isSuccess ? (
          <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-4 text-center text-sm">
            {t('auth.passwordUpdated')}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="reset-new-password" className="block text-sm font-medium mb-1">{t('auth.newPassword')}</label>
              <input
                id="reset-new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
                placeholder={t('auth.passwordMinPlaceholder')}
              />
            </div>
            <div>
              <label htmlFor="reset-confirm-password" className="block text-sm font-medium mb-1">{t('auth.confirmNewPassword')}</label>
              <input
                id="reset-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
                placeholder={t('auth.confirmPasswordPlaceholder')}
              />
            </div>

            {mismatch && (
              <p className="text-sm text-[hsl(var(--destructive))]">{t('auth.passwordsMismatch')}</p>
            )}
            {reset.error && (
              <p className="text-sm text-[hsl(var(--destructive))]">
                {getApiErrorMessage(reset.error, t('auth.resetError'))}
              </p>
            )}

            <button
              type="submit"
              disabled={reset.isPending}
              className="w-full rounded-md bg-[hsl(var(--primary))] py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {reset.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('auth.setNewPassword')}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-[hsl(var(--muted-foreground))]">
          <Link to="/login" className="text-[hsl(var(--primary))] underline underline-offset-2">{t('auth.backToSignIn')}</Link>
        </p>
      </div>
    </div>
  );
}
