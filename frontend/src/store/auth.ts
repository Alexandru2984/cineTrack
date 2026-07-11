import { create } from 'zustand';
import { queryClient } from '@/lib/queryClient';
import type { User } from '@/types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  token: string | null;
  user: User | null;
  status: AuthStatus;
  setAuth: (token: string, user: User) => void;
  setUser: (user: User) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
}

// Remove credentials persisted by versions that predate cookie-based hydration.
try {
  localStorage.removeItem('cinetrack-auth');
} catch {
  // Storage can be unavailable in hardened or sandboxed browser contexts.
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  status: 'loading',
  setAuth: (token, user) => {
    const previousUser = get().user;
    if (previousUser && previousUser.id !== user.id) {
      queryClient.clear();
    }
    set({ token, user, status: 'authenticated' });
  },
  setUser: (user) => set({ user }),
  logout: () => {
    queryClient.clear();
    set({ token: null, user: null, status: 'anonymous' });
  },
  isAuthenticated: () => get().status === 'authenticated' && !!get().token,
}));
