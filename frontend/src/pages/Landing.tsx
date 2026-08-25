import { CalendarDays, ChartNoAxesColumn, ListChecks, Lock } from 'lucide-react';
import { Link } from 'react-router';

import { usePageMeta } from '@/hooks/usePageMeta';
import { useT } from '@/hooks/useT';

/** What somebody sees when they arrive without an account.
 *
 *  Until now `/` redirected straight to the sign-in form, which greeted a
 *  first-time visitor with "welcome back" and two empty fields. Everyone
 *  arriving from a shared link or a search result met a login wall that never
 *  said what they had arrived at — and `/` is also the address the whole site
 *  canonicalises to, so the one page search engines were told to index had no
 *  content at all.
 *
 *  This is not a sales page. It says what the thing does, in the order somebody
 *  deciding whether to sign up would ask, and gets out of the way.
 */
export default function LandingPage() {
  const t = useT();
  usePageMeta({ path: '/' });

  const features = [
    {
      icon: <CalendarDays className="h-5 w-5" aria-hidden="true" />,
      title: t('landing.featureCalendarTitle'),
      body: t('landing.featureCalendarBody'),
    },
    {
      icon: <ListChecks className="h-5 w-5" aria-hidden="true" />,
      title: t('landing.featureLibraryTitle'),
      body: t('landing.featureLibraryBody'),
    },
    {
      icon: <ChartNoAxesColumn className="h-5 w-5" aria-hidden="true" />,
      title: t('landing.featureStatsTitle'),
      body: t('landing.featureStatsBody'),
    },
    {
      icon: <Lock className="h-5 w-5" aria-hidden="true" />,
      title: t('landing.featurePrivacyTitle'),
      body: t('landing.featurePrivacyBody'),
    },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
      <header className="max-w-2xl">
        <h1 className="text-3xl font-bold sm:text-4xl">{t('landing.tagline')}</h1>
        <p className="mt-4 text-base leading-relaxed text-[hsl(var(--muted-foreground))]">
          {t('landing.lede')}
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            to="/register"
            className="inline-flex items-center rounded-lg bg-[hsl(var(--primary))] px-5 py-2.5 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90"
          >
            {t('landing.startAction')}
          </Link>
          <Link
            to="/login"
            className="inline-flex items-center rounded-lg border border-[hsl(var(--border))] px-5 py-2.5 text-sm font-medium transition-colors hover:bg-[hsl(var(--accent))]"
          >
            {t('landing.signInAction')}
          </Link>
        </div>
      </header>

      <div className="mt-12 grid gap-5 sm:grid-cols-2">
        {features.map((feature) => (
          <section
            key={feature.title}
            className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5"
          >
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="text-[hsl(var(--primary))]">{feature.icon}</span>
              {feature.title}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              {feature.body}
            </p>
          </section>
        ))}
      </div>

      <footer className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[hsl(var(--border))] pt-6 text-sm text-[hsl(var(--muted-foreground))]">
        <span>{t('landing.languageNote')}</span>
        <span aria-hidden="true">·</span>
        <span>{t('landing.openSourceNote')}</span>
        <span aria-hidden="true">·</span>
        <Link to="/about" className="underline underline-offset-2 hover:text-[hsl(var(--foreground))]">
          {t('about.title')}
        </Link>
        <Link to="/privacy" className="underline underline-offset-2 hover:text-[hsl(var(--foreground))]">
          {t('privacy.title')}
        </Link>
      </footer>
    </div>
  );
}
