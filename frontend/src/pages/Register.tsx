import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useRegister } from '@/hooks/useAuth';
import { getApiErrorMessage } from '@/lib/api';
import { Film, Loader2 } from 'lucide-react';
import { useT } from '@/hooks/useT';

export default function RegisterPage() {
  const t = useT();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const register = useRegister();
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    register.mutate({ username, email, password, accepted_terms: acceptedTerms }, {
      onSuccess: () => navigate('/'),
    });
  };

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 md:min-h-[calc(100dvh-4rem)]">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <Film className="mx-auto h-12 w-12 text-[hsl(var(--primary))]" />
          <h1 className="mt-4 text-3xl font-bold">{t('auth.createAccount')}</h1>
          <p className="mt-2 text-[hsl(var(--muted-foreground))]">{t('auth.registerSubtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="register-username" className="block text-sm font-medium mb-1">{t('auth.username')}</label>
            <input
              id="register-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              maxLength={50}
              pattern={'[A-Za-z0-9][A-Za-z0-9_\\-]*[A-Za-z0-9]'}
              title={t('auth.usernameTitle')}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              placeholder={t('auth.usernamePlaceholder')}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-3 text-sm leading-5 text-[hsl(var(--muted-foreground))]">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(event) => setAcceptedTerms(event.target.checked)}
              required
              className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
            />
            <span>
              {t('auth.acceptTermsPre')}{' '}
              <Link to="/terms" target="_blank" rel="noreferrer" className="text-[hsl(var(--primary))] hover:underline">
                {t('auth.termsOfUse')}
              </Link>{' '}
              {t('auth.acceptTermsAnd')}{' '}
              <Link to="/community-guidelines" target="_blank" rel="noreferrer" className="text-[hsl(var(--primary))] hover:underline">
                {t('auth.communityGuidelines')}
              </Link>
              .
            </span>
          </label>
          <div>
            <label htmlFor="register-email" className="block text-sm font-medium mb-1">{t('auth.email')}</label>
            <input
              id="register-email"
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
            <label htmlFor="register-password" className="block text-sm font-medium mb-1">{t('auth.password')}</label>
            <input
              id="register-password"
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

          {register.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(register.error, t('auth.registrationFailed'))}
            </p>
          )}

          <button
            type="submit"
            disabled={register.isPending || !acceptedTerms}
            className="w-full rounded-md bg-[hsl(var(--primary))] py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {register.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('auth.createAccount')}
          </button>
        </form>

        <p className="text-center text-sm text-[hsl(var(--muted-foreground))]">
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="text-[hsl(var(--primary))] hover:underline">{t('auth.signIn')}</Link>
        </p>
      </div>
    </div>
  );
}
