import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarRange, Clapperboard, Clock, Film, Flame, Sparkles, Tv } from 'lucide-react';
import { useWrapped } from '@/hooks/useStats';
import { getPosterUrl, formatDate } from '@/lib/utils';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import type { WrappedStats } from '@/types';

const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Film;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] p-4">
      <Icon className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
      <div className="mt-2 text-2xl font-bold">{value}</div>
      <div className="text-xs text-[hsl(var(--muted-foreground))]">{label}</div>
    </div>
  );
}

function Recap({ data }: { data: WrappedStats }) {
  const maxMonth = Math.max(1, ...data.monthly.map((m) => m.count));
  const maxGenre = Math.max(1, ...data.top_genres.map((g) => g.count));

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon={Sparkles} label="Titles watched" value={data.distinct_titles} />
        <StatTile icon={Clock} label="Hours" value={Math.round(data.total_hours)} />
        <StatTile icon={Clapperboard} label="Total plays" value={data.total_watches} />
        <StatTile icon={Film} label="Movies" value={data.movies_watched} />
        <StatTile icon={Tv} label="Episodes" value={data.episodes_watched} />
        <StatTile icon={Flame} label="Longest streak" value={`${data.longest_streak}d`} />
      </div>

      {data.first_watch && data.last_watch && (
        <p className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
          <CalendarRange className="h-4 w-4" aria-hidden="true" />
          From {formatDate(data.first_watch)} to {formatDate(data.last_watch)}
        </p>
      )}

      {data.top_shows.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Most watched</h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {data.top_shows.map((title) => (
              <Link
                key={`${title.media_type}-${title.tmdb_id}`}
                to={`/media/${title.tmdb_id}?type=${title.media_type}`}
                className="w-28 shrink-0"
              >
                <div className="aspect-[2/3] overflow-hidden rounded-lg bg-[hsl(var(--muted))]">
                  {title.poster_path ? (
                    <img
                      src={getPosterUrl(title.poster_path, 'w185')}
                      alt={title.title}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <Film className="h-8 w-8 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <p className="mt-1 line-clamp-1 text-sm font-medium">{title.title}</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  {title.count} {title.count === 1 ? 'play' : 'plays'}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {data.top_genres.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Top genres</h2>
          <ul className="space-y-2">
            {data.top_genres.map((genre) => (
              <li key={genre.genre} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-sm">{genre.genre}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
                  <div
                    className="h-full rounded-full bg-[hsl(var(--primary))]"
                    style={{ width: `${(genre.count / maxGenre) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-sm text-[hsl(var(--muted-foreground))]">
                  {genre.count}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">By month</h2>
        <div className="flex h-28 items-end gap-1.5">
          {data.monthly.map((month, index) => (
            <div key={month.month} className="flex h-full flex-1 flex-col items-center">
              <div className="flex w-full flex-1 items-end">
                <div
                  className="w-full rounded-t bg-[hsl(var(--primary))]"
                  style={{ height: `${maxMonth ? (month.count / maxMonth) * 100 : 0}%` }}
                  title={`${month.count} in month ${month.month}`}
                />
              </div>
              <span className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                {MONTH_LABELS[index]}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function WrappedPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const { data, isLoading, isError } = useWrapped(year);
  const years = Array.from({ length: 5 }, (_, index) => currentYear - index);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
      <div className="mb-6 rounded-xl bg-gradient-to-br from-[hsl(var(--primary))] to-purple-600 p-6 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium opacity-90">
              <Sparkles className="h-4 w-4" aria-hidden="true" /> Your Wrapped
            </p>
            <h1 className="mt-1 text-3xl font-bold">{year}</h1>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="opacity-90">Year</span>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="rounded-md border border-white/40 bg-white/10 px-2 py-1 text-sm text-white focus:outline-none"
            >
              {years.map((option) => (
                <option key={option} value={option} className="text-black">
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <p className="py-12 text-center text-sm text-[hsl(var(--destructive))]">
          Could not load your Wrapped. Please try again.
        </p>
      ) : !data || data.total_watches === 0 ? (
        <div className="py-12 text-center text-[hsl(var(--muted-foreground))]">
          <Clapperboard className="mx-auto h-10 w-10" aria-hidden="true" />
          <p className="mt-3">No watch history for {year} yet.</p>
          <Link to="/stats" className="mt-2 inline-block text-sm text-[hsl(var(--primary))] hover:underline">
            Back to stats
          </Link>
        </div>
      ) : (
        <Recap data={data} />
      )}
    </div>
  );
}
