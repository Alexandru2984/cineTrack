import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MailWarning, X } from 'lucide-react';
import { useResendVerification } from '@/hooks/useAuth';
import { useAuthStore } from '@/store/auth';

export function EmailVerificationBanner() {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const resend = useResendVerification();

  // Nothing to prompt when verified, dismissed, or already on the confirm page.
  if (!user || user.email_verified || dismissed || location.pathname === '/verify-email') {
    return null;
  }

  return (
    <div
      role="status"
      className="border-b border-[hsl(var(--border))] bg-[hsl(var(--accent))]/60"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm">
        <MailWarning className="h-4 w-4 shrink-0 text-[hsl(var(--primary))]" aria-hidden="true" />
        <p className="min-w-0 flex-1">
          {resend.isSuccess ? (
            <>Confirmation link sent to <span className="font-medium">{user.email}</span>. Check your inbox.</>
          ) : (
            <>Confirm your email to secure your account and password recovery.</>
          )}
        </p>
        <div className="flex items-center gap-2">
          {!resend.isSuccess && (
            <button
              type="button"
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
              className="rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {resend.isPending ? 'Sending…' : 'Resend link'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="rounded-md p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
