import { create } from 'zustand';

import type { User } from '@/types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'restore_error';

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  user: User | null;
  beginSessionRestore: () => void;
  failSessionRestore: () => void;
  setSession: (accessToken: string, user: User) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  accessToken: null,
  user: null,
  beginSessionRestore: () => {
    set({ status: 'loading', accessToken: null, user: null });
  },
  failSessionRestore: () => {
    set({ status: 'restore_error', accessToken: null, user: null });
  },
  setSession: (accessToken, user) => {
    set({ status: 'authenticated', accessToken, user });
  },
  clearSession: () => {
    set({ status: 'anonymous', accessToken: null, user: null });
  },
}));
