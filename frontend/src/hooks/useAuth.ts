import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import type { AuthResponse, Session, User } from '@/types';

export function useRegister() {
  const setAuth = useAuthStore((s) => s.setAuth);
  return useMutation({
    mutationFn: async (data: { username: string; email: string; password: string }) => {
      const res = await api.post<AuthResponse>('/auth/register', data);
      return res.data;
    },
    onSuccess: (data) => setAuth(data.access_token, data.user),
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
  return useMutation({
    mutationFn: async () => {
      await api.post('/auth/logout').catch(() => {});
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
    mutationFn: async (password: string) => {
      await api.post('/auth/2fa/disable', { password });
    },
    onSuccess: async () => {
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
  return useMutation({
    mutationFn: async (data: { current_password: string; new_password: string }) => {
      const res = await api.patch('/auth/password', data);
      return res.data as { message: string };
    },
    // The backend revokes every refresh token and clears the current cookie.
    onSuccess: () => logout(),
  });
}

export function useChangeEmail() {
  return useMutation({
    mutationFn: async (data: { current_password: string; new_email: string }) => {
      const res = await api.post('/auth/email/change', data);
      return res.data as { message: string };
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

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/auth/sessions/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
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
    mutationFn: async (data: { password: string }) => {
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
