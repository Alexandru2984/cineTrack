import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from '@/store/auth';
import { queryClient } from '@/lib/queryClient';
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
      user: null,
      status: 'anonymous',
    });
    localStorage.clear();
    queryClient.clear();
  });

  it('starts with null values', () => {
    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(state.status).toBe('anonymous');
  });

  it('isAuthenticated returns false when no token', () => {
    expect(useAuthStore.getState().isAuthenticated()).toBe(false);
  });

  it('setAuth sets token and user', () => {
    useAuthStore.getState().setAuth('access-tok', mockUser);
    const state = useAuthStore.getState();
    expect(state.token).toBe('access-tok');
    expect(state.user).toEqual(mockUser);
  });

  it('does not persist credentials or user data', () => {
    useAuthStore.getState().setAuth('access-tok', mockUser);
    const persisted = localStorage.getItem('cinetrack-auth');

    expect(persisted).toBeNull();
  });

  it('isAuthenticated returns true after setAuth', () => {
    useAuthStore.getState().setAuth('access-tok', mockUser);
    expect(useAuthStore.getState().isAuthenticated()).toBe(true);
  });

  it('setUser updates only user', () => {
    useAuthStore.getState().setAuth('tok', mockUser);
    const updatedUser = { ...mockUser, username: 'newname' };
    useAuthStore.getState().setUser(updatedUser);
    const state = useAuthStore.getState();
    expect(state.user?.username).toBe('newname');
    expect(state.token).toBe('tok');
  });

  it('logout clears all state', () => {
    useAuthStore.getState().setAuth('tok', mockUser);
    useAuthStore.getState().logout();
    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(state.status).toBe('anonymous');
  });

  it('isAuthenticated returns false after logout', () => {
    useAuthStore.getState().setAuth('tok', mockUser);
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().isAuthenticated()).toBe(false);
  });

  it('logout clears user-scoped query data', () => {
    useAuthStore.getState().setAuth('tok', mockUser);
    queryClient.setQueryData(['tracking'], [{ title: 'Private title' }]);

    useAuthStore.getState().logout();

    expect(queryClient.getQueryData(['tracking'])).toBeUndefined();
  });

  it('switching users clears user-scoped query data', () => {
    useAuthStore.getState().setAuth('tok-1', mockUser);
    queryClient.setQueryData(['stats', 'me'], { total_movies: 42 });

    useAuthStore.getState().setAuth('tok-2', { ...mockUser, id: 'another-user-id' });

    expect(queryClient.getQueryData(['stats', 'me'])).toBeUndefined();
  });
});
