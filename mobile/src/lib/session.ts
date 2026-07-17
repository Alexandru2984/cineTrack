import { z } from 'zod';

import { ApiError, rawRequest } from '@/lib/http';
import {
  readRefreshToken,
  removeRefreshToken,
  writeRefreshToken,
} from '@/lib/secure-session';
import { useAuthStore } from '@/store/auth';
import type { MobileAuthResponse } from '@/types';

const userSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  email: z.string().email(),
  avatar_url: z.string().nullable(),
  bio: z.string().nullable(),
  is_public: z.boolean(),
  created_at: z.string(),
});

const mobileAuthSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(32),
  token_type: z.string(),
  expires_in: z.number().positive(),
  user: userSchema,
});

let refreshPromise: Promise<string> | null = null;

function isRejectedRefresh(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

async function discardSession() {
  await removeRefreshToken().catch(() => undefined);
  useAuthStore.getState().clearSession();
}

async function revokeToken(refreshToken: string) {
  await rawRequest('/auth/mobile/logout', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  }).catch(() => undefined);
}

async function acceptSession(payload: unknown) {
  const session = mobileAuthSchema.parse(payload) as MobileAuthResponse;
  try {
    await writeRefreshToken(session.refresh_token);
  } catch (error) {
    await revokeToken(session.refresh_token);
    useAuthStore.getState().clearSession();
    throw error;
  }
  useAuthStore.getState().setSession(session.access_token, session.user);
  return session.access_token;
}

export async function hydrateSession() {
  useAuthStore.getState().beginSessionRestore();

  let refreshToken: string | null;
  try {
    refreshToken = await readRefreshToken();
  } catch {
    useAuthStore.getState().failSessionRestore();
    return;
  }

  if (!refreshToken) {
    useAuthStore.getState().clearSession();
    return;
  }

  try {
    const payload = await rawRequest('/auth/mobile/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
    await acceptSession(payload);
  } catch (error) {
    if (isRejectedRefresh(error)) {
      await discardSession();
    } else {
      useAuthStore.getState().failSessionRestore();
    }
  }
}

export function refreshSession(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = await readRefreshToken();
      if (!refreshToken) {
        useAuthStore.getState().clearSession();
        throw new Error('No refresh token');
      }
      const payload = await rawRequest('/auth/mobile/refresh', {
        method: 'POST',
        body: { refresh_token: refreshToken },
      });
      return acceptSession(payload);
    })()
      .catch(async (error) => {
        if (isRejectedRefresh(error)) await discardSession();
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function loginSession(email: string, password: string) {
  const payload = await rawRequest('/auth/mobile/login', {
    method: 'POST',
    body: { email: email.trim(), password },
  });
  await acceptSession(payload);
}

export async function registerSession(username: string, email: string, password: string) {
  const payload = await rawRequest('/auth/mobile/register', {
    method: 'POST',
    body: { username: username.trim(), email: email.trim(), password },
  });
  await acceptSession(payload);
}

export async function logoutSession() {
  const refreshToken = await readRefreshToken().catch(() => null);
  try {
    if (refreshToken) await revokeToken(refreshToken);
  } finally {
    await removeRefreshToken().catch(() => undefined);
    useAuthStore.getState().clearSession();
  }
}
