import { API_BASE_URL } from '@/lib/config';

const REQUEST_TIMEOUT_MS = 15_000;

interface ErrorPayload {
  message?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Parsed error body, so callers can read flags such as two_factor_required. */
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The backend answers a login that still needs its second factor with a 401
 * carrying `two_factor_required`, so the client can switch to the code step
 * instead of showing a credential error.
 */
export function isTwoFactorRequired(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    typeof error.payload === 'object' &&
    error.payload !== null &&
    (error.payload as { two_factor_required?: boolean }).two_factor_required === true
  );
}

export interface RawRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function withQuery(
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export async function rawRequest<T>(
  path: string,
  options: RawRequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    if (!response.ok) {
      const message =
        typeof payload === 'object' && payload !== null && 'message' in payload
          ? (payload as ErrorPayload).message
          : undefined;
      throw new ApiError(
        message || `Request failed with status ${response.status}`,
        response.status,
        payload,
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError('The request timed out', 0);
    }
    throw new ApiError('Could not connect to Văzute', 0);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}
