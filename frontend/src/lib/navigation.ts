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
