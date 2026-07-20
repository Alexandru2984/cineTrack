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
let refreshUnavailable = false;

function refreshAccessToken(): Promise<string> {
  if (refreshUnavailable) {
    return Promise.reject(new Error('Session refresh is unavailable'));
  }

  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_URL}/api/auth/refresh`, undefined, {
        withCredentials: true,
        timeout: 15_000,
      })
      .then((response) => {
        const { access_token, user } = response.data;
        refreshUnavailable = false;
        useAuthStore.getState().setAuth(access_token, user);
        return access_token as string;
      })
      .catch((error) => {
        // Once rotation fails, later 401s from the same page must not fan out
        // into more refresh attempts. A successful login/register resets this.
        refreshUnavailable = true;
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

export async function bootstrapSession(): Promise<void> {
  try {
    await refreshAccessToken();
  } catch {
    useAuthStore.getState().logout();
  }
}

api.interceptors.response.use(
  (response) => {
    const url: string = response.config.url ?? '';
    if (url.includes('/auth/login') || url.includes('/auth/register')) {
      refreshUnavailable = false;
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

      if (refreshUnavailable || useAuthStore.getState().status === 'anonymous') {
        return Promise.reject(error);
      }

      originalRequest._retry = true;

      try {
        const access_token = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${access_token}`;
        return api(originalRequest);
      } catch (refreshError) {
        useAuthStore.getState().logout();
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
