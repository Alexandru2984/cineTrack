import axios from 'axios';
import { useAuthStore } from '@/store/auth';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
  timeout: 15_000,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise: Promise<string> | null = null;
/// Thrown when a rotation completes into a session that has since been replaced.
export class SessionSupersededError extends Error {
  constructor() {
    super('Session superseded');
    this.name = 'SessionSupersededError';
  }
}

/// Did the server refuse the credential, or did the request never get an answer?
///
/// The distinction is the whole of M06. Only the first means the session is
/// gone; the second is a transport problem the page should ride out.
export function isCredentialRejection(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === 401 || status === 403;
}

/// Persisted intent to end the session, independent of whether the server has
/// been told yet.
///
/// The refresh cookie is HttpOnly, so a failed `POST /auth/logout` leaves a
/// credential this code cannot clear. Clearing only the store made the
/// interface say anonymous while the browser still held a usable session — on a
/// shared machine, the next reload signed the previous person back in. The
/// marker holds hydration back until the server confirms.
const LOGOUT_INTENT_KEY = 'cinetrack-logout-pending';

export function markLogoutPending(): void {
  try {
    localStorage.setItem(LOGOUT_INTENT_KEY, '1');
  } catch {
    // Storage can be unavailable in hardened or sandboxed browser contexts.
  }
}

export function clearLogoutPending(): void {
  try {
    localStorage.removeItem(LOGOUT_INTENT_KEY);
  } catch {
    // As above: nothing to clear if it could never be written.
  }
}

export function isLogoutPending(): boolean {
  try {
    return localStorage.getItem(LOGOUT_INTENT_KEY) === '1';
  } catch {
    return false;
  }
}

/// Run `rotate` with the browser-wide rotation lock held, when the browser has
/// one.
///
/// Single-flight was a module variable, so every tab had its own. Two tabs
/// hydrating together both sent the same refresh cookie; the second arrived at
/// a token the first had already consumed, and the server correctly read that
/// as theft and destroyed every session on the account — including the phone's.
/// Web Locks serialises them so the second tab waits and then uses the cookie
/// the first one left behind.
async function withRotationLock<T>(rotate: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return rotate();
  return locks.request('cinetrack-session-rotation', rotate);
}

/// Exported for the event stream, which uses `fetch` rather than this axios
/// instance — a streaming body is not something axios can hand back — and so
/// never reaches the interceptor below. Sharing this function rather than
/// posting to `/auth/refresh` directly keeps one refresh in flight at a time
/// and one circuit breaker, instead of two that can disagree.
export function refreshAccessToken(): Promise<string> {
  if (useAuthStore.getState().refreshRejected) {
    return Promise.reject(new Error('Session refresh is unavailable'));
  }

  if (!refreshPromise) {
    const { generation, token: tokenAtCall } = useAuthStore.getState();
    refreshPromise = withRotationLock(async () => {
      // Re-read inside the lock: another tab may have rotated while this one
      // waited, in which case the store already holds a fresh token and
      // sending the consumed cookie would look like reuse.
      //
      // The test is whether the token *changed*, not whether one exists. This
      // function is called precisely because the current token is no longer
      // good, so "there is a token" would hand back the stale one and rotate
      // nothing.
      const current = useAuthStore.getState();
      if (current.generation !== generation) {
        throw new SessionSupersededError();
      }
      if (current.token && current.token !== tokenAtCall) {
        return current.token;
      }

      const response = await axios.post(`${API_URL}/api/auth/refresh`, undefined, {
        withCredentials: true,
        timeout: 15_000,
      });
      const { access_token, user } = response.data;
      // The result belongs to the session that asked for it. Signing out while
      // this was in flight means it must be discarded, not applied.
      if (useAuthStore.getState().generation !== generation) {
        throw new SessionSupersededError();
      }
      useAuthStore.getState().setAuth(access_token, user);
      return access_token as string;
    })
      .catch((error) => {
        // Only a refusal closes the circuit. Anything else leaves it open so
        // the next attempt can succeed when the network comes back.
        if (isCredentialRejection(error)) {
          useAuthStore.getState().rejectSession();
        }
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

/// End the session, and record the intent whether or not the server hears it.
///
/// M07. The refresh cookie is HttpOnly, so this code cannot clear it — only the
/// server can. A logout the network ate used to clear the store and stop there,
/// leaving a usable credential behind an interface that said anonymous; on a
/// shared machine the next reload signed the previous person back in.
///
/// Lives here rather than inside the mutation so it can be tested as what it
/// is: a sequence with a durable marker, not a React hook.
export async function endSession(): Promise<void> {
  markLogoutPending();
  try {
    await api.post('/auth/logout');
    clearLogoutPending();
  } catch (error) {
    // A refusal means the session was already gone, which is the outcome being
    // asked for. Anything else stays pending and is retried on the next load.
    if (isCredentialRejection(error)) {
      clearLogoutPending();
    }
  }
}

export async function bootstrapSession(): Promise<void> {
  // A logout the server never heard about still ended the session as far as the
  // person is concerned. Finish it before hydrating anything.
  if (isLogoutPending()) {
    try {
      await axios.post(`${API_URL}/api/auth/logout`, undefined, {
        withCredentials: true,
        timeout: 15_000,
      });
      clearLogoutPending();
    } catch (error) {
      // A refusal means the session is already gone, which is the outcome we
      // wanted; anything else stays pending and is retried next time.
      if (isCredentialRejection(error)) {
        clearLogoutPending();
      }
    }
    useAuthStore.getState().logout();
    return;
  }

  try {
    await refreshAccessToken();
  } catch (error) {
    if (error instanceof SessionSupersededError) {
      // Somebody signed in or out while this was in flight; their transition
      // is the current truth and this result is stale.
      return;
    }
    if (isCredentialRejection(error)) {
      useAuthStore.getState().logout();
      return;
    }
    // Transport failure. The credential may be perfectly good, so leave the
    // session unresolved rather than signing the person out of a working
    // account because a restart happened to overlap their page load.
    useAuthStore.setState({ status: 'anonymous' });
  }
}

api.interceptors.response.use(
  (response) => {
    const url: string = response.config.url ?? '';
    if (url.includes('/auth/login') || url.includes('/auth/register')) {
      // A fresh sign-in supersedes any logout the server never heard about.
      clearLogoutPending();
    }
    return response;
  },
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      const url: string = originalRequest.url ?? '';

      // A failed refresh means the session is truly gone — clear auth and bounce.
      if (url.includes('/auth/refresh')) {
        useAuthStore.getState().logout();
        return Promise.reject(error);
      }

      // 401s from auth entrypoints (login, register, password reset/change) are
      // expected credential errors. Surfacing them to the form is the whole
      // point — don't attempt a token refresh, which would swallow the error
      // and redirect to /login (a user just typing a wrong password is not a
      // case of an expired session).
      if (
        url.includes('/auth/login') ||
        url.includes('/auth/register') ||
        url.includes('/auth/password')
      ) {
        return Promise.reject(error);
      }

      const auth = useAuthStore.getState();
      if (auth.refreshRejected || auth.status === 'anonymous') {
        return Promise.reject(error);
      }

      originalRequest._retry = true;

      try {
        const access_token = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${access_token}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Same distinction as bootstrap: only a refusal ends the session. A
        // rotation that lost a race belongs to a session that no longer exists,
        // and a transport failure is not a verdict on the credential.
        if (isCredentialRejection(refreshError)) {
          useAuthStore.getState().logout();
        }
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError<{ message?: unknown }>(error)) return fallback;
  const message = error.response?.data?.message;
  return typeof message === 'string' && message.trim().length > 0 ? message : fallback;
}

export default api;
