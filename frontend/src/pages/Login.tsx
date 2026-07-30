import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { AxiosError } from 'axios';
import { useLogin } from '@/hooks/useAuth';
import { getApiErrorMessage } from '@/lib/api';
import { Film, Loader2, ShieldCheck } from 'lucide-react';
import { safeReturnTo } from '@/lib/navigation';
import { useT } from '@/hooks/useT';

function isTwoFactorRequired(error: unknown): boolean {
  return (
    (error as AxiosError<{ two_factor_required?: boolean }>)?.response?.data
      ?.two_factor_required === true
  );
}

export default function LoginPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [code, setCode] = useState('');
  const login = useLogin();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get('returnTo'));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate(
      { email, password, totp_code: mfaRequired ? code.trim() : undefined },
      {
        onSuccess: () => navigate(returnTo, { replace: true }),
        onError: (error) => {
          if (isTwoFactorRequired(error)) setMfaRequired(true);
        },
      },
    );
  };

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 md:min-h-[calc(100dvh-4rem)]">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <Film className="mx-auto h-12 w-12 text-[hsl(var(--primary))]" />
          <h1 className="mt-4 text-3xl font-bold">{t('auth.welcomeBack')}</h1>
          <p className="mt-2 text-[hsl(var(--muted-foreground))]">{t('auth.signInSubtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-email" className="block text-sm font-medium mb-1">{t('auth.email')}</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="login-password" className="block text-sm font-medium">{t('auth.password')}</label>
              <Link to="/forgot-password" className="text-xs text-[hsl(var(--primary))] underline underline-offset-2">
                {t('auth.forgotPassword')}
              </Link>
            </div>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              placeholder="••••••••"
            />
          </div>

          {mfaRequired && (
            <div>
              <label htmlFor="login-totp" className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                <ShieldCheck className="h-4 w-4 text-[hsl(var(--primary))]" aria-hidden="true" />
                {t('auth.authCode')}
              </label>
              <input
                id="login-totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
                className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
                placeholder="123456"
              />
              <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                {t('auth.authCodeHint')}
              </p>
            </div>
          )}

          {login.error && !isTwoFactorRequired(login.error) && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(login.error, t('auth.loginFailed'))}
            </p>
          )}

          <button
            type="submit"
            disabled={login.isPending}
            className="w-full rounded-md bg-[hsl(var(--primary))] py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {login.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {mfaRequired ? t('auth.verify') : t('auth.signIn')}
          </button>
        </form>

        <p className="text-center text-sm text-[hsl(var(--muted-foreground))]">
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="text-[hsl(var(--primary))] underline underline-offset-2">{t('auth.register')}</Link>
        </p>
      </div>
    </div>
  );
}
