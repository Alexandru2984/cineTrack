export type MediaType = 'movie' | 'tv';
export type TrackingStatus =
  | 'watching'
  | 'completed'
  | 'plan_to_watch'
  | 'dropped'
  | 'on_hold';

export interface User {
  id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  /** Absent on sessions cached before this field existed; treat only `false` as unverified. */
  email_verified?: boolean;
  created_at: string;
}

export interface AccountSession {
  id: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

export interface MobileAuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

export interface Media {
  id: string;
  tmdb_id: number;
  media_type: MediaType;
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

export interface SeasonWatchProgress {
  season_number: number;
  episode_count: number | null;
  available_episode_count: number;
  watched_count: number;
}

export interface BulkWatchResponse {
  media_id: string;
  candidate_count: number;
  marked_count: number;
  already_watched_count: number;
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
  media_type: MediaType;
  title: string;
  poster_path: string | null;
  status: TrackingStatus;
  rating: number | null;
  review: string | null;
  is_favorite: boolean;
  started_at: string | null;
  completed_at: string | null;
}

export interface HistoryItem {
  id: string;
  media_id: string;
  tmdb_id: number;
  media_title: string;
  media_type: MediaType;
  poster_path: string | null;
  episode_id: string | null;
  episode_name: string | null;
  season_number: number | null;
  episode_number: number | null;
  watched_at: string;
}

export interface CustomListSummary {
  id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  item_count: number;
  created_at: string;
}

export interface CustomList {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  created_at: string;
}

export interface CustomListDetail {
  list: CustomList;
  items: Media[];
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

export type FollowStatus = 'pending' | 'accepted' | null;

export interface PublicUserProfile {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  followers_count: number | null;
  following_count: number | null;
  is_following: boolean;
  follow_status: FollowStatus;
  can_view_activity: boolean;
  created_at: string;
}

export interface UserSearchResult {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  followers_count: number | null;
  follow_status: FollowStatus;
}

export interface UserSearchResponse {
  results: UserSearchResult[];
  page: number;
  has_more: boolean;
}

export interface UserSummary {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
}

export interface FollowRequest {
  user_id: string;
  username: string;
  avatar_url: string | null;
  requested_at: string;
}

export interface ActivityItem {
  id: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  action: string;
  tmdb_id: number;
  media_title: string;
  media_type: MediaType;
  poster_path: string | null;
  episode_name: string | null;
  season_number: number | null;
  episode_number: number | null;
  timestamp: string;
}

export interface CalendarEpisode {
  episode_id: string;
  media_id: string;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  season_number: number;
  episode_number: number;
  episode_name: string | null;
  overview: string | null;
  runtime_minutes: number | null;
  air_date: string;
  still_path: string | null;
  is_planned: boolean;
}

export interface EpisodeCursor {
  before_date: string;
  before_id: string;
}

export interface CalendarEpisodePage {
  items: CalendarEpisode[];
  next_cursor: EpisodeCursor | null;
}

export interface UpNextResponse {
  items: CalendarEpisode[];
}

export type UpcomingItemKind = 'episode' | 'movie';

export interface UpcomingCalendarItem {
  item_kind: UpcomingItemKind;
  item_id: string;
  media_id: string;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  release_date: string;
  release_type: number | null;
  season_number: number | null;
  episode_number: number | null;
  episode_name: string | null;
  still_path: string | null;
  is_planned: boolean;
}

export interface UpcomingCursor {
  after_date: string;
  after_kind: UpcomingItemKind;
  after_key: string;
}

export interface UpcomingCalendarPage {
  items: UpcomingCalendarItem[];
  next_cursor: UpcomingCursor | null;
  country_code: string;
}

export interface CalendarSummary {
  new_count: number;
  planned_count: number;
  last_synced_at: string | null;
}

export interface CalendarPreferences {
  country_code: string;
}

export interface CalendarWatchResponse {
  history_id: string;
  media_id: string;
  episode_id: string;
  already_watched: boolean;
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
