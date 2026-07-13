export interface User {
  id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  created_at: string;
}

export interface UserSummary {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

export interface Media {
  id: string;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  title: string;
  original_title: string | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string | null;
  status: string | null;
  genres: { id: number; name: string }[] | null;
  runtime_minutes: number | null;
  vote_average: number | null;
}

export interface Season {
  id: string;
  season_number: number;
  name: string | null;
  episode_count: number | null;
  air_date: string | null;
}

export interface Episode {
  id: string;
  episode_number: number;
  name: string | null;
  overview: string | null;
  runtime_minutes: number | null;
  air_date: string | null;
  still_path: string | null;
}

export interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  media_type?: string;
  genre_ids?: number[];
}

export interface TmdbSearchResponse {
  page: number;
  total_pages: number;
  total_results: number;
  results: TmdbSearchResult[];
}

export interface DiscoveryResponse {
  recommendations: TmdbSearchResult[];
  personalized: boolean;
  recommendation_basis: string[];
  popular_movies: TmdbSearchResult[];
  popular_shows: TmdbSearchResult[];
}

export interface TrackingItem {
  id: string;
  media_id: string;
  tmdb_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  status: string;
  rating: number | null;
  review: string | null;
  is_favorite: boolean;
  started_at: string | null;
  completed_at: string | null;
}

export interface HistoryItem {
  id: string;
  media_id: string;
  media_title: string;
  media_type: string;
  poster_path: string | null;
  episode_id: string | null;
  episode_name: string | null;
  watched_at: string;
}

export interface UserStats {
  total_movies: number;
  total_shows: number;
  total_episodes: number;
  total_hours: number;
  current_streak: number;
  longest_streak: number;
}

export interface HeatmapDay {
  date: string;
  count: number;
}

export interface GenreDistribution {
  genre: string;
  count: number;
}

export interface MonthlyActivity {
  month: string;
  hours: number;
  count: number;
}

export interface PublicUserProfile {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  followers_count: number;
  following_count: number;
  is_following: boolean;
  follow_status: 'pending' | 'accepted' | null;
  can_view_activity: boolean;
  created_at: string;
}

export interface FollowRequest {
  user_id: string;
  username: string;
  avatar_url: string | null;
  requested_at: string;
}

export interface UserSearchResult {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  followers_count: number;
  follow_status: 'pending' | 'accepted' | null;
}

export interface UserSearchResponse {
  results: UserSearchResult[];
  page: number;
  has_more: boolean;
}

export interface ActivityItem {
  id: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  action: string;
  tmdb_id: number;
  media_title: string;
  media_type: string;
  poster_path: string | null;
  episode_name: string | null;
  season_number: number | null;
  episode_number: number | null;
  timestamp: string;
}

export type NotificationKind = 'follow_request' | 'follow_accepted' | 'new_follower';

export interface SocialNotification {
  id: string;
  kind: NotificationKind;
  actor_id: string;
  actor_username: string;
  actor_avatar_url: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationListResponse {
  items: SocialNotification[];
  unread_count: number;
  has_more: boolean;
}

export interface ListResponse {
  id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  item_count: number;
  created_at: string;
}

export interface Session {
  id: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

export type TrackingStatus = 'watching' | 'completed' | 'plan_to_watch' | 'dropped' | 'on_hold';

export interface ImportTotals {
  shows: number;
  movies: number;
  episodes_linked: number;
  episodes_date_only: number;
  rewatches: number;
  unresolved: string[];
}

export type ImportStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ImportJob {
  id: string;
  status: ImportStatus;
  totals: ImportTotals | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
