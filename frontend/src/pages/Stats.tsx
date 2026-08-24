import { useMemo } from 'react';
import { useMyStats, useHeatmap, useGenreDistribution, useMonthlyActivity } from '@/hooks/useStats';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import CalendarHeatmap from 'react-calendar-heatmap';
import 'react-calendar-heatmap/dist/styles.css';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Link } from 'react-router';
import { Film, Tv, Clock, Flame, Trophy, Zap, Sparkles } from 'lucide-react';
import { useT } from '@/hooks/useT';

const COLORS = ['#8b5cf6', '#a78bfa', '#c4b5fd', '#7c3aed', '#6d28d9', '#5b21b6'];
/** Everything outside the top slices shares this, so the eye reads it as one
 *  bucket rather than another competing colour. */
const OTHER_COLOR = 'hsl(var(--muted-foreground))';

/** How many genres get their own slice.
 *
 *  A library of a few hundred titles spans thirty-odd genres. Drawing them all
 *  puts thirty labels around a circle three hundred pixels wide, which overlap
 *  into an unreadable smear — and the tail is single-digit percentages nobody
 *  is reading anyway. Six named slices plus a bucket says the same thing and
 *  can actually be read. */
const TOP_GENRE_SLICES = 6;

interface GenreSlice {
  genre: string;
  count: number;
}

/** Keep the largest genres and fold the rest into one bucket.
 *
 *  Returns the bucket last so it renders in the muted colour and reads as the
 *  remainder rather than as a genre of its own. */
function foldGenres(genres: GenreSlice[], otherLabel: string): GenreSlice[] {
  if (genres.length <= TOP_GENRE_SLICES + 1) return genres;

  const ranked = [...genres].sort((left, right) => right.count - left.count);
  const top = ranked.slice(0, TOP_GENRE_SLICES);
  const rest = ranked.slice(TOP_GENRE_SLICES);
  const otherCount = rest.reduce((total, slice) => total + slice.count, 0);
  return otherCount > 0 ? [...top, { genre: otherLabel, count: otherCount }] : top;
}

export default function StatsPage() {
  const t = useT();
  const { data: stats, isLoading } = useMyStats();
  const { data: heatmap } = useHeatmap();
  const { data: genres } = useGenreDistribution();

  const otherLabel = t('stats.genreOther');
  const genreSlices = useMemo(() => foldGenres(genres ?? [], otherLabel), [genres, otherLabel]);
  const genreTotal = genreSlices.reduce((total, slice) => total + slice.count, 0) || 1;
  const { data: monthly } = useMonthlyActivity();

  if (isLoading) return <LoadingSpinner />;

  const today = new Date();
  const startDate = new Date(today.getFullYear(), 0, 1);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">{t('stats.title')}</h1>
        <Link
          to="/wrapped"
          className="flex items-center gap-2 rounded-md bg-gradient-to-br from-[hsl(var(--primary))] to-purple-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" /> {t('stats.yourWrapped')}
        </Link>
      </div>

      {/* Stats overview */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard icon={<Film className="h-5 w-5" />} label={t('stats.movies')} value={stats.total_movies} />
          <StatCard icon={<Tv className="h-5 w-5" />} label={t('stats.tvShows')} value={stats.total_shows} />
          <StatCard icon={<Zap className="h-5 w-5" />} label={t('stats.episodes')} value={stats.total_episodes} />
          <StatCard icon={<Clock className="h-5 w-5" />} label={t('stats.hours')} value={Math.round(stats.total_hours)} />
          <StatCard icon={<Flame className="h-5 w-5" />} label={t('stats.currentStreak')} value={`${stats.current_streak}d`} />
          <StatCard icon={<Trophy className="h-5 w-5" />} label={t('stats.bestStreak')} value={`${stats.longest_streak}d`} />
        </div>
      )}

      {/* Heatmap */}
      <div className="rounded-lg border border-[hsl(var(--border))] p-6 bg-[hsl(var(--card))]">
        <h2 className="text-lg font-semibold mb-4">{t('stats.heatmapTitle')}</h2>
        {/* Scrolls rather than shrinks. A year of squares compressed into a
            phone width is a grey smudge; at a fixed minimum they stay square
            and the month labels stay apart. */}
        <div className="overflow-x-auto">
          <div className="min-w-[46rem]">
            <CalendarHeatmap
              startDate={startDate}
              endDate={today}
              gutterSize={2}
              showWeekdayLabels
              values={heatmap?.map((d) => ({ date: d.date, count: d.count })) || []}
              classForValue={(value) => {
                if (!value || !value.count) return 'color-empty';
                if (value.count >= 8) return 'color-scale-4';
                if (value.count >= 5) return 'color-scale-3';
                if (value.count >= 3) return 'color-scale-2';
                return 'color-scale-1';
              }}
              // Without this a square says nothing: you can see that a day was
              // busier than its neighbour and never what either number was.
              titleForValue={(value) =>
                value?.date
                  ? t('stats.heatmapDay', { date: value.date, count: value.count ?? 0 })
                  : ''
              }
            />
          </div>
        </div>
        {/* The scale, so the shades mean something. Four unexplained tones of
            purple are decoration. */}
        <div className="mt-2 flex items-center justify-end gap-1.5 text-xs text-[hsl(var(--muted-foreground))]">
          <span>{t('stats.heatmapLess')}</span>
          {['color-empty', 'color-scale-1', 'color-scale-2', 'color-scale-3', 'color-scale-4'].map(
            (tone) => (
              <span key={tone} className={`heatmap-swatch ${tone}`} aria-hidden="true" />
            ),
          )}
          <span>{t('stats.heatmapMore')}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly activity */}
        {monthly && monthly.length > 0 && (
          <div className="rounded-lg border border-[hsl(var(--border))] p-6 bg-[hsl(var(--card))]">
            <h2 className="text-lg font-semibold mb-4">{t('stats.monthlyActivity')}</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={[...monthly].reverse()}>
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="hours" fill="hsl(262 83% 58%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Genre distribution */}
        {genres && genres.length > 0 && (
          <div className="rounded-lg border border-[hsl(var(--border))] p-6 bg-[hsl(var(--card))]">
            <h2 className="text-lg font-semibold mb-4">{t('stats.genreDistribution')}</h2>
            {/* No labels on the arcs. They were the whole problem: every slice
                drew its name and percentage around a circle, and with thirty
                genres they landed on top of each other. A legend cannot
                overlap, and it has room for the number as well as the name. */}
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={genreSlices}
                  dataKey="count"
                  nameKey="genre"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  innerRadius={55}
                  paddingAngle={2}
                >
                  {genreSlices.map((slice, index) => (
                    <Cell
                      key={slice.genre}
                      fill={slice.genre === otherLabel ? OTHER_COLOR : COLORS[index % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  // Recharts types the value loosely because a chart can carry
                  // anything; every slice here is a count.
                  formatter={(value) => [
                    t('stats.genreTitles', { count: Number(value) || 0 }),
                    '',
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {genreSlices.map((slice, index) => (
                <li key={slice.genre} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{
                      backgroundColor:
                        slice.genre === otherLabel ? OTHER_COLOR : COLORS[index % COLORS.length],
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{slice.genre}</span>
                  <span className="tabular-nums text-[hsl(var(--muted-foreground))]">
                    {Math.round((slice.count / genreTotal) * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] p-4 bg-[hsl(var(--card))]">
      <div className="flex items-center gap-2 text-[hsl(var(--muted-foreground))]">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold">{value}</p>
    </div>
  );
}
