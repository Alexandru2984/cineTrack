import { Redirect, router, useLocalSearchParams } from 'expo-router';
import {
  Ban,
  CalendarDays,
  Clock3,
  Flag,
  LockKeyhole,
  MessageCircle,
  UserMinus,
  UserPlus,
} from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { ReportSheet } from '@/components/report-sheet';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { SocialActivityRow } from '@/components/social-activity-row';
import { UserAvatar } from '@/components/user-avatar';
import { spacing } from '@/constants/theme';
import { useBlockUser } from '@/hooks/use-community-safety';
import {
  useFollowUser,
  usePublicUserActivity,
  usePublicUserProfile,
  useUnfollowUser,
} from '@/hooks/use-social';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { profilePath, safePostAuthRedirect } from '@/lib/deep-links';
import { formatDate } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { hydrateSession } from '@/lib/session';
import { relationshipLabel, uniqueActivities } from '@/lib/social';
import { hasLocalSession, useAuthStore } from '@/store/auth';

export default function PublicProfileScreen() {
  const theme = useTheme();
  const t = useT();
  const status = useAuthStore((state) => state.status);
  const currentUser = useAuthStore((state) => state.user);
  const params = useLocalSearchParams<{ username: string }>();
  const username = Array.isArray(params.username) ? params.username[0] : params.username;
  const sessionAvailable = hasLocalSession(status);
  const returnTo = safePostAuthRedirect(profilePath(username ?? ''));
  const profile = usePublicUserProfile(username ?? '', sessionAvailable && returnTo !== null);
  const activity = usePublicUserActivity(
    username ?? '',
    profile.data?.can_view_activity ?? false,
  );
  const follow = useFollowUser();
  const unfollow = useUnfollowUser();
  const block = useBlockUser();
  const [reporting, setReporting] = useState(false);
  const activityItems = uniqueActivities(activity.data?.pages ?? []);

  if (!returnTo) {
    return (
      <ErrorState
        message={t('profile.invalidLink')}
        onRetry={() => router.replace('/')}
      />
    );
  }
  if (status === 'loading') return <LoadingState label={t('session.restoring')} />;
  if (status === 'restore_error') {
    return (
      <ErrorState
        message={t('session.restoreError')}
        onRetry={() => void hydrateSession()}
      />
    );
  }
  if (!sessionAvailable) {
    return (
      <Redirect
        href={{ pathname: '/(auth)/login', params: { redirect: String(returnTo) } }}
      />
    );
  }
  if (profile.isLoading) return <LoadingState label={t('profile.loading')} />;
  if (profile.isError || !profile.data) {
    return (
      <ErrorState
        message={getErrorMessage(profile.error, t('profile.loadError'))}
        onRetry={() => void profile.refetch()}
      />
    );
  }

  const person = profile.data;
  const isSelf = person.id === currentUser?.id;
  const remove = person.follow_status !== null;
  const relationshipPending = follow.isPending || unfollow.isPending || block.isPending;
  const relationshipError = follow.error ?? unfollow.error ?? block.error;

  const confirmBlock = () => {
    Alert.alert(
      t('safety.blockConfirmTitle'),
      t('safety.blockConfirm', { username: person.username }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('safety.block'),
          style: 'destructive',
          onPress: () =>
            block.mutate(person.username, {
              onSuccess: () => router.replace('/social'),
            }),
        },
      ],
    );
  };

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
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={t('profile.openFollowers', {
                      username: person.username,
                    })}
                    onPress={() =>
                      router.push({
                        pathname: '/connections/[username]',
                        params: { username: person.username, kind: 'followers' },
                      })
                    }
                    style={({ pressed }) => [styles.countLink, { opacity: pressed ? 0.65 : 1 }]}
                  >
                    <AppText>
                      <AppText variant="label">{person.followers_count}</AppText>{' '}
                      {t('profile.followers')}
                    </AppText>
                  </Pressable>
                ) : null}
                {person.following_count !== null ? (
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={t('profile.openFollowing', {
                      username: person.username,
                    })}
                    onPress={() =>
                      router.push({
                        pathname: '/connections/[username]',
                        params: { username: person.username, kind: 'following' },
                      })
                    }
                    style={({ pressed }) => [styles.countLink, { opacity: pressed ? 0.65 : 1 }]}
                  >
                    <AppText>
                      <AppText variant="label">{person.following_count}</AppText>{' '}
                      {t('profile.following')}
                    </AppText>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            <View style={styles.joined}>
              <CalendarDays color={theme.mutedText} size={15} />
              <AppText variant="caption" muted>
                {t('profile.joined', { date: formatDate(person.created_at.slice(0, 10)) })}
              </AppText>
            </View>
          </View>
        </View>

        {!isSelf ? (
          <View style={styles.relationshipActions}>
            {person.is_following && person.is_followed_by ? (
              <AppButton
                label={t('profile.message')}
                accessibilityLabel={t('profile.messageUser', {
                  username: person.username,
                })}
                icon={<MessageCircle color="#FFFFFF" size={18} />}
                onPress={() =>
                  router.push({
                    pathname: '/messages/[username]',
                    params: { username: person.username },
                  })
                }
                style={styles.primaryAction}
              />
            ) : null}
            <AppButton
              label={relationshipLabel(t, person.follow_status, person.is_public)}
              icon={remove
                ? <UserMinus color={theme.text} size={18} />
                : <UserPlus color="#FFFFFF" size={18} />}
              variant={remove ? 'secondary' : 'primary'}
              loading={follow.isPending || unfollow.isPending}
              disabled={relationshipPending}
              onPress={() => remove
                ? unfollow.mutate(person.username)
                : follow.mutate(person.username)}
              style={styles.primaryAction}
            />
            <AppButton
              label={t('safety.report')}
              icon={<Flag color={theme.text} size={18} />}
              variant="secondary"
              compact
              disabled={relationshipPending}
              onPress={() => setReporting(true)}
            />
            <AppButton
              label={t('safety.block')}
              icon={<Ban color="#FFFFFF" size={18} />}
              variant="danger"
              compact
              loading={block.isPending}
              disabled={relationshipPending}
              onPress={confirmBlock}
            />
          </View>
        ) : null}
        {relationshipError ? (
          <AppText variant="caption" style={{ color: theme.danger }}>
            {getErrorMessage(relationshipError, t('social.followError'))}
          </AppText>
        ) : null}

        <View style={styles.activitySection}>
          <AppText variant="section">{t('profile.recentActivity')}</AppText>
          {!person.can_view_activity ? (
            <EmptyState
              icon={LockKeyhole}
              title={t('profile.privateActivityTitle')}
              message={t('profile.privateActivityMessage')}
            />
          ) : activity.isLoading ? (
            <LoadingState label={t('profile.loadingActivity')} />
          ) : activity.isError ? (
            <ErrorState
              message={t('profile.activityLoadError')}
              onRetry={() => void activity.refetch()}
            />
          ) : activityItems.length === 0 ? (
            <EmptyState
              icon={Clock3}
              title={t('profile.noActivityTitle')}
              message={t('profile.noActivityMessage')}
            />
          ) : (
            <View style={styles.list}>
              {activityItems.map((item) => (
                <SocialActivityRow key={item.id} item={item} showUser={false} />
              ))}
              {activity.hasNextPage ? (
                <AppButton
                  label={t('common.loadMore')}
                  variant="secondary"
                  loading={activity.isFetchingNextPage}
                  onPress={() => void activity.fetchNextPage()}
                />
              ) : null}
            </View>
          )}
        </View>
      </ScrollView>
      {reporting ? (
        <ReportSheet
          targetType="user"
          targetId={person.id}
          targetLabel={`@${person.username}`}
          onClose={() => setReporting(false)}
        />
      ) : null}
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
  countLink: { minHeight: 44, justifyContent: 'center' },
  joined: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  relationshipActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  primaryAction: { flexGrow: 1 },
  activitySection: { gap: spacing.md },
  list: { gap: spacing.md },
});
