import { Link, useParams } from 'react-router-dom';
import { useUserProfile, useUserActivity, useFollow, useUnfollow } from '@/hooks/useSocial';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { ActivityList } from '@/components/ActivityList';
import { useAuthStore } from '@/store/auth';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatDate } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/api';
import {
  BarChart3,
  Calendar,
  Clock3,
  LockKeyhole,
  Settings,
  User,
  UserMinus,
  UserPlus,
} from 'lucide-react';

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const { data: profile, isLoading } = useUserProfile(username!);
  const {
    data: activity,
    isLoading: activityLoading,
    isError: activityError,
  } = useUserActivity(username!, profile?.can_view_activity ?? false);
  const currentUser = useAuthStore((s) => s.user);
  usePageTitle(profile ? `@${profile.username}` : null);
  const follow = useFollow();
  const unfollow = useUnfollow();

  if (isLoading) return <LoadingSpinner />;
  if (!profile) return <div className="text-center py-16">User not found</div>;

  const isOwnProfile = currentUser?.id === profile.id;
  const hasPendingRequest = profile.follow_status === 'pending';
  const hasAcceptedFollow = profile.follow_status === 'accepted';
  const removeRelationship = hasPendingRequest || hasAcceptedFollow;

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-6 sm:py-8">
      {/* Profile header */}
      <div className="flex items-start gap-4 sm:gap-6">
        <div className="h-20 w-20 rounded-full bg-[hsl(var(--primary))]/20 flex items-center justify-center shrink-0">
          {profile.avatar_url ? (
            <img src={profile.avatar_url} alt="" className="h-20 w-20 rounded-full object-cover" />
          ) : (
            <User className="h-10 w-10 text-[hsl(var(--primary))]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-all text-2xl font-bold">{profile.username}</h1>
            {isOwnProfile && (
              <span className="flex items-center gap-1">
                <Link
                  to="/stats"
                  aria-label="Stats"
                  title="Stats"
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))]"
                >
                  <BarChart3 className="h-4 w-4" aria-hidden="true" />
                </Link>
                <Link
                  to="/settings"
                  aria-label="Settings"
                  title="Settings"
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))]"
                >
                  <Settings className="h-4 w-4" aria-hidden="true" />
                </Link>
              </span>
            )}
            {!isOwnProfile && (
              <button
                onClick={() =>
                  removeRelationship ? unfollow.mutate(username!) : follow.mutate(username!)
                }
                title={hasPendingRequest ? 'Cancel follow request' : undefined}
                disabled={follow.isPending || unfollow.isPending}
                className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                  removeRelationship
                    ? 'border border-[hsl(var(--border))] hover:border-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))]'
                    : 'bg-[hsl(var(--primary))] text-white'
                } disabled:opacity-50`}
              >
                {hasAcceptedFollow ? (
                  <><UserMinus className="h-4 w-4" /> Unfollow</>
                ) : hasPendingRequest ? (
                  <><Clock3 className="h-4 w-4" /> Request sent</>
                ) : (
                  <><UserPlus className="h-4 w-4" /> {profile.is_public ? 'Follow' : 'Request to follow'}</>
                )}
              </button>
            )}
            {!profile.is_public && (
              <span className="flex items-center gap-1 text-xs text-[hsl(var(--muted-foreground))]">
                <LockKeyhole className="h-3.5 w-3.5" /> Private
              </span>
            )}
          </div>
          {profile.bio && <p className="mt-2 text-[hsl(var(--muted-foreground))]">{profile.bio}</p>}
          {(follow.error || unfollow.error) && (
            <p className="mt-2 text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(follow.error ?? unfollow.error, 'Could not update follow status')}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {profile.followers_count !== null && (
              <span><strong>{profile.followers_count}</strong> followers</span>
            )}
            {profile.following_count !== null && (
              <span><strong>{profile.following_count}</strong> following</span>
            )}
            <span className="flex items-center gap-1 text-[hsl(var(--muted-foreground))]">
              <Calendar className="h-3 w-3" /> Joined {formatDate(profile.created_at)}
            </span>
          </div>
        </div>
      </div>

      {/* Activity */}
      <div>
        <h2 className="text-xl font-bold mb-4">Recent Activity</h2>
        {!profile.can_view_activity ? (
          <div className="flex items-center gap-2 py-6 text-[hsl(var(--muted-foreground))]">
            <LockKeyhole className="h-5 w-5" />
            This activity is private. An accepted follow request is required.
          </div>
        ) : (
          <ActivityList
            items={activity}
            isLoading={activityLoading}
            isError={activityError}
            showUser={false}
          />
        )}
      </div>
    </div>
  );
}
