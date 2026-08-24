import { Languages } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';
import { useLocaleStore } from '@/store/locale';

/** Settings section to switch the UI language. */
export function LanguageCard() {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);

  const label: Record<Locale, string> = {
    en: t('language.english'),
    ro: t('language.romanian'),
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Languages className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
        {t('language.title')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{t('language.description')}</p>
      <div
        role="group"
        aria-label={t('language.title')}
        className="mt-4 inline-flex rounded-md border border-[hsl(var(--border))] p-1"
      >
        {SUPPORTED_LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={locale === option}
            onClick={() => void setLocale(option)}
            className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${
              locale === option
                ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                : 'hover:bg-[hsl(var(--secondary))]'
            }`}
          >
            {label[option]}
          </button>
        ))}
      </div>
    </section>
  );
}
