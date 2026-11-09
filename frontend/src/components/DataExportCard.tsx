import { useState } from 'react';
import { Download, FileJson, Loader2 } from 'lucide-react';

import { useExportAccount } from '@/hooks/useAuth';
import { useExportLibrary } from '@/hooks/useTracking';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useLocaleStore } from '@/store/locale';

const INPUT =
  'w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]';
const BUTTON =
  'flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 text-sm font-medium hover:bg-[hsl(var(--secondary))] disabled:opacity-50';

/** The library as a spreadsheet, and the whole account as JSON. */
export function DataExportCard() {
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const user = useAuthStore((state) => state.user);
  const exportLibrary = useExportLibrary();
  const exportAccount = useExportAccount();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');

  const closeForm = () => {
    setAsking(false);
    setPassword('');
    setTotpCode('');
    exportAccount.reset();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    exportAccount.mutate(
      {
        password,
        ...(user?.two_factor_enabled ? { totp_code: totpCode.trim() } : {}),
      },
      { onSuccess: closeForm },
    );
  };

  return (
    <section id="data-export" className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="text-lg font-semibold">{t('settings.dataExport')}</h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.dataExportHint')}
      </p>

      <div className="mt-4 space-y-2">
        <button
          type="button"
          disabled={exportLibrary.isPending}
          onClick={() => exportLibrary.mutate({ filters: {}, language: locale })}
          className={BUTTON}
        >
          {exportLibrary.isPending
            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            : <Download className="h-4 w-4" aria-hidden="true" />}
          {t('settings.libraryCsv')}
        </button>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('settings.libraryCsvHint')}</p>
        {exportLibrary.isError && (
          <p role="alert" className="text-sm text-[hsl(var(--destructive))]">
            {t('settings.libraryCsvError')}
          </p>
        )}
      </div>

      <div className="mt-6 space-y-2">
        {!asking ? (
          <button type="button" onClick={() => setAsking(true)} className={BUTTON}>
            <FileJson className="h-4 w-4" aria-hidden="true" />
            {t('settings.accountJson')}
          </button>
        ) : (
          <form onSubmit={submit} className="max-w-sm space-y-4">
            <div>
              <label htmlFor="data-export-password" className="mb-1 block text-sm font-medium">
                {t('settings.accountJsonPassword')}
              </label>
              <input
                id="data-export-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoFocus
                maxLength={128}
                className={INPUT}
              />
            </div>
            {user?.two_factor_enabled && (
              <div>
                <label htmlFor="data-export-totp" className="mb-1 block text-sm font-medium">
                  {t('settings.sensitiveActionCode')}
                </label>
                <input
                  id="data-export-totp"
                  type="text"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value)}
                  required
                  maxLength={64}
                  className={INPUT}
                />
              </div>
            )}
            {exportAccount.error && (
              <p role="alert" className="text-sm text-[hsl(var(--destructive))]">
                {getApiErrorMessage(exportAccount.error, t('settings.accountJsonError'))}
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={exportAccount.isPending}
                className="flex h-10 items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-medium text-[hsl(var(--primary-foreground))] disabled:opacity-50"
              >
                {exportAccount.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('settings.accountJsonDownload')}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="h-10 rounded-md border border-[hsl(var(--border))] px-4 text-sm hover:bg-[hsl(var(--accent))]"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )}
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('settings.accountJsonHint')}</p>
      </div>
    </section>
  );
}
