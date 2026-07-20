import type { Href } from 'expo-router';

import type { MediaType } from '@/types';

export const PUBLIC_WEB_ORIGIN = 'https://vazute.micutu.com';

const MAX_REDIRECT_LENGTH = 256;
const MAX_TMDB_ID = 2_147_483_647;
const MEDIA_PATH = /^\/media\/([1-9]\d{0,9})\?type=(movie|tv)$/;
const EPISODE_PATH =
  /^\/episodes\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_PATH = /^\/profile\/[A-Za-z0-9](?:[A-Za-z0-9_-]{1,48}[A-Za-z0-9])$/;

export function mediaPath(tmdbId: number | string, type: MediaType) {
  return `/media/${tmdbId}?type=${type}` as const;
}

export function episodePath(episodeId: string) {
  return `/episodes/${episodeId}` as const;
}

export function profilePath(username: string) {
  return `/profile/${username}` as const;
}

export function publicUrl(path: string) {
  return `${PUBLIC_WEB_ORIGIN}${path}`;
}

/** Accept only canonical in-app destinations; never pass an arbitrary URL to the router. */
export function safePostAuthRedirect(value: string | string[] | undefined): Href | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    !candidate ||
    candidate.length > MAX_REDIRECT_LENGTH ||
    candidate.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return null;
  }

  const mediaMatch = MEDIA_PATH.exec(candidate);
  if (mediaMatch) {
    const tmdbId = Number(mediaMatch[1]);
    if (Number.isSafeInteger(tmdbId) && tmdbId <= MAX_TMDB_ID) {
      return candidate as Href;
    }
  }

  if (EPISODE_PATH.test(candidate) || PROFILE_PATH.test(candidate)) {
    return candidate as Href;
  }

  return null;
}
