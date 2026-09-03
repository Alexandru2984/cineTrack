import { Database, ExternalLink, Film } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { usePageMeta } from '@/hooks/usePageMeta';

export default function AboutPage() {
  usePageMeta({ title: 'About Văzute', path: '/about' });
  const t = useT();
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-[hsl(var(--border))] pb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold sm:text-3xl">
          <Film className="h-7 w-7 text-[hsl(var(--primary))]" aria-hidden="true" />
          {t('about.title')}
        </h1>
      </header>

      <section className="py-8" aria-labelledby="data-sources-heading">
        <h2 id="data-sources-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Database className="h-5 w-5 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
          {t('about.dataSources')}
        </h2>

        <div className="mt-5 divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]">
          <div className="flex flex-col items-start gap-5 py-6 sm:flex-row sm:items-center">
            <a
              href="https://www.themoviedb.org"
              target="_blank"
              rel="noreferrer"
              aria-label={t('about.tmdbAria')}
              className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              <img
                src="/tmdb-logo.svg"
                alt="TMDB"
                className="h-auto w-36"
                width="273"
                height="36"
              />
            </a>
            <div className="space-y-2 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
              <p>{t('about.tmdbBody')}</p>
              <p className="text-[hsl(var(--foreground))]">
                {t('about.tmdbDisclaimer')}
              </p>
              <a
                href="https://www.themoviedb.org"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-cyan-700 hover:underline dark:text-cyan-400"
              >
                themoviedb.org
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="flex flex-col items-start gap-3 py-6 sm:flex-row sm:items-center sm:gap-5">
            <a
              href="https://www.justwatch.com/ro"
              target="_blank"
              rel="noreferrer"
              /* The theme token every other link on the site uses, not a fixed
                 amber. `text-amber-500` is #fe9a00, which is 2.13:1 on white
                 against the 4.5:1 WCAG AA needs — unreadable for the one thing
                 on this row meant to be clicked, and it did not follow the
                 theme either. The token measures 5.67:1 in light and 7.40:1 in
                 dark. Underlined as well, because colour alone is not a link. */
              className="shrink-0 text-lg font-bold text-[hsl(var(--primary))] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              JustWatch
            </a>
            <p className="text-sm leading-6 text-[hsl(var(--muted-foreground))]">
              {t('about.justwatchBody')}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
