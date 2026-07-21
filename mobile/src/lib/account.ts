import { apiRequest } from '@/lib/api';
import { ApiError, rawRequest } from '@/lib/http';
import { readRefreshToken } from '@/lib/secure-session';
import { clearLocalSession } from '@/lib/session';
import type { AccountSession, User } from '@/types';

export const MAX_PROFILE_BIO_LENGTH = 500;

export interface ProfileDraft {
  username: string;
  bio: string;
  isPublic: boolean;
}

export interface TwoFactorSetup {
  secret: string;
  otpauth_uri: string;
}

export interface TwoFactorEnabled {
  recovery_codes: string[];
}

export function validateProfileDraft(username: string, bio: string) {
  const normalizedUsername = username.trim();
  if (normalizedUsername.length < 3 || normalizedUsername.length > 50) {
    return 'Username must contain 3 to 50 characters';
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(normalizedUsername)) {
    return 'Use letters, numbers, underscores, or hyphens, starting and ending with a letter or number';
  }
  if (Array.from(bio).length > MAX_PROFILE_BIO_LENGTH) {
    return `Bio must contain at most ${MAX_PROFILE_BIO_LENGTH} characters`;
  }
  return null;
}

export function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  confirmation: string,
) {
  if (!currentPassword) return 'Enter your current password';
  if (currentPassword.length > 128) {
    return 'Current password must contain at most 128 characters';
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return 'New password must contain 8 to 128 characters';
  }
  if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    return 'New password must contain at least one letter and one number';
  }
  if (newPassword !== confirmation) return 'New passwords do not match';
  return null;
}

export async function updateAccountProfile(draft: ProfileDraft) {
  return apiRequest<User>('/users/me', {
    method: 'PATCH',
    body: {
      username: draft.username.trim(),
      bio: draft.bio.trim(),
      is_public: draft.isPublic,
    },
  });
}

/// Starts a change of address. Nothing local changes: the account keeps its
/// current email until the link mailed to the new one is opened, so the session
/// is deliberately left alone here.
export async function requestAccountEmailChange(
  currentPassword: string,
  newEmail: string,
) {
  await apiRequest<{ message: string }>('/auth/email/change', {
    method: 'POST',
    body: {
      current_password: currentPassword,
      new_email: newEmail,
    },
  });
}

export async function changeAccountPassword(
  currentPassword: string,
  newPassword: string,
) {
  await apiRequest<{ message: string }>('/auth/password', {
    method: 'PATCH',
    body: {
      current_password: currentPassword,
      new_password: newPassword,
    },
  });
  await clearLocalSession();
}

async function requestAccountSessions(refreshToken: string) {
  return rawRequest<AccountSession[]>('/auth/mobile/sessions', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  });
}

export async function listAccountSessions() {
  const refreshToken = await readRefreshToken();
  if (!refreshToken) throw new ApiError('Your saved session is no longer available', 401);

  try {
    return await requestAccountSessions(refreshToken);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const latestRefreshToken = await readRefreshToken();
    if (!latestRefreshToken || latestRefreshToken === refreshToken) throw error;
    return requestAccountSessions(latestRefreshToken);
  }
}

export async function revokeAccountSession(id: string) {
  await apiRequest(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function logoutAllAccountSessions() {
  await apiRequest('/auth/sessions/logout-all', { method: 'POST' });
  await clearLocalSession();
}

/**
 * Ask the backend to re-send the address-confirmation link. The response is
 * uniform whether or not a mail was actually dispatched (the backend applies a
 * cooldown and no-ops for already-verified accounts).
 */
export async function resendEmailVerification() {
  await apiRequest<{ message: string }>('/auth/email/resend', { method: 'POST' });
}

export async function setupTwoFactor(password: string) {
  return apiRequest<TwoFactorSetup>('/auth/2fa/setup', {
    method: 'POST',
    body: { password },
  });
}

export async function enableTwoFactor(code: string) {
  return apiRequest<TwoFactorEnabled>('/auth/2fa/enable', {
    method: 'POST',
    body: { code: code.trim() },
  });
}

export async function disableTwoFactor(password: string) {
  await apiRequest<{ message?: string }>('/auth/2fa/disable', {
    method: 'POST',
    body: { password },
  });
}

export async function deleteAccountSession(password: string) {
  await apiRequest<{ message: string }>('/users/me', {
    method: 'DELETE',
    body: { password },
  });
  await clearLocalSession();
}
