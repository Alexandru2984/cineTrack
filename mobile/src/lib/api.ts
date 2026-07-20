import { ApiError, rawRequest, type RawRequestOptions } from '@/lib/http';
import { currentSessionGeneration, refreshSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';

interface ApiRequestOptions extends RawRequestOptions {
  authenticated?: boolean;
  retryAfterRefresh?: boolean;
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const authenticated = options.authenticated ?? true;
  const generation = currentSessionGeneration();
  const auth = useAuthStore.getState();
  if (authenticated && auth.status === 'offline') {
    throw new ApiError('Connect to the internet to make changes', 0);
  }
  const token = authenticated ? auth.accessToken : null;
  const headers = token
    ? { ...options.headers, Authorization: `Bearer ${token}` }
    : options.headers;

  try {
    const response = await rawRequest<T>(path, { ...options, headers });
    if (authenticated && generation !== currentSessionGeneration()) {
      throw new ApiError('Session changed while the request was in progress', 401);
    }
    return response;
  } catch (error) {
    const mayRefresh =
      authenticated &&
      generation === currentSessionGeneration() &&
      options.retryAfterRefresh !== false &&
      error instanceof ApiError &&
      error.status === 401 &&
      useAuthStore.getState().status === 'authenticated';
    if (!mayRefresh) throw error;

    const accessToken = await refreshSession();
    if (generation !== currentSessionGeneration()) {
      throw new ApiError('Session changed while the request was in progress', 401);
    }
    const response = await rawRequest<T>(path, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
    });
    if (generation !== currentSessionGeneration()) {
      throw new ApiError('Session changed while the request was in progress', 401);
    }
    return response;
  }
}
