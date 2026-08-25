import { CheckCircle2, ListChecks, LogIn, Mail, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { loginPathFor } from '@/lib/navigation';
import { useAuthStore } from '@/store/auth';
import { useT } from '@/hooks/useT';
import { usePageMeta } from '@/hooks/usePageMeta';

const CONTACT_EMAIL = 'postmaster@micutu.com';
const DELETE_SETTINGS_PATH = '/settings#delete-account';

export default function AccountDeletionPage() {
  usePageMeta({ title: 'Delete your account', path: '/account-deletion' });
  const t = useT();
  const authenticated = useAuthStore((state) => state.isAuthenticated)();
  const deletionPath = authenticated
    ? DELETE_SETTINGS_PATH
    : loginPathFor(DELETE_SETTINGS_PATH);

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-[hsl(var(--border))] pb-6">
        <div className="flex items-center gap-2 text-[hsl(var(--destructive))]">
          <Trash2 className="h-6 w-6" aria-hidden="true" />
          <span className="text-sm font-semibold">{t('accountDeletion.badge')}</span>
        </div>
        <h1 className="mt-3 text-2xl font-bold sm:text-3xl">{t('accountDeletion.title')}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          {t('accountDeletion.intro')}
        </p>
      </header>

      <section className="border-b border-[hsl(var(--border))] py-8" aria-labelledby="web-deletion-heading">
        <h2 id="web-deletion-heading" className="flex items-center gap-2 text-lg font-semibold">
          <LogIn className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
          {t('accountDeletion.webTitle')}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          {t('accountDeletion.webBody')}
        </p>
        <Link
          to={deletionPath}
          className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-md bg-[hsl(var(--destructive))] px-4 py-2 text-sm font-medium text-[hsl(var(--destructive-foreground))] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {t('accountDeletion.continueButton')}
        </Link>
      </section>

      <section className="border-b border-[hsl(var(--border))] py-8" aria-labelledby="mobile-deletion-heading">
        <h2 id="mobile-deletion-heading" className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="h-5 w-5 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
          {t('accountDeletion.mobileTitle')}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          {t('accountDeletion.mobileBody')}
        </p>
      </section>

      <section className="border-b border-[hsl(var(--border))] py-8" aria-labelledby="partial-deletion-heading">
        <h2 id="partial-deletion-heading" className="flex items-center gap-2 text-lg font-semibold">
          <ListChecks className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          {t('accountDeletion.partialTitle')}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          {t('accountDeletion.partialBody')}
        </p>
        <ul className="mt-4 flex list-disc flex-col gap-2 pl-5 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          <li>{t('accountDeletion.partialLibrary')}</li>
          <li>{t('accountDeletion.partialLists')}</li>
          <li>{t('accountDeletion.partialProfile')}</li>
          <li>{t('accountDeletion.partialSessions')}</li>
        </ul>
        <p className="mt-4 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          {t('accountDeletion.partialRetention')}
        </p>
      </section>

      <section className="border-b border-[hsl(var(--border))] py-8" aria-labelledby="deleted-data-heading">
        <h2 id="deleted-data-heading" className="flex items-center gap-2 text-lg font-semibold">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          {t('accountDeletion.deletedTitle')}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          {t('accountDeletion.deletedBody')}
        </p>
      </section>

      <section className="py-8" aria-labelledby="deletion-help-heading">
        <h2 id="deletion-help-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Mail className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
          {t('accountDeletion.helpTitle')}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          {t('accountDeletion.helpBodyPre')}{' '}
          <a className="font-medium text-[hsl(var(--primary))] underline underline-offset-2" href={`mailto:${CONTACT_EMAIL}?subject=Vazute%20account%20deletion%20request`}>
            {CONTACT_EMAIL}
          </a>{t('accountDeletion.helpBodyPost')}
        </p>
        <p className="mt-4 text-sm text-[hsl(var(--muted-foreground))]">
          {t('accountDeletion.retentionPre')}{' '}
          <Link className="font-medium text-[hsl(var(--primary))] underline underline-offset-2" to="/privacy">
            {t('accountDeletion.privacyLink')}
          </Link>{t('accountDeletion.retentionPost')}
        </p>
      </section>
    </article>
  );
}
