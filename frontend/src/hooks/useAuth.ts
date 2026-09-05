import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api, { endSession } from '@/lib/api';
import { sealBackupForPassword } from '@/lib/crypto/session';
import { useAuthStore } from '@/store/auth';
import { useEncryptionStore } from '@/store/encryption';
import type { AuthResponse, SecurityActivity, Session, User } from '@/types';

export function useRegister() {
  const setAuth = useAuthStore((s) => s.setAuth);
  return useMutation({
    mutationFn: async (data: {
      username: string;
      email: string;
      password: string;
      accepted_terms: boolean;
      confirmed_minimum_age: boolean;
    }) => {
      const res = await api.post<AuthResponse>('/auth/register', data);
      return res.data;
    },
    onSuccess: (data) => setAuth(data.access_token, data.user),
  });
}

export function useAcceptTerms() {
  const setUser = useAuthStore((state) => state.setUser);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await api.post<User>('/auth/terms', { accepted_terms: true });
      return response.data;
    },
    onSuccess: (user) => {
      setUser(user);
      queryClient.setQueryData(['me'], user);
    },
  });
}

export function useLogin() {
  const setAuth = useAuthStore((s) => s.setAuth);
  return useMutation({
    mutationFn: async (data: { email: string; password: string; totp_code?: string }) => {
      const res = await api.post<AuthResponse>('/auth/login', data);
      return res.data;
    },
    onSuccess: (data) => setAuth(data.access_token, data.user),
  });
}

export function useLogout() {
  const logout = useAuthStore((s) => s.logout);
  const clearKeys = useEncryptionStore((s) => s.clear);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  return useMutation({
    // `forgetKeys` is the shared-device answer. Keeping them is the default
    // because forgetting costs a password or a recovery code on the next
    // sign-in, which is the wrong tax on a device somebody owns — but leaving
    // them behind on a borrowed browser hands the next person every past
    // message, so it has to be offered rather than decided here.
    mutationFn: async ({ forgetKeys = false }: { forgetKeys?: boolean } = {}) => {
      await endSession();
      if (forgetKeys) await clearKeys(userId);
    },
    onSuccess: () => logout(),
  });
}

export function useMe() {
  const token = useAuthStore((s) => s.token);
  return useQuery<User>({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await api.get('/auth/me');
      return res.data;
    },
    enabled: !!token,
  });
}

export function useUpdatePrivacy() {
  const setUser = useAuthStore((state) => state.setUser);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (isPublic: boolean) => {
      const response = await api.patch<User>('/users/me', { is_public: isPublic });
      return response.data;
    },
    onSuccess: (user) => {
      setUser(user);
      qc.setQueryData(['me'], user);
      void qc.invalidateQueries({ queryKey: ['follow-requests'] });
      void qc.invalidateQueries({ queryKey: ['user'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: async (data: { email: string }) => {
      const res = await api.post('/auth/password/forgot', data);
      return res.data as { message: string };
    },
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: async (data: { token: string; new_password: string }) => {
      const res = await api.post('/auth/password/reset', data);
      return res.data as { message: string };
    },
  });
}

export const VERIFY_EMAIL_MUTATION_KEY = ['verify-email'] as const;

export function useVerifyEmail() {
  const setUser = useAuthStore((s) => s.setUser);
  const qc = useQueryClient();
  return useMutation({
    // Keyed so the attempt lives in the mutation cache rather than in the
    // component. Confirmation runs once per one-time token, and React may
    // remount this route (StrictMode, or the session bootstrap swapping the
    // tree) while the request is still in flight.
    mutationKey: VERIFY_EMAIL_MUTATION_KEY,
    mutationFn: async (data: { token: string }) => {
      const res = await api.post('/auth/email/verify', data);
      return res.data as { message: string };
    },
    onSuccess: () => {
      // If a session is active, refresh the cached identity so the "confirm
      // your email" banner clears without a reload. This refresh is secondary:
      // it must not keep the one-time verification mutation in a pending state.
      if (useAuthStore.getState().token) {
        void api
          .get<User>('/auth/me')
          .then((res) => {
            setUser(res.data);
            qc.setQueryData(['me'], res.data);
          })
          .catch(() => {
            // Non-fatal: the banner will clear on the next natural refresh.
          });
      }
    },
  });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: async () => {
      const res = await api.post('/auth/email/resend');
      return res.data as { message: string };
    },
  });
}

export function useSetupTwoFactor() {
  return useMutation({
    mutationFn: async (password: string) => {
      const res = await api.post<{ secret: string; otpauth_uri: string }>('/auth/2fa/setup', {
        password,
      });
      return res.data;
    },
  });
}

export function useEnableTwoFactor() {
  const setUser = useAuthStore((s) => s.setUser);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) => {
      const res = await api.post<{ recovery_codes: string[] }>('/auth/2fa/enable', { code });
      return res.data;
    },
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['security-activity'] });
      try {
        const res = await api.get<User>('/auth/me');
        setUser(res.data);
        qc.setQueryData(['me'], res.data);
      } catch {
        // Non-fatal: the enabled state reflects on the next natural refresh.
      }
    },
  });
}

export function useDisableTwoFactor() {
  const setUser = useAuthStore((s) => s.setUser);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { password: string; totp_code?: string }) => {
      await api.post('/auth/2fa/disable', data);
    },
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['security-activity'] });
      try {
        const res = await api.get<User>('/auth/me');
        setUser(res.data);
        qc.setQueryData(['me'], res.data);
      } catch {
        // Non-fatal.
      }
    },
  });
}

export function useChangePassword() {
  const logout = useAuthStore((s) => s.logout);
  const identity = useEncryptionStore((s) => s.identity);
  return useMutation({
    mutationFn: async (data: {
      current_password: string;
      new_password: string;
      totp_code?: string;
    }) => {
      // Sealed before the request and carried by it. Sending it afterwards
      // could not work: the change revokes the token that would authorise it,
      // so the follow-up failed silently and the backup stayed sealed under the
      // old password — found only by somebody restoring on a new device.
      const key_backup = identity
        ? await sealBackupForPassword(identity, data.new_password)
        : undefined;

      const res = await api.patch('/auth/password', { ...data, key_backup });
      return res.data as { message: string };
    },
    // The backend revokes every refresh token and clears the current cookie.
    onSuccess: () => logout(),
  });
}

export function useChangeEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      current_password: string;
      new_email: string;
      totp_code?: string;
    }) => {
      const res = await api.post('/auth/email/change', data);
      return res.data as { message: string };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['security-activity'] });
    },
    // Nothing local changes yet: the address only moves once the link mailed to
    // it is opened, so there is no cached identity to refresh here.
  });
}

export const CONFIRM_EMAIL_CHANGE_MUTATION_KEY = ['confirm-email-change'] as const;

export function useConfirmEmailChange() {
  const setUser = useAuthStore((s) => s.setUser);
  return useMutation({
    // Keyed for the same reason as email verification: one-time token, and the
    // route can remount while the request is still in flight.
    mutationKey: CONFIRM_EMAIL_CHANGE_MUTATION_KEY,
    mutationFn: async (data: { token: string }) => {
      const res = await api.post('/auth/email/change/confirm', data);
      return res.data as { message: string };
    },
    onSuccess: () => {
      // The link is usually opened in a browser that may or may not hold the
      // session. Refresh the identity when it does, so settings stops showing
      // the old address; a failure here must not fail the confirmation.
      if (useAuthStore.getState().token) {
        void api
          .get<User>('/auth/me')
          .then((res) => setUser(res.data))
          .catch(() => undefined);
      }
    },
  });
}

export function useSessions() {
  const token = useAuthStore((s) => s.token);
  return useQuery<Session[]>({
    queryKey: ['sessions'],
    queryFn: async () => {
      const res = await api.get('/auth/sessions');
      return res.data;
    },
    enabled: !!token,
  });
}

export function useSecurityActivity() {
  const token = useAuthStore((s) => s.token);
  return useQuery<SecurityActivity[]>({
    queryKey: ['security-activity'],
    queryFn: async () => {
      const res = await api.get('/auth/security-activity');
      return res.data;
    },
    enabled: !!token,
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/auth/sessions/${id}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      void qc.invalidateQueries({ queryKey: ['security-activity'] });
    },
  });
}

export function useLogoutAllSessions() {
  const logout = useAuthStore((s) => s.logout);
  return useMutation({
    mutationFn: async () => {
      await api.post('/auth/sessions/logout-all');
    },
    // The current session is revoked too, so drop local auth and let the caller
    // redirect to login.
    onSuccess: () => logout(),
  });
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: async (data: { password: string; totp_code?: string }) => {
      await api.delete('/users/me', { data });
    },
  });
}

export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('avatar', file);
      const res = await api.post<{ avatar_url: string }>('/users/me/avatar', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useDeleteAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.delete('/users/me/avatar');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}
