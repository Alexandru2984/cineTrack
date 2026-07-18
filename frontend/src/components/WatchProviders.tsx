import { useState } from 'react';
import { Tv } from 'lucide-react';
import { useWatchProviders } from '@/hooks/useMedia';
import { getLogoUrl } from '@/lib/utils';
import type { WatchProviderEntry } from '@/types';

const REGIONS: [string, string][] = [
  ['RO', 'Romania'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['NL', 'Netherlands'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
];

function ProviderRow({ label, providers }: { label: string; providers: WatchProviderEntry[] }) {
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
        {label}
      </span>
      <ul className="flex flex-wrap gap-2">
        {providers.map((provider) => (
          <li key={provider.provider_id}>
            {provider.logo_path ? (
              <img
                src={getLogoUrl(provider.logo_path)}
                alt={provider.name}
                title={provider.name}
                loading="lazy"
                decoding="async"
                className="h-10 w-10 rounded-lg border border-[hsl(var(--border))] object-cover"
              />
            ) : (
              <span className="flex h-10 items-center rounded-lg border border-[hsl(var(--border))] px-2 text-xs">
                {provider.name}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WatchProviders({ tmdbId, mediaType }: { tmdbId: number; mediaType: string }) {
  const [region, setRegion] = useState<string | undefined>(undefined);
  const { data, isLoading } = useWatchProviders(String(tmdbId), mediaType, region);

  // Keep the section out of the layout until the first response arrives.
  if (isLoading && !data) return null;
  if (!data) return null;

  // Default every field so an unexpected response shape renders an empty
  // widget instead of throwing into the page's error boundary.
  const stream = data.stream ?? [];
  const rent = data.rent ?? [];
  const buy = data.buy ?? [];
  const activeRegion = region ?? data.region ?? 'US';
  const options = REGIONS.some(([code]) => code === activeRegion)
    ? REGIONS
    : [[activeRegion, activeRegion] as [string, string], ...REGIONS];
  const hasAny = stream.length > 0 || rent.length > 0 || buy.length > 0;

  return (
    <section className="mt-8 rounded-lg border border-[hsl(var(--border))] p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Tv className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" /> Where to watch
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[hsl(var(--muted-foreground))]">Region</span>
          <select
            value={activeRegion}
            onChange={(e) => setRegion(e.target.value)}
            className="rounded-md border border-[hsl(var(--input))] bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          >
            {options.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {hasAny ? (
        <div className="space-y-3">
          <ProviderRow label="Stream" providers={stream} />
          <ProviderRow label="Rent" providers={rent} />
          <ProviderRow label="Buy" providers={buy} />
        </div>
      ) : (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          No streaming, rental, or purchase options are listed for {activeRegion}.
        </p>
      )}

      {/* JustWatch attribution is required wherever this data is shown. */}
      <p className="mt-4 border-t border-[hsl(var(--border))] pt-3 text-xs text-[hsl(var(--muted-foreground))]">
        Streaming availability data provided by{' '}
        <a
          href={data.link ?? 'https://www.justwatch.com'}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[hsl(var(--primary))] hover:underline"
        >
          JustWatch
        </a>
        .
      </p>
    </section>
  );
}
