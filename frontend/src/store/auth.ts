import { create } from 'zustand';
import { queryClient } from '@/lib/queryClient';
import type { User } from '@/types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  token: string | null;
  user: User | null;
  status: AuthStatus;
  /** Bumped on every deliberate session transition — sign in, sign out, switch.
   *
   *  A rotation started under one generation must not apply its result under
   *  another. Without it a refresh already in flight when somebody signs out
   *  lands afterwards and puts the previous user back: the store said anonymous,
   *  the response said authenticated, and the response won because it arrived
   *  last. The phone has had this fence since its own session work; the web
   *  client did not. */
  generation: number;
  /** Set only when the server has refused the credential outright.
   *
   *  A timeout or a 503 says nothing about whether the session is still good,
   *  and treating those as a refusal signed people out of working accounts for
   *  the length of a restart. Kept here rather than in a module variable so a
   *  deliberate transition clears it, which is exactly when it should clear. */
  refreshRejected: boolean;
  setAuth: (token: string, user: User) => void;
  rejectSession: () => void;
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
  generation: 0,
  refreshRejected: false,
  setAuth: (token, user) => {
    const previousUser = get().user;
    const switching = !!previousUser && previousUser.id !== user.id;
    if (switching) {
      queryClient.clear();
    }
    set((state) => ({
      token,
      user,
      status: 'authenticated',
      // Signing in is a transition; a plain token rotation for the same user is
      // not, and bumping there would invalidate the rotation that just
      // succeeded.
      generation: state.status === 'authenticated' && !switching
        ? state.generation
        : state.generation + 1,
      refreshRejected: false,
    }));
  },
  rejectSession: () => set({ refreshRejected: true }),
  setUser: (user) => set({ user }),
  logout: () => {
    queryClient.clear();
    set((state) => ({
      token: null,
      user: null,
      status: 'anonymous',
      generation: state.generation + 1,
      // Deliberately kept. Signing out after the server refused the credential
      // must not re-open the circuit: the event stream calls the rotation
      // directly, and it would fan straight back out into requests that cannot
      // succeed. A successful sign-in is what clears it.
    }));
  },
  isAuthenticated: () => get().status === 'authenticated' && !!get().token,
}));
