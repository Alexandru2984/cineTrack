import { Link } from 'react-router-dom';
import { getPosterUrl } from '@/lib/utils';
import type { TmdbSearchResult } from '@/types';
import { Star } from 'lucide-react';

interface Props {
  item: TmdbSearchResult;
}

export function MediaCard({ item }: Props) {
  const title = item.title || item.name || 'Unknown';
  const date = item.release_date || item.first_air_date;
  const type = item.media_type || 'movie';
  const year = date ? new Date(date).getFullYear() : '';

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
      </div>
      <div className="p-3">
        <h3 className="font-medium text-sm line-clamp-2 text-[hsl(var(--card-foreground))]">{title}</h3>
        {year && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{year}</p>}
      </div>
    </Link>
  );
}
