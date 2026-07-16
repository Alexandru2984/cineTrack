import { create } from 'zustand';

import type { User } from '@/types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  user: User | null;
  setSession: (accessToken: string, user: User) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  accessToken: null,
  user: null,
  setSession: (accessToken, user) => {
    set({ status: 'authenticated', accessToken, user });
  },
  clearSession: () => {
    set({ status: 'anonymous', accessToken: null, user: null });
  },
}));
