const configuredOrigin = process.env.EXPO_PUBLIC_API_URL?.trim();

export const API_ORIGIN = (configuredOrigin || 'https://vazute.micutu.com').replace(/\/+$/, '');
export const API_BASE_URL = `${API_ORIGIN}/api`;
export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';
