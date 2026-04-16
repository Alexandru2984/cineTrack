import { useState } from 'react';
import { useSearch } from '@/hooks/useMedia';
import { MediaCard } from '@/components/MediaCard';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Search as SearchIcon } from 'lucide-react';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<string>('');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useSearch(query, type || undefined, page);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">
      <h1 className="text-3xl font-bold">Search</h1>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[hsl(var(--muted-foreground))]" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="Search movies & TV shows..."
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
        </div>
        <select
          value={type}
          onChange={(e) => { setType(e.target.value); setPage(1); }}
          className="rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
        >
          <option value="">All</option>
          <option value="movie">Movies</option>
          <option value="tv">TV Shows</option>
        </select>
      </div>

      {isLoading && <LoadingSpinner />}

      {data && (
        <>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{data.total_results} results</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {data.results.map((item) => (
              <MediaCard key={`${item.id}-${item.media_type || type}`} item={{ ...item, media_type: item.media_type || type || undefined }} />
            ))}
          </div>

          {data.total_pages > 1 && (
            <div className="flex items-center justify-center gap-4 pt-4">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm">Page {data.page} of {data.total_pages}</span>
              <button
                disabled={page >= data.total_pages}
                onClick={() => setPage(page + 1)}
                className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {!query && (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <SearchIcon className="mx-auto h-12 w-12 mb-4 opacity-50" />
          <p>Start typing to search for movies and TV shows</p>
        </div>
      )}
    </div>
  );
}
