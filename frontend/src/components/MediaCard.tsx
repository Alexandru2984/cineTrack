import { Link } from 'react-router-dom';
import { getPosterUrl } from '@/lib/utils';
import type { TmdbSearchResult } from '@/types';
import { Star, Plus, Eye, BookmarkPlus } from 'lucide-react';
import { useCreateTracking } from '@/hooks/useTracking';
import { useState } from 'react';

interface Props {
  item: TmdbSearchResult;
  showQuickAdd?: boolean;
}

export function MediaCard({ item, showQuickAdd = false }: Props) {
  const title = item.title || item.name || 'Unknown';
  const date = item.release_date || item.first_air_date;
  const type = item.media_type || 'movie';
  const year = date ? new Date(date).getFullYear() : '';
  const createTracking = useCreateTracking();
  const [added, setAdded] = useState<string | null>(null);

  const handleQuickAdd = (e: React.MouseEvent, status: string) => {
    e.preventDefault();
    e.stopPropagation();
    createTracking.mutate(
      { tmdb_id: item.id, media_type: type, status },
      { onSuccess: () => setAdded(status) }
    );
  };

  return (
    <Link
      to={`/media/${item.id}?type=${type}`}
      className="group block rounded-lg overflow-hidden border border-[hsl(var(--border))] bg-[hsl(var(--card))] hover:border-[hsl(var(--primary))] transition-colors"
    >
      <div className="aspect-[2/3] relative overflow-hidden bg-[hsl(var(--muted))]">
        <img
          src={getPosterUrl(item.poster_path)}
          alt={title}
          className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-300"
          loading="lazy"
        />
        {item.vote_average != null && item.vote_average > 0 && (
          <div className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-xs text-white">
            <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
            {item.vote_average.toFixed(1)}
          </div>
        )}
        <div className="absolute top-2 left-2 rounded-full bg-[hsl(var(--primary))]/90 px-2 py-0.5 text-xs text-white capitalize">
          {type === 'tv' ? 'TV' : 'Movie'}
        </div>
        {showQuickAdd && !added && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="flex gap-1 justify-center">
              <button
                onClick={(e) => handleQuickAdd(e, 'watching')}
                className="flex items-center gap-1 rounded-full bg-[hsl(var(--primary))] px-2 py-1 text-xs text-white hover:opacity-90"
                title="Watching"
              >
                <Eye className="h-3 w-3" /> Watching
              </button>
              <button
                onClick={(e) => handleQuickAdd(e, 'completed')}
                className="flex items-center gap-1 rounded-full bg-green-600 px-2 py-1 text-xs text-white hover:opacity-90"
                title="Completed"
              >
                <Plus className="h-3 w-3" /> Done
              </button>
              <button
                onClick={(e) => handleQuickAdd(e, 'plan_to_watch')}
                className="flex items-center gap-1 rounded-full bg-blue-600 px-2 py-1 text-xs text-white hover:opacity-90"
                title="Plan to Watch"
              >
                <BookmarkPlus className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
        {added && (
          <div className="absolute bottom-0 left-0 right-0 bg-green-600/90 p-2 text-center text-xs text-white font-medium">
            ✓ Added as {added.replace('_', ' ')}
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="font-medium text-sm line-clamp-2 text-[hsl(var(--card-foreground))]">{title}</h3>
        {year && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{year}</p>}
      </div>
    </Link>
  );
}
