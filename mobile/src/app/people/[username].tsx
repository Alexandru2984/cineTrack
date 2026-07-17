import { Redirect, useLocalSearchParams } from 'expo-router';
import { CalendarDays, Clock3, LockKeyhole, UserMinus, UserPlus } from 'lucide-react-native';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { SocialActivityRow } from '@/components/social-activity-row';
import { UserAvatar } from '@/components/user-avatar';
import { spacing } from '@/constants/theme';
import {
  useFollowUser,
  usePublicUserActivity,
  usePublicUserProfile,
  useUnfollowUser,
} from '@/hooks/use-social';
import { useTheme } from '@/hooks/use-theme';
import { formatDate } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { relationshipLabel, uniqueActivities } from '@/lib/social';
import { useAuthStore } from '@/store/auth';

export default function PublicProfileScreen() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const currentUser = useAuthStore((state) => state.user);
  const params = useLocalSearchParams<{ username: string }>();
  const username = Array.isArray(params.username) ? params.username[0] : params.username;
  const profile = usePublicUserProfile(username ?? '');
  const activity = usePublicUserActivity(
    username ?? '',
    profile.data?.can_view_activity ?? false,
  );
  const follow = useFollowUser();
  const unfollow = useUnfollowUser();
  const activityItems = uniqueActivities(activity.data?.pages ?? []);

  if (status !== 'authenticated') return <Redirect href="/" />;
  if (profile.isLoading) return <LoadingState label="Loading profile" />;
  if (profile.isError || !profile.data) {
    return (
      <ErrorState
        message={getErrorMessage(profile.error, 'Profile could not be loaded')}
        onRetry={() => void profile.refetch()}
      />
    );
  }

  const person = profile.data;
  const isSelf = person.id === currentUser?.id;
  const remove = person.follow_status !== null;
  const relationshipPending = follow.isPending || unfollow.isPending;
  const relationshipError = follow.error ?? unfollow.error;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.identity}>
          <UserAvatar uri={person.avatar_url} size={80} />
          <View style={styles.identityCopy}>
            <View style={styles.nameRow}>
              <AppText variant="title" numberOfLines={2} style={styles.name}>
                {person.username}
              </AppText>
              {!person.is_public ? <LockKeyhole color={theme.mutedText} size={17} /> : null}
            </View>
            {person.bio ? <AppText muted>{person.bio}</AppText> : null}
            {person.followers_count !== null || person.following_count !== null ? (
              <View style={styles.counts}>
                {person.followers_count !== null ? (
                  <AppText><AppText variant="label">{person.followers_count}</AppText> followers</AppText>
                ) : null}
                {person.following_count !== null ? (
                  <AppText><AppText variant="label">{person.following_count}</AppText> following</AppText>
                ) : null}
              </View>
            ) : null}
            <View style={styles.joined}>
              <CalendarDays color={theme.mutedText} size={15} />
              <AppText variant="caption" muted>
                Joined {formatDate(person.created_at.slice(0, 10))}
              </AppText>
            </View>
          </View>
        </View>

        {!isSelf ? (
          <AppButton
            label={relationshipLabel(person.follow_status, person.is_public)}
            icon={remove
              ? <UserMinus color={theme.text} size={18} />
              : <UserPlus color="#FFFFFF" size={18} />}
            variant={remove ? 'secondary' : 'primary'}
            loading={relationshipPending}
            onPress={() => remove
              ? unfollow.mutate(person.username)
              : follow.mutate(person.username)}
          />
        ) : null}
        {relationshipError ? (
          <AppText variant="caption" style={{ color: theme.danger }}>
            {getErrorMessage(relationshipError, 'Could not update follow status')}
          </AppText>
        ) : null}

        <View style={styles.activitySection}>
          <AppText variant="section">Recent activity</AppText>
          {!person.can_view_activity ? (
            <EmptyState
              icon={LockKeyhole}
              title="Private activity"
              message="An accepted follow request is required."
            />
          ) : activity.isLoading ? (
            <LoadingState label="Loading activity" />
          ) : activity.isError ? (
            <ErrorState
              message="Activity could not be loaded"
              onRetry={() => void activity.refetch()}
            />
          ) : activityItems.length === 0 ? (
            <EmptyState
              icon={Clock3}
              title="No recent activity"
              message="Nothing has been watched recently."
            />
          ) : (
            <View style={styles.list}>
              {activityItems.map((item) => (
                <SocialActivityRow key={item.id} item={item} showUser={false} />
              ))}
              {activity.hasNextPage ? (
                <AppButton
                  label="Load more"
                  variant="secondary"
                  loading={activity.isFetchingNextPage}
                  onPress={() => void activity.fetchNextPage()}
                />
              ) : null}
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    gap: spacing.xl,
  },
  identity: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
  identityCopy: { flex: 1, minWidth: 0, gap: spacing.sm },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1 },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  joined: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  activitySection: { gap: spacing.md },
  list: { gap: spacing.md },
});
