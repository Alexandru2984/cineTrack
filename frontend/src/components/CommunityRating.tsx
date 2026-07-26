import { Star, Users } from 'lucide-react';
import { useCommunityRating } from '@/hooks/useMedia';

function RatingDistribution({
  distribution,
  count,
  average,
}: {
  distribution: number[];
  count: number;
  average: number;
}) {
  // Scale bar length to the busiest bucket so the shape is readable even when
  // every rating clusters on one or two scores.
  const max = Math.max(...distribution, 1);
  const summary = `Average ${average.toFixed(1)} out of 10 from ${count} ${
    count === 1 ? 'rating' : 'ratings'
  }.`;

  return (
    <div role="img" aria-label={summary} className="space-y-1.5">
      {distribution
        .map((bucket, index) => ({ score: index + 1, bucket }))
        .reverse()
        .map(({ score, bucket }) => {
          const barWidth = Math.round((bucket / max) * 100);
          const share = count > 0 ? Math.round((bucket / count) * 100) : 0;
          return (
            <div key={score} className="flex items-center gap-2 text-xs">
              <span className="w-6 shrink-0 text-right tabular-nums text-[hsl(var(--muted-foreground))]">
                {score}
              </span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[hsl(var(--secondary))]">
                <div
                  className="h-full rounded-full bg-[hsl(var(--primary))]"
                  style={{ width: `${barWidth}%` }}
                  title={`${bucket} (${share}%)`}
                />
              </div>
              <span className="w-8 shrink-0 tabular-nums text-[hsl(var(--muted-foreground))]">
                {bucket}
              </span>
            </div>
          );
        })}
    </div>
  );
}

/**
 * Community rating panel for a title: the aggregate of Văzute members' own
 * 1–10 ratings, shown alongside (not replacing) TMDB's score. Renders nothing
 * until at least one member has rated the title; below the server's display
 * floor only the member count is shown, never a number that would be a single
 * private rating.
 */
export function CommunityRating({ mediaId, mediaType }: { mediaId: string; mediaType: string }) {
  const { data, isLoading } = useCommunityRating(mediaId, mediaType);

  if (isLoading && !data) return null;
  if (!data || data.count === 0) return null;

  const { count, average, distribution } = data;
  const memberLabel = count === 1 ? 'member' : 'members';

  return (
    <section className="mt-8 rounded-lg border border-[hsl(var(--border))] p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Users className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" /> Văzute community
        </h2>
        {average != null && (
          <span className="flex items-baseline gap-1">
            <Star
              className="h-5 w-5 self-center fill-[hsl(var(--primary))] text-[hsl(var(--primary))]"
              aria-hidden="true"
            />
            <span className="text-2xl font-bold">{average.toFixed(1)}</span>
            <span className="text-sm text-[hsl(var(--muted-foreground))]">/10</span>
          </span>
        )}
      </div>

      {average != null && distribution ? (
        <>
          <RatingDistribution distribution={distribution} count={count} average={average} />
          <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
            Based on {count} member {count === 1 ? 'rating' : 'ratings'}. Individual ratings stay
            private.
          </p>
        </>
      ) : (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          Rated by {count} {memberLabel}. The community average appears once a few members have
          rated it.
        </p>
      )}
    </section>
  );
}
