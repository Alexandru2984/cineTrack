import { File, UploadType } from 'expo-file-system';

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
    /**
     * The failure this wraps, when it wraps one.
     *
     * Without it a rejected request is indistinguishable from every other
     * rejected request, and the reason is gone for good. That cost days on the
     * avatar upload: the native layer reported precisely why it could not build
     * the request, and both this class and the fetch polyfill above it threw
     * that away, leaving a message about connectivity for a failure that never
     * touched the network.
     */
    options?: { cause?: unknown },
  ) {
    super(message, options);
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

/** One file, and the multipart field the server reads it from. */
export interface MultipartFile {
  /** A `file://` URI. The file must exist when the upload starts. */
  uri: string;
  fieldName: string;
  mimeType: string;
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
        undefined,
        { cause: error },
      );
    }
    throw new ApiError('Could not connect to Văzute', 0, undefined, { cause: error });
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

/**
 * The original `fetch` upload path, kept only for the multi-file import.
 *
 * See `rawMultipartRequest` for why single-file uploads no longer use it.
 */
export function rawFormDataRequest<T>(
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

/**
 * Say what actually went wrong with an upload.
 *
 * A rejected `fetch` carries nothing worth showing, which is why every other
 * failure here becomes a sentence about connectivity. A native upload is not
 * like that: it fails with a reason, and hiding it is how this path stayed
 * broken and undiagnosable for weeks. Preserving the cause on the error object
 * was not enough on its own — nothing displays it, so nothing reads it.
 */
function uploadFailureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message.trim() : '';
  return reason ? `The upload failed: ${reason}` : 'Could not connect to Văzute';
}

/**
 * Upload one file as a multipart request, natively.
 *
 * `fetch` with a `FormData` carrying a `{ uri }` part is the documented React
 * Native way to do this, and it is the way that did not work here: the native
 * networking module refused to assemble the body and reported why, then
 * whatwg-fetch replaced that with a bare "Network request failed" and this
 * module replaced it again with a connection message. Nothing ever reached the
 * server, and nothing ever reached a log.
 *
 * expo-file-system streams the file from native code instead, so there is no
 * FormData translation to go wrong and a failure arrives with its reason
 * attached.
 */
export async function rawMultipartRequest<T>(
  path: string,
  file: MultipartFile,
  options: RawMultipartRequestOptions = {},
): Promise<T> {
  // Same shape as `request` above: one controller carries both the caller's
  // cancellation and the timeout, so a native upload cannot outlive either. It
  // has to be forwarded into the upload itself — checking it around the call
  // would abandon the promise while the transfer kept running.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted) controller.abort();

  let result: { status: number; body: string };
  try {
    result = await new File(file.uri).upload(`${API_BASE_URL}${path}`, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: file.fieldName,
      mimeType: file.mimeType,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(
        options.signal?.aborted ? 'The request was cancelled' : 'The request timed out',
        0,
        undefined,
        { cause: error },
      );
    }
    throw new ApiError(uploadFailureMessage(error), 0, undefined, { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }

  let payload: unknown = undefined;
  if (result.body) {
    try {
      payload = JSON.parse(result.body);
    } catch {
      payload = undefined;
    }
  }

  if (result.status < 200 || result.status >= 300) {
    const message =
      typeof payload === 'object' && payload !== null && 'message' in payload
        ? (payload as ErrorPayload).message
        : undefined;
    throw new ApiError(
      message || `Request failed with status ${result.status}`,
      result.status,
      payload,
    );
  }

  return payload as T;
}

export function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}
