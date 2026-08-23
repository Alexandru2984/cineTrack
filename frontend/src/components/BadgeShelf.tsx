import { Award, Flame, Layers, Zap } from 'lucide-react';

import { useBadges } from '@/hooks/useBadges';
import { useT } from '@/hooks/useT';
import type { EarnedBadge } from '@/types';

/** One icon per family, so the shelf reads at a glance rather than as a wall of
 *  identical medals. */
const FAMILY_ICONS: Record<string, typeof Award> = {
  marathon24: Flame,
  marathon48: Flame,
  sameday: Zap,
  juggler: Layers,
  volume: Award,
};

function BadgeCard({ badge }: { badge: EarnedBadge }) {
  const t = useT();
  const Icon = FAMILY_ICONS[badge.family] ?? Award;
  const [first] = badge.shows;

  // Account-wide badges have no shows; per-show badges name one and count the
  // rest. Listing every show is what turned the old app's shelf into two
  // hundred entries nobody read.
  const subtitle = (() => {
    if (badge.shows.length === 0) return null;
    if (badge.count === 1 && first) return t('badges.earnedForOne', { title: first.title });
    return t('badges.earnedFor', { count: badge.count });
  })();

  return (
    <li className="flex items-start gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--primary))]/12 text-[hsl(var(--primary))]">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{t(`badges.${badge.key}`)}</span>
        {subtitle ? (
          <span className="mt-0.5 block text-xs text-[hsl(var(--muted-foreground))]">
            {subtitle}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function BadgeShelf() {
  const t = useT();
  const { data, isLoading, isError } = useBadges();

  if (isLoading) return null;
  if (isError) {
    return (
      <p role="alert" className="text-sm text-[hsl(var(--destructive))]">
        {t('badges.loadError')}
      </p>
    );
  }
  if (!data) return null;

  return (
    <section aria-labelledby="badges-heading" className="space-y-3">
      <h2 id="badges-heading" className="text-lg font-semibold">
        {t('badges.title')}
      </h2>

      {data.earned.length === 0 ? (
        <div className="rounded-xl border border-[hsl(var(--border))] p-4">
          <p className="text-sm font-medium">{t('badges.empty')}</p>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            {t('badges.emptyHint')}
          </p>
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.earned.map((badge) => (
            <BadgeCard key={badge.key} badge={badge} />
          ))}
        </ul>
      )}

      {/* What to aim at next, so the shelf is not only a record of the past.
          Families with every tier earned are absent by design — a full bar that
          cannot move says less than nothing. */}
      {data.progress.length > 0 ? (
        <ul className="space-y-2">
          {data.progress.slice(0, 3).map((item) => (
            <li key={item.family} className="text-xs">
              <span className="flex items-center justify-between gap-2">
                <span className="text-[hsl(var(--muted-foreground))]">
                  {t('badges.next', { label: t(`badges.${item.next_key}`) })}
                </span>
                <span className="tabular-nums text-[hsl(var(--muted-foreground))]">
                  {t('badges.progress', { current: item.current, threshold: item.threshold })}
                </span>
              </span>
              <span
                className="mt-1 block h-1.5 overflow-hidden rounded-full bg-[hsl(var(--muted))]"
                role="progressbar"
                aria-valuenow={item.current}
                aria-valuemin={0}
                aria-valuemax={item.threshold}
                aria-label={t(`badges.${item.next_key}`)}
              >
                <span
                  className="block h-full rounded-full bg-[hsl(var(--primary))]"
                  style={{ width: `${Math.min(100, (item.current / item.threshold) * 100)}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
