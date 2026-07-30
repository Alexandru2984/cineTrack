import { ShieldCheck } from 'lucide-react';
import { Link } from 'react-router';

import { useAcceptTerms } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

export function TermsAcceptanceGate() {
  const t = useT();
  const user = useAuthStore((state) => state.user);
  const acceptTerms = useAcceptTerms();

  if (!user?.terms_acceptance_required) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="terms-acceptance-title"
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/65 p-4 backdrop-blur-sm"
    >
      <section className="w-full max-w-lg rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-5 shadow-2xl sm:p-7">
        <div className="flex items-start gap-3">
          <span className="rounded-full bg-[hsl(var(--primary))]/10 p-2 text-[hsl(var(--primary))]">
            <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <h1 id="terms-acceptance-title" className="text-xl font-bold">
              {t('legal.acceptanceTitle')}
            </h1>
            <p className="mt-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
              {t('legal.acceptanceBody')}
            </p>
          </div>
        </div>

        <p className="mt-5 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          {t('legal.acceptanceReviewPre')}{' '}
          <Link
            to="/terms"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-[hsl(var(--primary))] hover:underline"
          >
            {t('auth.termsOfUse')}
          </Link>{' '}
          {t('auth.acceptTermsAnd')}{' '}
          <Link
            to="/community-guidelines"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-[hsl(var(--primary))] hover:underline"
          >
            {t('auth.communityGuidelines')}
          </Link>
          .
        </p>

        {acceptTerms.error && (
          <p className="mt-4 text-sm text-[hsl(var(--destructive))]">
            {getApiErrorMessage(acceptTerms.error, t('legal.acceptanceError'))}
          </p>
        )}

        <button
          type="button"
          disabled={acceptTerms.isPending}
          onClick={() => acceptTerms.mutate()}
          className="mt-6 min-h-11 w-full rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {acceptTerms.isPending ? t('legal.accepting') : t('legal.acceptButton')}
        </button>
      </section>
    </div>
  );
}
