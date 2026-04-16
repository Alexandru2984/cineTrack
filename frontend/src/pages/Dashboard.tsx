import { useTrending } from '@/hooks/useMedia';
import { useMyStats, useHeatmap } from '@/hooks/useStats';
import { useAuthStore } from '@/store/auth';
import { MediaCard } from '@/components/MediaCard';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import CalendarHeatmap from 'react-calendar-heatmap';
import 'react-calendar-heatmap/dist/styles.css';
import { Film, Tv, Clock, Flame } from 'lucide-react';

export default function Dashboard() {
  const user = useAuthStore((s) => s.user);
  const { data: trending, isLoading: trendingLoading } = useTrending();
  const { data: stats } = useMyStats();
  const { data: heatmap } = useHeatmap();

  const today = new Date();
  const startDate = new Date(today.getFullYear(), 0, 1);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Welcome back, {user?.username}!</h1>
        <p className="text-[hsl(var(--muted-foreground))] mt-1">Here's your watching overview</p>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={<Film className="h-5 w-5" />} label="Movies" value={stats.total_movies} />
          <StatCard icon={<Tv className="h-5 w-5" />} label="Shows" value={stats.total_shows} />
          <StatCard icon={<Clock className="h-5 w-5" />} label="Hours Watched" value={Math.round(stats.total_hours)} />
          <StatCard icon={<Flame className="h-5 w-5" />} label="Current Streak" value={`${stats.current_streak}d`} />
        </div>
      )}

      {/* Heatmap */}
      <div className="rounded-lg border border-[hsl(var(--border))] p-6 bg-[hsl(var(--card))]">
        <h2 className="text-lg font-semibold mb-4">Watch Activity</h2>
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
            tooltipDataAttrs={(value: any) => {
              return { 'data-tooltip': value?.date ? `${value.date}: ${value.count || 0} entries` : '' } as any;
            }}
          />
        </div>
      </div>

      {/* Trending */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Trending This Week</h2>
        {trendingLoading ? (
          <LoadingSpinner />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {trending?.results.slice(0, 12).map((item) => (
              <MediaCard key={`${item.id}-${item.media_type}`} item={item} />
            ))}
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
