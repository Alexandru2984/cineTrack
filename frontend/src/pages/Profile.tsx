import { useParams } from 'react-router-dom';
import { useUserProfile, useUserActivity, useFollow, useUnfollow } from '@/hooks/useSocial';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useAuthStore } from '@/store/auth';
import { getPosterUrl, formatDate } from '@/lib/utils';
import { User, UserPlus, UserMinus, Calendar } from 'lucide-react';

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const { data: profile, isLoading } = useUserProfile(username!);
  const { data: activity } = useUserActivity(username!);
  const currentUser = useAuthStore((s) => s.user);
  const follow = useFollow();
  const unfollow = useUnfollow();

  if (isLoading) return <LoadingSpinner />;
  if (!profile) return <div className="text-center py-16">User not found</div>;

  const isOwnProfile = currentUser?.id === profile.id;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 space-y-8">
      {/* Profile header */}
      <div className="flex items-start gap-6">
        <div className="h-20 w-20 rounded-full bg-[hsl(var(--primary))]/20 flex items-center justify-center shrink-0">
          {profile.avatar_url ? (
            <img src={profile.avatar_url} alt="" className="h-20 w-20 rounded-full object-cover" />
          ) : (
            <User className="h-10 w-10 text-[hsl(var(--primary))]" />
          )}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold">{profile.username}</h1>
            {!isOwnProfile && (
              <button
                onClick={() => profile.is_following ? unfollow.mutate(username!) : follow.mutate(username!)}
                className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                  profile.is_following
                    ? 'border border-[hsl(var(--border))] hover:border-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))]'
                    : 'bg-[hsl(var(--primary))] text-white'
                }`}
              >
                {profile.is_following ? (
                  <><UserMinus className="h-4 w-4" /> Unfollow</>
                ) : (
                  <><UserPlus className="h-4 w-4" /> Follow</>
                )}
              </button>
            )}
          </div>
          {profile.bio && <p className="mt-2 text-[hsl(var(--muted-foreground))]">{profile.bio}</p>}
          <div className="flex gap-6 mt-3 text-sm">
            <span><strong>{profile.followers_count}</strong> followers</span>
            <span><strong>{profile.following_count}</strong> following</span>
            <span className="flex items-center gap-1 text-[hsl(var(--muted-foreground))]">
              <Calendar className="h-3 w-3" /> Joined {formatDate(profile.created_at)}
            </span>
          </div>
        </div>
      </div>

      {/* Activity */}
      <div>
        <h2 className="text-xl font-bold mb-4">Recent Activity</h2>
        {(!activity || activity.length === 0) ? (
          <p className="text-[hsl(var(--muted-foreground))]">No activity yet</p>
        ) : (
          <div className="space-y-3">
            {activity.map((item) => (
              <div key={item.id} className="flex items-center gap-3 rounded-lg border border-[hsl(var(--border))] p-3">
                <img
                  src={getPosterUrl(item.poster_path, 'w92')}
                  alt=""
                  className="h-16 w-11 rounded object-cover"
                />
                <div className="flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{item.username}</span> {item.action}{' '}
                    <span className="font-medium">{item.media_title}</span>
                  </p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                    {formatDate(item.timestamp)} · {item.media_type}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
