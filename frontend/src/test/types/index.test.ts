import { describe, it, expect } from 'vitest';
import type {
  User,
  UserSummary,
  AuthResponse,
  TrackingItem,
  PublicUserProfile,
  ListResponse,
  TrackingStatus,
} from '@/types';

describe('Type contracts', () => {
  it('User has all required fields', () => {
    const user: User = {
      id: 'uuid',
      username: 'test',
      email: 'test@test.com',
      avatar_url: null,
      bio: null,
      is_public: true,
      created_at: '2024-01-01',
    };
    expect(user.id).toBeDefined();
    expect(user.email).toContain('@');
  });

  it('UserSummary excludes email', () => {
    const summary: UserSummary = {
      id: 'uuid',
      username: 'test',
      avatar_url: null,
      bio: null,
    };
    expect(summary).not.toHaveProperty('email');
  });

  it('AuthResponse has access and refresh tokens', () => {
    const resp: AuthResponse = {
      access_token: 'at',
      refresh_token: 'rt',
      token_type: 'Bearer',
      expires_in: 3600,
      user: {
        id: 'uuid',
        username: 'test',
        email: 'test@test.com',
        avatar_url: null,
        bio: null,
        is_public: true,
        created_at: '2024-01-01',
      },
    };
    expect(resp.access_token).toBeTruthy();
    expect(resp.refresh_token).toBeTruthy();
    expect(resp.token_type).toBe('Bearer');
  });

  it('TrackingItem has required fields', () => {
    const item: TrackingItem = {
      id: 'uuid',
      media_id: 'uuid2',
      tmdb_id: 123,
      media_type: 'movie',
      title: 'Test Movie',
      poster_path: null,
      status: 'watching',
      rating: null,
      review: null,
      is_favorite: false,
      started_at: null,
      completed_at: null,
    };
    expect(item.tmdb_id).toBeGreaterThan(0);
    expect(item.is_favorite).toBe(false);
  });

  it('PublicUserProfile has follower counts', () => {
    const profile: PublicUserProfile = {
      id: 'uuid',
      username: 'test',
      avatar_url: null,
      bio: null,
      is_public: true,
      followers_count: 10,
      following_count: 5,
      is_following: false,
      created_at: '2024-01-01',
    };
    expect(profile.followers_count).toBeGreaterThanOrEqual(0);
    expect(profile.following_count).toBeGreaterThanOrEqual(0);
  });

  it('ListResponse has item_count', () => {
    const list: ListResponse = {
      id: 'uuid',
      name: 'My List',
      description: null,
      is_public: true,
      item_count: 3,
      created_at: '2024-01-01',
    };
    expect(list.item_count).toBeGreaterThanOrEqual(0);
  });

  it('TrackingStatus type accepts valid values', () => {
    const statuses: TrackingStatus[] = ['watching', 'completed', 'plan_to_watch', 'dropped', 'on_hold'];
    expect(statuses).toHaveLength(5);
  });
});
