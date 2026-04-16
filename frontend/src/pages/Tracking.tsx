import { useState } from 'react';
import { useTracking, useUpdateTracking, useDeleteTracking } from '@/hooks/useTracking';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getPosterUrl, STATUS_LABELS, STATUS_COLORS } from '@/lib/utils';
import { Star, Trash2, Heart } from 'lucide-react';
import { Link } from 'react-router-dom';

const TABS = ['all', 'watching', 'plan_to_watch', 'completed', 'on_hold', 'dropped'] as const;

export default function TrackingPage() {
  const [tab, setTab] = useState<string>('all');
  const { data: items, isLoading } = useTracking(tab === 'all' ? undefined : tab);
  const updateTracking = useUpdateTracking();
  const deleteTracking = useDeleteTracking();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">
      <h1 className="text-3xl font-bold">My List</h1>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t
                ? 'bg-[hsl(var(--primary))] text-white'
                : 'border border-[hsl(var(--border))] hover:bg-[hsl(var(--secondary))]'
            }`}
          >
            {t === 'all' ? 'All' : STATUS_LABELS[t]}
          </button>
        ))}
      </div>

      {isLoading && <LoadingSpinner />}

      {items && items.length === 0 && (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <p>No items yet. Start by searching and adding movies or shows!</p>
        </div>
      )}

      <div className="space-y-3">
        {items?.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-4 rounded-lg border border-[hsl(var(--border))] p-3 bg-[hsl(var(--card))]"
          >
            <Link to={`/media/${item.tmdb_id}?type=${item.media_type}`}>
              <img
                src={getPosterUrl(item.poster_path, 'w92')}
                alt={item.title}
                className="h-20 w-14 rounded object-cover"
              />
            </Link>
            <div className="flex-1 min-w-0">
              <Link to={`/media/${item.tmdb_id}?type=${item.media_type}`} className="font-medium hover:text-[hsl(var(--primary))]">
                {item.title}
              </Link>
              <div className="flex items-center gap-2 mt-1">
                <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLORS[item.status]}`} />
                <span className="text-xs text-[hsl(var(--muted-foreground))]">{STATUS_LABELS[item.status]}</span>
                <span className="text-xs text-[hsl(var(--muted-foreground))] capitalize">{item.media_type}</span>
              </div>
              {item.rating && (
                <div className="flex items-center gap-1 mt-1">
                  <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                  <span className="text-xs">{item.rating}/10</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Quick rating */}
              <select
                value={item.status}
                onChange={(e) => updateTracking.mutate({ id: item.id, status: e.target.value })}
                className="rounded border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-xs"
              >
                {Object.entries(STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <button
                onClick={() => updateTracking.mutate({ id: item.id, is_favorite: !item.is_favorite })}
                className="p-1"
              >
                <Heart className={`h-4 w-4 ${item.is_favorite ? 'fill-red-500 text-red-500' : 'text-[hsl(var(--muted-foreground))]'}`} />
              </button>
              <button
                onClick={() => { if (confirm('Remove from list?')) deleteTracking.mutate(item.id); }}
                className="p-1 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))]"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
