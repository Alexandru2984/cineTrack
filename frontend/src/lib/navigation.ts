const FALLBACK_PATH = '/';
const RETURN_PATH_LIMIT = 2_048;
const BASE_ORIGIN = 'https://vazute.invalid';

export function safeReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    value.length > RETURN_PATH_LIMIT ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n]/.test(value)
  ) {
    return FALLBACK_PATH;
  }

  try {
    const url = new URL(value, BASE_ORIGIN);
    if (url.origin !== BASE_ORIGIN || url.pathname === '/login') {
      return FALLBACK_PATH;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return FALLBACK_PATH;
  }
}

export function loginPathFor(returnTo: string): string {
  return `/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

/**
 * The public page for a title, which a signed-out visitor can read.
 *
 * `/media/550?type=movie` is the application's page and needs an account; the
 * backend renders `/ro/film/550-…` and `/en/movie/550-…` for everyone, and
 * redirects a bare id like this one to the full address. Anything that is not
 * a TMDB id has no such page, and gets `null`.
 */
export function publicTitlePath(
  locale: 'ro' | 'en',
  type: string | null,
  id: string | undefined,
): string | null {
  if (!id || !/^[1-9][0-9]{0,8}$/.test(id)) return null;
  // The same default as the media page itself.
  const kind = type === 'tv' ? 'tv' : 'movie';
  const segment =
    locale === 'ro' ? (kind === 'tv' ? 'serial' : 'film') : kind === 'tv' ? 'tv' : 'movie';
  return `/${locale}/${segment}/${id}`;
}
