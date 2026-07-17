import type { MediaType } from '@/types';

export interface TrackingLookupTarget {
  tmdb_id: number;
  media_type: MediaType;
}

const LOOKUP_BATCH_SIZE = 100;

export function buildTrackingLookupBatches(
  targets: readonly TrackingLookupTarget[],
): TrackingLookupTarget[][] {
  const unique = new Map<string, TrackingLookupTarget>();
  for (const target of targets) {
    if (!Number.isInteger(target.tmdb_id) || target.tmdb_id <= 0) continue;
    unique.set(`${target.media_type}:${target.tmdb_id}`, target);
  }

  const items = Array.from(unique.values());
  const batches: TrackingLookupTarget[][] = [];
  for (let offset = 0; offset < items.length; offset += LOOKUP_BATCH_SIZE) {
    batches.push(items.slice(offset, offset + LOOKUP_BATCH_SIZE));
  }
  return batches;
}
