import { z } from 'zod';

import { apiRequest } from '@/lib/api';
import { withQuery } from '@/lib/http';
import type { MediaType, WatchProviders } from '@/types';

const JUSTWATCH_FALLBACK = 'https://www.justwatch.com/';

const providerSchema = z.object({
  provider_id: z.number().int().positive().max(2_147_483_647),
  name: z.string().trim().min(1).max(100),
  logo_path: z
    .string()
    .regex(/^\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i)
    .max(200)
    .nullable(),
});

const providerListSchema = z.array(providerSchema).max(100);
const watchProvidersSchema = z.object({
  region: z.string().regex(/^[A-Z]{2}$/),
  link: z.string().max(2_048).nullable(),
  stream: providerListSchema,
  rent: providerListSchema,
  buy: providerListSchema,
});

export function safeWatchProviderLink(link: string | null | undefined) {
  if (!link) return JUSTWATCH_FALLBACK;
  try {
    const url = new URL(link.trim());
    const host = url.hostname.toLowerCase();
    const trustedHost =
      host === 'themoviedb.org' ||
      host.endsWith('.themoviedb.org') ||
      host === 'justwatch.com' ||
      host.endsWith('.justwatch.com');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !trustedHost
    ) {
      return JUSTWATCH_FALLBACK;
    }
    url.hash = '';
    return url.href;
  } catch {
    return JUSTWATCH_FALLBACK;
  }
}

export async function fetchWatchProviders(
  id: string,
  type: MediaType,
): Promise<WatchProviders> {
  const payload = await apiRequest<unknown>(
    withQuery(`/media/${encodeURIComponent(id)}/watch-providers`, { type }),
  );
  return watchProvidersSchema.parse(payload) as WatchProviders;
}
