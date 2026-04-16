import { useMyStats, useHeatmap, useGenreDistribution, useMonthlyActivity } from '@/hooks/useStats';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import CalendarHeatmap from 'react-calendar-heatmap';
import 'react-calendar-heatmap/dist/styles.css';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Film, Tv, Clock, Flame, Trophy, Zap } from 'lucide-react';

const COLORS = ['#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#ede9fe', '#6d28d9', '#5b21b6', '#7c3aed'];

export default function StatsPage() {
  const { data: stats, isLoading } = useMyStats();
  const { data: heatmap } = useHeatmap();
  const { data: genres } = useGenreDistribution();
  const { data: monthly } = useMonthlyActivity();

  if (isLoading) return <LoadingSpinner />;

  const today = new Date();
  const startDate = new Date(today.getFullYear(), 0, 1);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-8">
      <h1 className="text-3xl font-bold">Statistics</h1>

      {/* Stats overview */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard icon={<Film className="h-5 w-5" />} label="Movies" value={stats.total_movies} />
          <StatCard icon={<Tv className="h-5 w-5" />} label="TV Shows" value={stats.total_shows} />
          <StatCard icon={<Zap className="h-5 w-5" />} label="Episodes" value={stats.total_episodes} />
          <StatCard icon={<Clock className="h-5 w-5" />} label="Hours" value={Math.round(stats.total_hours)} />
          <StatCard icon={<Flame className="h-5 w-5" />} label="Current Streak" value={`${stats.current_streak}d`} />
          <StatCard icon={<Trophy className="h-5 w-5" />} label="Best Streak" value={`${stats.longest_streak}d`} />
        </div>
      )}

      {/* Heatmap */}
      <div className="rounded-lg border border-[hsl(var(--border))] p-6 bg-[hsl(var(--card))]">
        <h2 className="text-lg font-semibold mb-4">Watch Activity Heatmap</h2>
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
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly activity */}
        {monthly && monthly.length > 0 && (
          <div className="rounded-lg border border-[hsl(var(--border))] p-6 bg-[hsl(var(--card))]">
            <h2 className="text-lg font-semibold mb-4">Monthly Activity</h2>
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
            <h2 className="text-lg font-semibold mb-4">Genre Distribution</h2>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={genres} dataKey="count" nameKey="genre" cx="50%" cy="50%" outerRadius={100} label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {genres.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <style>{`
        .react-calendar-heatmap .color-empty { fill: hsl(var(--muted)); }
        .react-calendar-heatmap .color-scale-1 { fill: hsl(262 83% 58% / 0.25); }
        .react-calendar-heatmap .color-scale-2 { fill: hsl(262 83% 58% / 0.5); }
        .react-calendar-heatmap .color-scale-3 { fill: hsl(262 83% 58% / 0.75); }
        .react-calendar-heatmap .color-scale-4 { fill: hsl(var(--primary)); }
        .react-calendar-heatmap text { fill: hsl(var(--muted-foreground)); font-size: 8px; }
      `}</style>
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
