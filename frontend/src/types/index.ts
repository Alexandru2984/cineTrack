export interface User {
  id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  email_verified: boolean;
  two_factor_enabled: boolean;
  terms_accepted_version?: string | null;
  terms_accepted_at?: string | null;
  current_terms_version?: string;
  terms_acceptance_required?: boolean;
  created_at: string;
}

export interface WatchProviderEntry {
  provider_id: number;
  name: string;
  logo_path: string | null;
}

export interface WatchProviders {
  region: string;
  link: string | null;
  stream: WatchProviderEntry[];
  rent: WatchProviderEntry[];
  buy: WatchProviderEntry[];
}

// Aggregate of Văzute members' own 1–10 ratings for a title (distinct from
// TMDB's vote_average). `average` and `distribution` are null below the
// server's display floor; `count` is always present. `distribution` has ten
// buckets, index 0 = one star … index 9 = ten stars.
export interface CommunityRating {
  count: number;
  average: number | null;
  distribution: number[] | null;
}

export interface CalendarFeedStatus {
  enabled: boolean;
}

export interface CalendarFeedCredential {
  feed_url: string;
}

export interface UserSummary {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
}

export interface BlockedUser {
  id: string;
  username: string;
  avatar_url: string | null;
  blocked_at: string;
}

export interface SafetyReport {
  id: string;
  target_type: 'user' | 'list' | 'message';
  target_id: string;
  reason: string;
  details: string | null;
  status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
  created_at: string;
}

export type ModerationReportStatus =
  | 'open'
  | 'reviewing'
  | 'actioned'
  | 'dismissed';

export interface ModerationReport {
  id: string;
  reporter_id: string | null;
  reporter_username: string | null;
  subject_user_id: string | null;
  subject_username: string | null;
  target_type: 'user' | 'list' | 'message';
  target_id: string;
  reason: string;
  details: string | null;
  content_snapshot: Record<string, unknown>;
  status: ModerationReportStatus;
  moderated_by: string | null;
  moderator_username: string | null;
  moderator_note: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModerationStatusCounts {
  open: number;
  reviewing: number;
  actioned: number;
  dismissed: number;
}

export interface ModerationQueue {
  items: ModerationReport[];
  counts: ModerationStatusCounts;
  page: number;
  has_more: boolean;
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

export interface EpisodeDetail {
  episode_id: string;
  media_id: string;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  backdrop_path: string | null;
  season_id: string;
  season_number: number;
  season_name: string | null;
  episode_number: number;
  episode_name: string | null;
  overview: string | null;
  runtime_minutes: number | null;
  air_date: string | null;
  still_path: string | null;
  tracking_status: TrackingStatus | null;
  is_available: boolean;
  is_watched: boolean;
  is_planned: boolean;
  watch_count: number;
  last_watched_at: string | null;
  reactions: ReactionCount[];
  my_reaction: EpisodeReaction | null;
}

/** Fixed vocabulary, mirrored by a CHECK constraint on the table. */
export const EPISODE_REACTIONS = [
  'loved',
  'funny',
  'shocked',
  'sad',
  'tense',
  'bored',
] as const;

export type EpisodeReaction = (typeof EPISODE_REACTIONS)[number];

export interface ReactionCount {
  reaction: EpisodeReaction;
  count: number;
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

export interface BecauseYouWatched {
  seed_tmdb_id: number;
  seed_media_type: string;
  seed_title: string;
  results: TmdbSearchResult[];
}

export interface DiscoveryResponse {
  recommendations: TmdbSearchResult[];
  personalized: boolean;
  recommendation_basis: string[];
  popular_movies: TmdbSearchResult[];
  popular_shows: TmdbSearchResult[];
  // TMDB's collaborative "because you watched" row; absent when there is no
  // seed yet or the upstream call was unavailable.
  because_you_watched?: BecauseYouWatched | null;
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

export interface CalendarEpisode {
  episode_id: string;
  media_id: string;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  season_number: number;
  episode_number: number;
  episode_name: string | null;
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

export interface UpNextEpisode extends CalendarEpisode {
  /** When the user last watched anything from this show. Up next only returns
   *  shows they have started, so this is always present. */
  last_watched_at: string;
}

/** A started show whose next episode cannot be named yet, because a season at
 *  or before it has not been fetched from the provider. Reported separately so
 *  the queue can stay silent rather than offer a later episode as if it were
 *  next — which once sent a viewer from season one into season three. */
export interface UpNextAwaitingCatalog {
  media_id: string;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  missing_season_number: number;
  last_watched_at: string;
}

export interface UpNextResponse {
  items: UpNextEpisode[];
  /** Optional: responses from a backend older than this field omit it. */
  awaiting_catalog?: UpNextAwaitingCatalog[];
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

export interface WrappedTitle {
  tmdb_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  count: number;
}

export interface WrappedMonth {
  month: number;
  count: number;
}

export interface WrappedStats {
  year: number;
  total_watches: number;
  movies_watched: number;
  episodes_watched: number;
  distinct_titles: number;
  total_hours: number;
  longest_streak: number;
  first_watch: string | null;
  last_watch: string | null;
  top_genres: GenreDistribution[];
  top_shows: WrappedTitle[];
  monthly: WrappedMonth[];
}

export interface PublicUserProfile {
  id: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
  is_public: boolean;
  followers_count: number | null;
  following_count: number | null;
  is_following: boolean;
  is_followed_by: boolean;
  follow_status: 'pending' | 'accepted' | null;
  can_view_activity: boolean;
  created_at: string;
}

export interface DirectMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  /** Null for an encrypted message. The server has nothing to put here, and
   *  says so rather than inventing a placeholder. */
  body: string | null;
  ciphertext?: string | null;
  nonce?: string | null;
  sender_ephemeral_key?: string | null;
  sender_copy?: string | null;
  franking_commitment?: string | null;
  /** The sender's signature over the commitment, and the nonce it is bound to.
   *  Together they are the only evidence in an envelope that says who wrote it:
   *  anyone can seal a message to a public exchange key. */
  franking_signature?: string | null;
  client_nonce?: string | null;
  /** The signing key recorded when the message was sent. Never verified
   *  against — the directory key is — but it separates a key rotation from
   *  tampering when a signature does not check out. */
  sender_signing_key?: string | null;
  read_at: string | null;
  created_at: string;
}

export interface MessagePeer {
  id: string;
  username: string;
  avatar_url: string | null;
}

export interface MessageThread {
  user: MessagePeer;
  can_message: boolean;
  messages: DirectMessage[];
}

export interface MessageConversation {
  user_id: string;
  username: string;
  avatar_url: string | null;
  last_message_id: string;
  last_message_sender_id: string;
  last_message_body: string | null;
  last_message_ciphertext?: string | null;
  last_message_nonce?: string | null;
  last_message_sender_ephemeral_key?: string | null;
  last_message_sender_copy?: string | null;
  last_message_at: string;
  last_message_read_at: string | null;
  unread_count: number;
  can_message: boolean;
}

export interface MessageSummary {
  unread_count: number;
}

export interface BadgeShow {
  media_id: string;
  tmdb_id: number;
  title: string;
  poster_path: string | null;
  earned_at: string;
}

export interface EarnedBadge {
  key: string;
  family: string;
  threshold: number;
  /** How many shows earned this tier. 1 for account-wide badges. */
  count: number;
  first_earned_at: string;
  shows: BadgeShow[];
}

export interface BadgeProgress {
  family: string;
  next_key: string;
  current: number;
  threshold: number;
}

export interface BadgeShelf {
  earned: EarnedBadge[];
  progress: BadgeProgress[];
}

export interface KdfParameters {
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

export interface KeyStatus {
  has_keys: boolean;
  key_fingerprint: string | null;
  generation: number | null;
}

export interface KeyBackup {
  password_wrapped_key: string;
  password_kdf_salt: string;
  password_kdf: KdfParameters;
  recovery_wrapped_key: string;
  recovery_kdf_salt: string;
  updated_at: string;
}

export interface PeerPublicKeys {
  user_id: string;
  username: string;
  exchange_public_key: string;
  signing_public_key: string;
  key_fingerprint: string;
  generation: number;
  updated_at: string;
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
  followers_count: number | null;
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
  episode_id: string | null;
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

export interface Session {
  id: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

export interface SecurityActivity {
  id: string;
  event_type: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
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
