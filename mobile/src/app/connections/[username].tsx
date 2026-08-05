import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { UserCheck, Users } from 'lucide-react-native';
import { useMemo } from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { SocialUserRow } from '@/components/social-user-row';
import { spacing } from '@/constants/theme';
import { useProfileConnections } from '@/hooks/use-social';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { profilePath, safePostAuthRedirect } from '@/lib/deep-links';
import { getErrorMessage } from '@/lib/http';
import { hydrateSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';

type ConnectionKind = 'followers' | 'following';

export default function ProfileConnectionsScreen() {
  const theme = useTheme();
  const t = useT();
  const status = useAuthStore((state) => state.status);
  const params = useLocalSearchParams<{ username: string; kind?: string }>();
  const username = Array.isArray(params.username) ? params.username[0] : params.username;
  const rawKind = Array.isArray(params.kind) ? params.kind[0] : params.kind;
  const kind: ConnectionKind | null =
    rawKind === 'followers' || rawKind === 'following' ? rawKind : null;
  const validUsername = Boolean(
    username && safePostAuthRedirect(profilePath(username)) !== null,
  );
  const online = status === 'authenticated';
  const connections = useProfileConnections(
    username ?? '',
    kind ?? 'followers',
    online && validUsername && kind !== null,
  );
  const people = useMemo(
    () =>
      Array.from(
        new Map(
          (connections.data?.pages.flat() ?? []).map((person) => [person.id, person]),
        ).values(),
      ),
    [connections.data],
  );

  if (!validUsername || !kind) {
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
  if (status === 'offline') {
    return (
      <ErrorState
        message={t('messages.offline')}
        onRetry={() => void hydrateSession()}
      />
    );
  }
  if (!online) return <Redirect href="/" />;

  const title = kind === 'followers' ? t('profile.followers') : t('profile.following');
  const emptyTitle =
    kind === 'followers'
      ? t('profile.connectionsEmptyFollowers')
      : t('profile.connectionsEmptyFollowing');

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <FlatList
        data={people}
        keyExtractor={(person) => person.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={connections.isRefetching}
            onRefresh={() => void connections.refetch()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        ListHeaderComponent={
          <ScreenHeader title={title} subtitle={`@${username}`} />
        }
        ListEmptyComponent={
          connections.isLoading ? (
            <LoadingState label={t('profile.connectionsLoading')} />
          ) : connections.isError ? (
            <ErrorState
              message={getErrorMessage(
                connections.error,
                t('profile.connectionsLoadError'),
              )}
              onRetry={() => void connections.refetch()}
            />
          ) : (
            <EmptyState
              icon={kind === 'followers' ? Users : UserCheck}
              title={emptyTitle}
              message={emptyTitle}
            />
          )
        }
        ListFooterComponent={
          connections.isFetchingNextPage ? (
            <LoadingState label={t('common.loading')} />
          ) : null
        }
        onEndReached={() => {
          if (connections.hasNextPage && !connections.isFetchingNextPage) {
            void connections.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.35}
        renderItem={({ item }) => (
          <SocialUserRow
            username={item.username}
            avatarUrl={item.avatar_url}
            bio={item.bio}
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: 760,
    flexGrow: 1,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
});
