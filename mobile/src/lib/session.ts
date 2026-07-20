import { z } from 'zod';

import { ApiError, rawRequest } from '@/lib/http';
import {
  queueLogoutRevocation,
  readCachedSession,
  readPendingLogoutRevocations,
  readRefreshToken,
  removeCachedSession,
  removePendingLogoutRevocation,
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

class SessionSupersededError extends Error {
  constructor() {
    super('Session changed while authentication was in progress');
    this.name = 'SessionSupersededError';
  }
}

interface RefreshInFlight {
  generation: number;
  promise: Promise<string>;
}

let sessionGeneration = 0;
let refreshInFlight: RefreshInFlight | null = null;
let credentialTail: Promise<void> = Promise.resolve();
let revocationTail: Promise<void> = Promise.resolve();

function withCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = credentialTail.then(operation, operation);
  credentialTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withRevocationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = revocationTail.then(operation, operation);
  revocationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function beginSessionTransition() {
  sessionGeneration += 1;
  refreshInFlight = null;
  return sessionGeneration;
}

export function currentSessionGeneration() {
  return sessionGeneration;
}

function isRejectedRefresh(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

function shouldRetainRevocation(error: unknown) {
  return (
    !(error instanceof ApiError) ||
    error.status === 0 ||
    error.status === 429 ||
    error.status >= 500
  );
}

async function revokeToken(refreshToken: string) {
  await rawRequest('/auth/mobile/logout', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  });
}

async function revokeOrQueue(refreshToken: string) {
  return withRevocationLock(async () => {
    try {
      await revokeToken(refreshToken);
      await removePendingLogoutRevocation(refreshToken);
    } catch (error) {
      if (shouldRetainRevocation(error)) {
        await queueLogoutRevocation(refreshToken);
      } else {
        await removePendingLogoutRevocation(refreshToken);
      }
    }
  });
}

export function flushPendingLogoutRevocations() {
  return withRevocationLock(async () => {
    const pending = await readPendingLogoutRevocations();
    for (const refreshToken of pending) {
      try {
        await revokeToken(refreshToken);
        await removePendingLogoutRevocation(refreshToken);
      } catch (error) {
        if (shouldRetainRevocation(error)) break;
        await removePendingLogoutRevocation(refreshToken);
      }
    }
  });
}

async function clearStoredSession(generation: number, detachNotifications: boolean) {
  return withCredentialLock(async () => {
    if (generation !== sessionGeneration) return;
    await Promise.all([
      removeRefreshToken().catch(() => undefined),
      removeCachedSession().catch(() => undefined),
      ...(detachNotifications
        ? [detachStoredReleaseNotifications().catch(() => undefined)]
        : []),
    ]);
    if (generation === sessionGeneration) {
      useAuthStore.getState().clearSession();
    }
  });
}

async function invalidateAndClear(expectedGeneration: number) {
  if (expectedGeneration !== sessionGeneration) return;
  const generation = beginSessionTransition();
  useAuthStore.getState().clearSession();
  await clearStoredSession(generation, true);
}

export async function clearLocalSession() {
  const generation = beginSessionTransition();
  useAuthStore.getState().clearSession();
  await clearStoredSession(generation, true);
}

async function rejectSupersededSession(refreshToken: string): Promise<never> {
  await Promise.all([
    removeRefreshToken().catch(() => undefined),
    removeCachedSession().catch(() => undefined),
    revokeOrQueue(refreshToken),
  ]);
  throw new SessionSupersededError();
}

async function acceptSession(payload: unknown, generation: number) {
  const session = mobileAuthSchema.parse(payload) as MobileAuthResponse;
  return withCredentialLock(async () => {
    if (generation !== sessionGeneration) {
      await revokeOrQueue(session.refresh_token);
      throw new SessionSupersededError();
    }
    try {
      await writeRefreshToken(session.refresh_token);
    } catch (error) {
      await revokeOrQueue(session.refresh_token);
      if (generation === sessionGeneration) {
        await Promise.all([
          removeRefreshToken().catch(() => undefined),
          removeCachedSession().catch(() => undefined),
          detachStoredReleaseNotifications().catch(() => undefined),
        ]);
        useAuthStore.getState().clearSession();
      }
      throw error;
    }
    if (generation !== sessionGeneration) {
      return rejectSupersededSession(session.refresh_token);
    }
    try {
      await writeCachedSession(session.refresh_token, session.user);
    } catch {
      await removeCachedSession().catch(() => undefined);
    }
    if (generation !== sessionGeneration) {
      return rejectSupersededSession(session.refresh_token);
    }
    useAuthStore.getState().setSession(session.access_token, session.user);
    return session.access_token;
  });
}

export async function hydrateSession() {
  const generation = beginSessionTransition();
  useAuthStore.getState().beginSessionRestore();

  let refreshToken: string | null;
  try {
    refreshToken = await readRefreshToken();
  } catch {
    if (generation === sessionGeneration) useAuthStore.getState().failSessionRestore();
    return;
  }

  if (generation !== sessionGeneration) return;
  if (!refreshToken) {
    await clearStoredSession(generation, true);
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
    await acceptSession(payload, generation);
    void flushPendingLogoutRevocations();
  } catch (error) {
    if (error instanceof SessionSupersededError || generation !== sessionGeneration) return;
    if (isRejectedRefresh(error)) {
      await invalidateAndClear(generation);
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
  const generation = sessionGeneration;
  if (refreshInFlight?.generation === generation) return refreshInFlight.promise;

  let entry: RefreshInFlight;
  const promise = (async () => {
    const refreshToken = await readRefreshToken();
    if (generation !== sessionGeneration) throw new SessionSupersededError();
    if (!refreshToken) {
      await invalidateAndClear(generation);
      throw new Error('No refresh token');
    }
    const payload = await rawRequest('/auth/mobile/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
    return acceptSession(payload, generation);
  })()
    .catch(async (error) => {
      if (isRejectedRefresh(error)) await invalidateAndClear(generation);
      throw error;
    })
    .finally(() => {
      if (refreshInFlight === entry) refreshInFlight = null;
    });
  entry = { generation, promise };
  refreshInFlight = entry;
  return promise;
}

async function beginAuthentication() {
  const generation = beginSessionTransition();
  useAuthStore.getState().clearSession();
  await clearStoredSession(generation, false);
  return generation;
}

export async function loginSession(email: string, password: string, totpCode?: string) {
  const generation = await beginAuthentication();
  const code = totpCode?.trim();
  const payload = await rawRequest('/auth/mobile/login', {
    method: 'POST',
    body: { email: email.trim(), password, ...(code ? { totp_code: code } : {}) },
  });
  await acceptSession(payload, generation);
}

export async function registerSession(username: string, email: string, password: string) {
  const generation = await beginAuthentication();
  const payload = await rawRequest('/auth/mobile/register', {
    method: 'POST',
    body: { username: username.trim(), email: email.trim(), password },
  });
  await acceptSession(payload, generation);
}

export async function logoutSession() {
  const refreshToken = await readRefreshToken().catch(() => null);
  const generation = beginSessionTransition();
  useAuthStore.getState().clearSession();
  await Promise.all([
    clearStoredSession(generation, true),
    ...(refreshToken ? [revokeOrQueue(refreshToken)] : []),
  ]);
}
