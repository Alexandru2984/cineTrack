import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from '@/store/auth';
import type { User } from '@/types';

const mockUser: User = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  username: 'testuser',
  email: 'test@example.com',
  avatar_url: null,
  bio: null,
  is_public: true,
  created_at: '2024-01-01T00:00:00Z',
};

describe('useAuthStore', () => {
  beforeEach(() => {
    // Reset store state
    useAuthStore.setState({
      token: null,
      refreshToken: null,
      user: null,
    });
    localStorage.clear();
  });

  it('starts with null values', () => {
    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.refreshToken).toBeNull();
    expect(state.user).toBeNull();
  });

  it('isAuthenticated returns false when no token', () => {
    expect(useAuthStore.getState().isAuthenticated()).toBe(false);
  });

  it('setAuth sets token, refreshToken and user', () => {
    useAuthStore.getState().setAuth('access-tok', 'refresh-tok', mockUser);
    const state = useAuthStore.getState();
    expect(state.token).toBe('access-tok');
    expect(state.refreshToken).toBe('refresh-tok');
    expect(state.user).toEqual(mockUser);
  });

  it('isAuthenticated returns true after setAuth', () => {
    useAuthStore.getState().setAuth('access-tok', 'refresh-tok', mockUser);
    expect(useAuthStore.getState().isAuthenticated()).toBe(true);
  });

  it('setUser updates only user', () => {
    useAuthStore.getState().setAuth('tok', 'ref', mockUser);
    const updatedUser = { ...mockUser, username: 'newname' };
    useAuthStore.getState().setUser(updatedUser);
    const state = useAuthStore.getState();
    expect(state.user?.username).toBe('newname');
    expect(state.token).toBe('tok');
    expect(state.refreshToken).toBe('ref');
  });

  it('setToken updates only token', () => {
    useAuthStore.getState().setAuth('old-tok', 'ref', mockUser);
    useAuthStore.getState().setToken('new-tok');
    const state = useAuthStore.getState();
    expect(state.token).toBe('new-tok');
    expect(state.refreshToken).toBe('ref');
    expect(state.user).toEqual(mockUser);
  });

  it('logout clears all state', () => {
    useAuthStore.getState().setAuth('tok', 'ref', mockUser);
    useAuthStore.getState().logout();
    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.refreshToken).toBeNull();
    expect(state.user).toBeNull();
  });

  it('isAuthenticated returns false after logout', () => {
    useAuthStore.getState().setAuth('tok', 'ref', mockUser);
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().isAuthenticated()).toBe(false);
  });
});
