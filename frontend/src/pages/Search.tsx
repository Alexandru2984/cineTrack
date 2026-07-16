import { useState } from 'react';
import { Clapperboard, Search as SearchIcon, Users } from 'lucide-react';
import { MediaCard } from '@/components/MediaCard';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { UserSearchResults } from '@/components/UserSearchResults';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSearch } from '@/hooks/useMedia';
import { useUserSearch } from '@/hooks/useSocial';
import { getApiErrorMessage } from '@/lib/api';

type SearchMode = 'media' | 'people';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<string>('');
  const [mode, setMode] = useState<SearchMode>('media');
  const [page, setPage] = useState(1);
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const validPeopleQuery = /^[A-Za-z0-9_-]{2,50}$/.test(debouncedQuery);
  const mediaSearch = useSearch(mode === 'media' ? debouncedQuery : '', type || undefined, page);
  const peopleSearch = useUserSearch(
    mode === 'people' && validPeopleQuery ? debouncedQuery : '',
    page,
  );

  const changeMode = (nextMode: SearchMode) => {
    setMode(nextMode);
    setQuery('');
    setPage(1);
  };

  const hasQuery = query.trim().length > 0;
  const peopleValidationError =
    mode === 'people' && hasQuery && query.trim() === debouncedQuery && !validPeopleQuery;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-bold sm:text-3xl">Search</h1>

      <div
        role="tablist"
        aria-label="Search category"
        className="inline-flex rounded-md border border-[hsl(var(--border))] p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'media'}
          onClick={() => changeMode('media')}
          className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium ${
            mode === 'media'
              ? 'bg-[hsl(var(--primary))] text-white'
              : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
          }`}
        >
          <Clapperboard className="h-4 w-4" aria-hidden="true" /> Movies &amp; TV
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'people'}
          onClick={() => changeMode('people')}
          className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium ${
            mode === 'people'
              ? 'bg-[hsl(var(--primary))] text-white'
              : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
          }`}
        >
          <Users className="h-4 w-4" aria-hidden="true" /> People
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <SearchIcon
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label={mode === 'media' ? 'Search movies and TV shows' : 'Search people'}
            autoComplete="off"
            maxLength={mode === 'media' ? 200 : 50}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder={mode === 'media' ? 'Search movies & TV shows...' : 'Search usernames...'}
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent py-2 pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
        </div>
        {mode === 'media' && (
          <select
            aria-label="Media type"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
            className="rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          >
            <option value="">All</option>
            <option value="movie">Movies</option>
            <option value="tv">TV Shows</option>
          </select>
        )}
      </div>

      {peopleValidationError && (
        <p className="text-sm text-[hsl(var(--destructive))]" role="alert">
          Use 2-50 letters, numbers, underscores, or hyphens
        </p>
      )}

      {mode === 'people' && validPeopleQuery && (
        <UserSearchResults
          data={peopleSearch.data}
          isLoading={peopleSearch.isLoading}
          isError={peopleSearch.isError}
          page={page}
          onPageChange={setPage}
        />
      )}

      {mode === 'media' && mediaSearch.isLoading && <LoadingSpinner />}
      {mode === 'media' && mediaSearch.isError && (
        <p className="py-8 text-sm text-[hsl(var(--destructive))]" role="alert">
          {getApiErrorMessage(mediaSearch.error, 'Media search could not be loaded')}
        </p>
      )}

      {mode === 'media' && mediaSearch.data && (
        <>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {mediaSearch.data.total_results} results
          </p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {mediaSearch.data.results.map((item) => (
              <MediaCard
                key={`${item.id}-${item.media_type || type}`}
                item={{ ...item, media_type: item.media_type || type || undefined }}
                showQuickAdd
              />
            ))}
          </div>

          {mediaSearch.data.total_pages > 1 && (
            <div className="flex items-center justify-center gap-4 pt-4">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm">
                Page {mediaSearch.data.page} of {mediaSearch.data.total_pages}
              </span>
              <button
                type="button"
                disabled={page >= mediaSearch.data.total_pages}
                onClick={() => setPage(page + 1)}
                className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {!hasQuery && (
        <div className="py-16 text-center text-[hsl(var(--muted-foreground))]">
          {mode === 'media' ? (
            <Clapperboard className="mx-auto mb-4 h-12 w-12 opacity-50" aria-hidden="true" />
          ) : (
            <Users className="mx-auto mb-4 h-12 w-12 opacity-50" aria-hidden="true" />
          )}
          <p>{mode === 'media' ? 'Search movies and TV shows' : 'Find people'}</p>
        </div>
      )}
    </div>
  );
}
