import { z } from 'zod';

import { ApiError, rawRequest } from '@/lib/http';
import {
  readCachedSession,
  readRefreshToken,
  removeCachedSession,
  removeRefreshToken,
  writeCachedSession,
  writeRefreshToken,
} from '@/lib/secure-session';
import { detachStoredReleaseNotifications } from '@/lib/secure-release-notifications';
import { useAuthStore } from '@/store/auth';
import type { MobileAuthResponse } from '@/types';

const userSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  email: z.string().email(),
  avatar_url: z.string().nullable(),
  bio: z.string().nullable(),
  is_public: z.boolean(),
  // Optional so sessions cached before this field shipped still parse instead
  // of failing validation and signing the user out on upgrade.
  email_verified: z.boolean().optional(),
  created_at: z.string(),
});

const mobileAuthSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(32),
  token_type: z.string(),
  expires_in: z.number().positive(),
  user: userSchema,
});

const cachedSessionSchema = z.object({
  refresh_token: z.string().min(32),
  user: userSchema,
});

let refreshPromise: Promise<string> | null = null;

function isRejectedRefresh(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

export async function clearLocalSession() {
  await Promise.all([
    removeRefreshToken().catch(() => undefined),
    removeCachedSession().catch(() => undefined),
    detachStoredReleaseNotifications().catch(() => undefined),
  ]);
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
  try {
    await writeCachedSession(session.refresh_token, session.user);
  } catch {
    await removeCachedSession().catch(() => undefined);
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
    await clearLocalSession();
    return;
  }

  const cachedSession = cachedSessionSchema.safeParse(
    await readCachedSession().catch(() => null),
  );

  try {
    const payload = await rawRequest('/auth/mobile/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
    await acceptSession(payload);
  } catch (error) {
    if (isRejectedRefresh(error)) {
      await clearLocalSession();
    } else if (
      cachedSession.success &&
      cachedSession.data.refresh_token === refreshToken
    ) {
      useAuthStore.getState().setOfflineSession(cachedSession.data.user);
    } else {
      useAuthStore.getState().failSessionRestore();
    }
  }
}

export async function resumeOfflineSession() {
  if (useAuthStore.getState().status !== 'offline') return;
  await refreshSession().catch(() => undefined);
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
        if (isRejectedRefresh(error)) await clearLocalSession();
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function loginSession(email: string, password: string, totpCode?: string) {
  // A 2FA-enabled account needs the second factor: a 6-digit authenticator code
  // or a recovery code. Omitted on the first attempt; the caller retries with it
  // after the backend answers with two_factor_required.
  const code = totpCode?.trim();
  const payload = await rawRequest('/auth/mobile/login', {
    method: 'POST',
    body: { email: email.trim(), password, ...(code ? { totp_code: code } : {}) },
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
    if (refreshToken && useAuthStore.getState().status !== 'offline') {
      await revokeToken(refreshToken);
    }
  } finally {
    await clearLocalSession();
  }
}
