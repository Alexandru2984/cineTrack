import { Compass, Home, Search } from 'lucide-react';
import { Link } from 'react-router';

import { useNoIndex } from '@/hooks/useNoIndex';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useT } from '@/hooks/useT';

export default function NotFoundPage() {
  const t = useT();
  usePageTitle(t('notFound.title'));
  useNoIndex();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-16 text-center sm:px-6 sm:py-24">
      <Compass
        className="h-12 w-12 text-[hsl(var(--muted-foreground))]"
        aria-hidden="true"
      />
      <h1 className="mt-6 text-2xl font-bold sm:text-3xl">{t('notFound.title')}</h1>
      <p className="mt-3 max-w-prose text-sm leading-6 text-[hsl(var(--muted-foreground))]">
        {t('notFound.body')}
      </p>

      <nav className="mt-8 flex flex-col gap-3 sm:flex-row" aria-label={t('notFound.title')}>
        <Link
          to="/"
          className="inline-flex items-center justify-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
        >
          <Home className="h-4 w-4" aria-hidden="true" />
          {t('notFound.home')}
        </Link>
        <Link
          to="/search"
          className="inline-flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
        >
          <Search className="h-4 w-4" aria-hidden="true" />
          {t('notFound.search')}
        </Link>
      </nav>
    </div>
  );
}
