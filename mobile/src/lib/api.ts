import { ApiError, rawRequest, type RawRequestOptions } from '@/lib/http';
import { refreshSession } from '@/lib/session';
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
  const auth = useAuthStore.getState();
  if (authenticated && auth.status === 'offline') {
    throw new ApiError('Connect to the internet to make changes', 0);
  }
  const token = authenticated ? auth.accessToken : null;
  const headers = token
    ? { ...options.headers, Authorization: `Bearer ${token}` }
    : options.headers;

  try {
    return await rawRequest<T>(path, { ...options, headers });
  } catch (error) {
    const mayRefresh =
      authenticated &&
      options.retryAfterRefresh !== false &&
      error instanceof ApiError &&
      error.status === 401 &&
      useAuthStore.getState().status === 'authenticated';
    if (!mayRefresh) throw error;

    const accessToken = await refreshSession();
    return rawRequest<T>(path, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${accessToken}` },
    });
  }
}
