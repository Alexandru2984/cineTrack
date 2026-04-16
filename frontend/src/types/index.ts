export interface User {
  id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  created_at: string;
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
  followers_count: number;
  following_count: number;
  is_following: boolean;
  created_at: string;
}

export interface ActivityItem {
  id: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  action: string;
  media_title: string;
  media_type: string;
  poster_path: string | null;
  timestamp: string;
}

export interface ListResponse {
  id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  item_count: number;
  created_at: string;
}

export type TrackingStatus = 'watching' | 'completed' | 'plan_to_watch' | 'dropped' | 'on_hold';
