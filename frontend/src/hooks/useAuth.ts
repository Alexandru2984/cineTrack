import { useMutation, useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import type { AuthResponse, User } from '@/types';

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
