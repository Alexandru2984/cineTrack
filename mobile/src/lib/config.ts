const DEFAULT_API_ORIGIN = 'https://vazute.micutu.com';

function resolveApiOrigin(configuredOrigin: string | undefined) {
  const rawOrigin = configuredOrigin?.trim() || DEFAULT_API_ORIGIN;
  let url: URL;

  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error('EXPO_PUBLIC_API_URL must be a valid absolute URL');
  }

  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('EXPO_PUBLIC_API_URL must contain only an origin');
  }
  if (url.protocol !== 'https:' && !(__DEV__ && url.protocol === 'http:')) {
    throw new Error('EXPO_PUBLIC_API_URL must use HTTPS in release builds');
  }

  return url.origin;
}

export const API_ORIGIN = resolveApiOrigin(process.env.EXPO_PUBLIC_API_URL);
export const API_BASE_URL = `${API_ORIGIN}/api`;
export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';
export const USE_R2_IMAGES = process.env.EXPO_PUBLIC_USE_R2_IMAGES !== 'false';
