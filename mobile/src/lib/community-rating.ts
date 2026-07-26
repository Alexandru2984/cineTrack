import { z } from 'zod';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import type { CommunityRating, MediaType } from '@/types';

// The server withholds average/distribution below its display floor, so both
// are nullable; distribution, when present, is exactly ten non-negative
// buckets (score 1 … 10).
const communityRatingSchema = z.object({
  count: z.number().int().min(0),
  average: z.number().min(1).max(10).nullable(),
  distribution: z.array(z.number().int().min(0)).length(10).nullable(),
});

export async function fetchCommunityRating(
  id: string,
  type: MediaType,
): Promise<CommunityRating> {
  const payload = await apiRequest<unknown>(
    withQuery(`/media/${encodeURIComponent(id)}/community-rating`, { type }),
  );
  return communityRatingSchema.parse(payload);
}
