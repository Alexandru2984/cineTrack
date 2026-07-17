import { CheckCircle2, LogIn, Mail, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { loginPathFor } from '@/lib/navigation';
import { useAuthStore } from '@/store/auth';

const CONTACT_EMAIL = 'postmaster@micutu.com';
const DELETE_SETTINGS_PATH = '/settings#delete-account';

export default function AccountDeletionPage() {
  const authenticated = useAuthStore((state) => state.isAuthenticated)();
  const deletionPath = authenticated
    ? DELETE_SETTINGS_PATH
    : loginPathFor(DELETE_SETTINGS_PATH);

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-[hsl(var(--border))] pb-6">
        <div className="flex items-center gap-2 text-[hsl(var(--destructive))]">
          <Trash2 className="h-6 w-6" aria-hidden="true" />
          <span className="text-sm font-semibold">Văzute account control</span>
        </div>
        <h1 className="mt-3 text-2xl font-bold sm:text-3xl">Delete your Văzute account</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          Account deletion is permanent and removes the account and its associated personal data.
        </p>
      </header>

      <section className="border-b border-[hsl(var(--border))] py-8" aria-labelledby="web-deletion-heading">
        <h2 id="web-deletion-heading" className="flex items-center gap-2 text-lg font-semibold">
          <LogIn className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
          Delete securely on the web
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          Sign in, open the highlighted Delete account section, enter the current password, and
          confirm the permanent deletion.
        </p>
        <Link
          to={deletionPath}
          className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-md bg-[hsl(var(--destructive))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Continue to account deletion
        </Link>
      </section>

      <section className="border-b border-[hsl(var(--border))] py-8" aria-labelledby="mobile-deletion-heading">
        <h2 id="mobile-deletion-heading" className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="h-5 w-5 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
          Delete in the mobile app
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          Open Profile, choose Account settings, then Delete my account. The app requires the
          current password and a final destructive confirmation.
        </p>
      </section>

      <section className="border-b border-[hsl(var(--border))] py-8" aria-labelledby="deleted-data-heading">
        <h2 id="deleted-data-heading" className="flex items-center gap-2 text-lg font-semibold">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          What is deleted
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          The live profile, email, credentials, sessions, avatar, library, watch history, ratings,
          reviews, custom lists, episode plans, imports, follows, and notifications are removed.
          Disaster-recovery backups expire within 14 days. Shared movie and television metadata
          that is not linked to the account may remain cached.
        </p>
      </section>

      <section className="py-8" aria-labelledby="deletion-help-heading">
        <h2 id="deletion-help-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Mail className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
          Cannot access the account?
        </h2>
        <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
          Send a deletion request from the account email address to{' '}
          <a className="font-medium text-[hsl(var(--primary))] hover:underline" href={`mailto:${CONTACT_EMAIL}?subject=Vazute%20account%20deletion%20request`}>
            {CONTACT_EMAIL}
          </a>. Include the username, but never send a password. Identity may need to be verified
          before deletion.
        </p>
        <p className="mt-4 text-sm text-[hsl(var(--muted-foreground))]">
          Details about processing and retention are available in the{' '}
          <Link className="font-medium text-[hsl(var(--primary))] hover:underline" to="/privacy">
            privacy policy
          </Link>.
        </p>
      </section>
    </article>
  );
}
