import axios from 'axios';
import { useAuthStore } from '@/store/auth';
import type { AxiosError } from 'axios';

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

function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_URL}/api/auth/refresh`, undefined, {
        withCredentials: true,
        timeout: 15_000,
      })
      .then((response) => {
        const { access_token, user } = response.data;
        useAuthStore.getState().setAuth(access_token, user);
        return access_token as string;
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
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      const url: string = originalRequest.url ?? '';

      // A failed refresh means the session is truly gone — clear auth and bounce.
      if (url.includes('/auth/refresh')) {
        useAuthStore.getState().logout();
        window.location.href = '/login';
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

      originalRequest._retry = true;

      try {
        const access_token = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${access_token}`;
        return api(originalRequest);
      } catch (refreshError) {
        useAuthStore.getState().logout();
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export function getApiErrorMessage(error: unknown, fallback: string): string {
  const apiError = error as AxiosError<{ message?: string }>;
  return apiError.response?.data?.message ?? fallback;
}

export default api;
