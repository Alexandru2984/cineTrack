import { useDiscovery } from '@/hooks/useMedia';
import { useMyStats, useHeatmap } from '@/hooks/useStats';
import { useActivityFeed } from '@/hooks/useSocial';
import { useAuthStore } from '@/store/auth';
import { MediaCard } from '@/components/MediaCard';
import { ActivityList } from '@/components/ActivityList';
import { UpNextEpisodes } from '@/components/UpNextEpisodes';
import { useT } from '@/hooks/useT';
import { useTrackingLookupBatch } from '@/hooks/useTracking';
import type { TmdbSearchResult, TrackingStatus } from '@/types';
import CalendarHeatmap from 'react-calendar-heatmap';
import 'react-calendar-heatmap/dist/styles.css';
import { Activity, Clock, Film, Flame, RefreshCw, Sparkles, Tv } from 'lucide-react';

export default function Dashboard() {
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const {
    data: discovery,
    isLoading: discoveryLoading,
    isError: discoveryError,
    isFetching: discoveryFetching,
    refetch: refetchDiscovery,
  } = useDiscovery();
  const { data: stats } = useMyStats();
  const { data: heatmap } = useHeatmap();
  const {
    data: activity,
    isLoading: activityLoading,
    isError: activityError,
  } = useActivityFeed();
  const quickAddItems = [
    ...(discovery?.because_you_watched?.results ?? []),
    ...(discovery?.recommendations ?? []),
  ];
  const tracking = useTrackingLookupBatch(
    quickAddItems.map((item) => ({
      tmdb_id: item.id,
      media_type: item.media_type === 'tv' ? 'tv' : 'movie',
    })),
  );
  const trackingByMedia = new Map<string, TrackingStatus>(
    (tracking.data ?? []).map((item) => [
      `${item.media_type}:${item.tmdb_id}`,
      item.status as TrackingStatus,
    ]),
  );

  const today = new Date();
  const startDate = new Date(today.getFullYear(), 0, 1);

  return (
    <div className="mx-auto max-w-7xl space-y-7 px-4 py-6 sm:space-y-8 sm:py-8">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">
          {t('dashboard.welcome')}
          <span className="mt-1 block max-w-full truncate text-[hsl(var(--primary))] sm:mt-0 sm:inline sm:whitespace-normal sm:break-all">
            {' '}{user?.username}!
          </span>
        </h1>
        <p className="text-[hsl(var(--muted-foreground))] mt-1">{t('dashboard.overview')}</p>
      </div>

      <UpNextEpisodes />

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:gap-4 md:grid-cols-4">
          <StatCard icon={<Film className="h-5 w-5" />} label={t('dashboard.movies')} value={stats.total_movies} />
          <StatCard icon={<Tv className="h-5 w-5" />} label={t('dashboard.shows')} value={stats.total_shows} />
          <StatCard icon={<Clock className="h-5 w-5" />} label={t('dashboard.hoursWatched')} value={Math.round(stats.total_hours)} />
          <StatCard icon={<Flame className="h-5 w-5" />} label={t('dashboard.currentStreak')} value={`${stats.current_streak}d`} />
        </div>
      )}

      {discoveryError && !discovery ? (
        <section aria-labelledby="discovery-error-heading">
          <div className="flex items-center justify-between gap-4 border-y border-[hsl(var(--border))] py-6">
            <div>
              <h2 id="discovery-error-heading" className="text-lg font-semibold">
                {t('dashboard.recommendationsUnavailable')}
              </h2>
              <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                {t('dashboard.recommendationsUnavailableHint')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refetchDiscovery()}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))] disabled:opacity-50"
              aria-label={t('dashboard.retryRecommendations')}
              title={t('dashboard.retryRecommendations')}
              disabled={discoveryFetching}
            >
              <RefreshCw
                className={`h-4 w-4 ${discoveryFetching ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
            </button>
          </div>
        </section>
      ) : (
        <>
          {discovery?.because_you_watched && discovery.because_you_watched.results.length > 0 && (
            <MediaShelf
              id="because-you-watched-heading"
              title={t('dashboard.becauseYouWatched', {
                title: discovery.because_you_watched.seed_title,
              })}
              icon={<Sparkles className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />}
              items={discovery.because_you_watched.results}
              isLoading={false}
              emptyMessage={t('dashboard.noRelated')}
              showQuickAdd
              trackingByMedia={trackingByMedia}
            />
          )}
          <MediaShelf
            id="recommendations-heading"
            title={discovery?.personalized ? t('dashboard.forYou') : t('dashboard.recommended')}
            subtitle={
              discovery?.personalized && discovery.recommendation_basis?.length
                ? discovery.recommendation_basis.join(' · ')
                : undefined
            }
            icon={<Sparkles className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />}
            items={discovery?.recommendations ?? []}
            isLoading={discoveryLoading}
            emptyMessage={t('dashboard.noRecommendations')}
            showQuickAdd
            trackingByMedia={trackingByMedia}
          />
          <MediaShelf
            id="popular-movies-heading"
            title={t('dashboard.popularMovies')}
            icon={<Film className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />}
            items={discovery?.popular_movies ?? []}
            isLoading={discoveryLoading}
            emptyMessage={t('dashboard.noPopularMovies')}
          />
          <MediaShelf
            id="popular-shows-heading"
            title={t('dashboard.popularShows')}
            icon={<Tv className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />}
            items={discovery?.popular_shows ?? []}
            isLoading={discoveryLoading}
            emptyMessage={t('dashboard.noPopularShows')}
          />
        </>
      )}

      <section aria-labelledby="recent-activity-heading">
        <h2 id="recent-activity-heading" className="mb-4 flex items-center gap-2 text-xl font-bold">
          <Activity className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
          {t('dashboard.recentActivity')}
        </h2>
        <ActivityList
          items={activity}
          isLoading={activityLoading}
          isError={activityError}
        />
      </section>

      <div className="rounded-lg border border-[hsl(var(--border))] p-6 bg-[hsl(var(--card))]">
        <h2 className="text-lg font-semibold mb-4">{t('dashboard.watchActivity')}</h2>
        <div className="overflow-x-auto">
          <CalendarHeatmap
            startDate={startDate}
            endDate={today}
            values={heatmap?.map((d) => ({ date: d.date, count: d.count })) || []}
            classForValue={(value) => {
              if (!value || !value.count) return 'color-empty';
              if (value.count >= 8) return 'color-scale-4';
              if (value.count >= 5) return 'color-scale-3';
              if (value.count >= 3) return 'color-scale-2';
              return 'color-scale-1';
            }}
            titleForValue={(value) => {
              return value?.date
                ? t('dashboard.heatmapEntries', { date: value.date, count: value.count || 0 })
                : '';
            }}
          />
        </div>
      </div>
    </div>
  );
}

interface MediaShelfProps {
  id: string;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  items: TmdbSearchResult[];
  isLoading: boolean;
  emptyMessage: string;
  showQuickAdd?: boolean;
  trackingByMedia?: ReadonlyMap<string, TrackingStatus>;
}

function MediaShelf({
  id,
  title,
  subtitle,
  icon,
  items,
  isLoading,
  emptyMessage,
  showQuickAdd = false,
  trackingByMedia,
}: MediaShelfProps) {
  const t = useT();
  return (
    <section aria-labelledby={id} aria-busy={isLoading}>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="flex items-center gap-2 text-xl font-bold">
          {icon}
          {title}
        </h2>
        {subtitle && <p className="text-sm text-[hsl(var(--muted-foreground))]">{subtitle}</p>}
      </div>

      {isLoading ? (
        <MediaShelfSkeleton title={title} />
      ) : items.length > 0 ? (
        <div
          className="grid auto-cols-[9.5rem] grid-flow-col gap-4 overflow-x-auto overscroll-x-contain pb-3 sm:auto-cols-[10.5rem] snap-x snap-mandatory"
          role="list"
          aria-label={t('dashboard.shelfTitles', { title })}
          tabIndex={0}
        >
          {items.map((item) => (
            <div key={`${item.media_type ?? 'movie'}-${item.id}`} role="listitem" className="snap-start">
              <MediaCard
                item={item}
                showQuickAdd={showQuickAdd}
                trackingStatus={
                  trackingByMedia?.get(
                    `${item.media_type === 'tv' ? 'tv' : 'movie'}:${item.id}`,
                  ) ?? null
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="border-y border-[hsl(var(--border))] py-6 text-sm text-[hsl(var(--muted-foreground))]">
          {emptyMessage}
        </p>
      )}
    </section>
  );
}

function MediaShelfSkeleton({ title }: { title: string }) {
  const t = useT();
  return (
    <div
      className="grid auto-cols-[9.5rem] grid-flow-col gap-4 overflow-hidden pb-3 sm:auto-cols-[10.5rem]"
      role="status"
    >
      <span className="sr-only">{t('dashboard.loadingShelf', { title })}</span>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="animate-pulse" aria-hidden="true">
          <div className="aspect-[2/3] rounded-md bg-[hsl(var(--muted))]" />
          <div className="mt-3 h-4 w-4/5 rounded bg-[hsl(var(--muted))]" />
          <div className="mt-2 h-3 w-1/3 rounded bg-[hsl(var(--muted))]" />
        </div>
      ))}
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3 sm:p-4">
      <div className="flex items-center gap-2 text-[hsl(var(--muted-foreground))]">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold">{value}</p>
    </div>
  );
}
