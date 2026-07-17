import { create } from 'zustand';

import type { User } from '@/types';

export type AuthStatus =
  | 'loading'
  | 'authenticated'
  | 'offline'
  | 'anonymous'
  | 'restore_error';

export function hasLocalSession(status: AuthStatus) {
  return status === 'authenticated' || status === 'offline';
}

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  user: User | null;
  beginSessionRestore: () => void;
  failSessionRestore: () => void;
  setSession: (accessToken: string, user: User) => void;
  setOfflineSession: (user: User) => void;
  enterOfflineMode: () => void;
  setUser: (user: User) => void;
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
  setOfflineSession: (user) => {
    set({ status: 'offline', accessToken: null, user });
  },
  enterOfflineMode: () => {
    set((state) =>
      state.user
        ? { status: 'offline', accessToken: null, user: state.user }
        : state,
    );
  },
  setUser: (user) => {
    set({ user });
  },
  clearSession: () => {
    set({ status: 'anonymous', accessToken: null, user: null });
  },
}));
