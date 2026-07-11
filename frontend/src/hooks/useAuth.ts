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
    mutationFn: async (data: { email: string; password: string }) => {
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
  const logout = useAuthStore((s) => s.logout);
  return useMutation({
    mutationFn: async (data: { password: string }) => {
      await api.delete('/users/me', { data });
    },
    onSuccess: () => logout(),
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
