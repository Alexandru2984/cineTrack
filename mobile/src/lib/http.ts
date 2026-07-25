import { API_BASE_URL } from '@/lib/config';

const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

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
  timeoutMs?: number;
}

interface RawMultipartRequestOptions {
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

async function request<T>(
  path: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (callerSignal?.aborted) controller.abort();

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
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
      throw new ApiError(
        callerSignal?.aborted ? 'The request was cancelled' : 'The request timed out',
        0,
      );
    }
    throw new ApiError('Could not connect to Văzute', 0);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export function rawRequest<T>(
  path: string,
  options: RawRequestOptions = {},
): Promise<T> {
  return request<T>(
    path,
    {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    options.signal,
    Math.min(
      MAX_REQUEST_TIMEOUT_MS,
      Math.max(1_000, options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    ),
  );
}

export function rawMultipartRequest<T>(
  path: string,
  form: FormData,
  options: RawMultipartRequestOptions = {},
): Promise<T> {
  return request<T>(
    path,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
      body: form,
    },
    options.signal,
    UPLOAD_TIMEOUT_MS,
  );
}

export function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}
