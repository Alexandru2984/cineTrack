import { useState } from 'react';
import { CalendarClock, Check, Copy } from 'lucide-react';
import {
  useCalendarFeedStatus,
  useDisableCalendarFeed,
  useEnableCalendarFeed,
} from '@/hooks/useCalendar';
import { useT } from '@/hooks/useT';
import { getApiErrorMessage } from '@/lib/api';

const BUTTON_BASE =
  'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50';

/**
 * Manage the subscribable iCal calendar feed. The plaintext URL is only ever
 * available at the moment it is generated, so it is shown once with a copy
 * affordance and a warning; the server keeps only its hash.
 */
export function CalendarFeedCard() {
  const t = useT();
  const status = useCalendarFeedStatus();
  const enableFeed = useEnableCalendarFeed();
  const disableFeed = useDisableCalendarFeed();
  const [revealedUrl, setRevealedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const enabled = status.data?.enabled ?? false;

  const generate = () => {
    setCopied(false);
    enableFeed.mutate(undefined, {
      onSuccess: (data) => setRevealedUrl(data.feed_url),
    });
  };

  const disable = () => {
    disableFeed.mutate(undefined, {
      onSuccess: () => {
        setRevealedUrl(null);
        setCopied(false);
      },
    });
  };

  const copy = async () => {
    if (!revealedUrl) return;
    try {
      await navigator.clipboard.writeText(revealedUrl);
      setCopied(true);
    } catch {
      // Clipboard access can be blocked; the URL is selectable in the field.
    }
  };

  const error = enableFeed.error ?? disableFeed.error;

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <CalendarClock className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
        {t('calendarFeed.title')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('calendarFeed.description')}
      </p>

      {revealedUrl && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-[hsl(var(--foreground))]">
            {t('calendarFeed.revealWarning')}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              readOnly
              value={revealedUrl}
              aria-label={t('calendarFeed.urlLabel')}
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            />
            <button
              type="button"
              onClick={() => void copy()}
              className={`${BUTTON_BASE} border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]`}
            >
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {enabled ? (
          <>
            <button
              type="button"
              onClick={generate}
              disabled={enableFeed.isPending}
              className={`${BUTTON_BASE} border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]`}
            >
              {t('calendarFeed.regenerate')}
            </button>
            <button
              type="button"
              onClick={disable}
              disabled={disableFeed.isPending}
              className={`${BUTTON_BASE} border border-[hsl(var(--destructive))] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive-foreground))]`}
            >
              {t('calendarFeed.disable')}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={generate}
            disabled={enableFeed.isPending}
            className={`${BUTTON_BASE} bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90`}
          >
            {t('calendarFeed.generate')}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-sm text-[hsl(var(--destructive))]">
          {getApiErrorMessage(error, t('calendarFeed.error'))}
        </p>
      )}
    </section>
  );
}
