import { Redirect } from 'expo-router';
import { Check, Inbox, Search, UserCheck, Users, X } from 'lucide-react-native';
import { type ReactNode, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { ScreenHeader } from '@/components/screen-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { SegmentedControl } from '@/components/segmented-control';
import { SocialActivityRow } from '@/components/social-activity-row';
import { SocialUserRow } from '@/components/social-user-row';
import { radius, spacing } from '@/constants/theme';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  useAcceptFollowRequest,
  useConnections,
  useFollowRequests,
  useFollowUser,
  usePeopleSearch,
  useRejectFollowRequest,
  useSocialFeed,
  useUnfollowUser,
} from '@/hooks/use-social';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { formatDateTime } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import {
  isValidPeopleSearch,
  relationshipLabel,
  uniqueActivities,
} from '@/lib/social';
import { useAuthStore } from '@/store/auth';
import type { FollowStatus } from '@/types';

type SocialTab = 'feed' | 'people' | 'requests' | 'following' | 'followers';

export default function SocialScreen() {
  const theme = useTheme();
  const t = useT();
  const tabs = [
    { value: 'feed', label: t('social.tabFeed') },
    { value: 'people', label: t('social.tabPeople') },
    { value: 'requests', label: t('social.tabRequests') },
    { value: 'following', label: t('social.tabFollowing') },
    { value: 'followers', label: t('social.tabFollowers') },
  ] as const;
  const status = useAuthStore((state) => state.status);
  const currentUser = useAuthStore((state) => state.user);
  const [tab, setTab] = useState<SocialTab>('feed');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query.trim(), 350);
  const feed = useSocialFeed(tab === 'feed');
  const people = usePeopleSearch(debouncedQuery, tab === 'people');
  const requests = useFollowRequests(tab === 'requests');
  const following = useConnections('following', tab === 'following');
  const followers = useConnections('followers', tab === 'followers');
  const follow = useFollowUser();
  const unfollow = useUnfollowUser();
  const accept = useAcceptFollowRequest();
  const reject = useRejectFollowRequest();

  const feedItems = useMemo(
    () => uniqueActivities(feed.data?.pages ?? []),
    [feed.data],
  );
  const peopleItems = useMemo(
    () => Array.from(new Map(
      (people.data?.pages.flatMap((page) => page.results) ?? [])
        .map((person) => [person.id, person]),
    ).values()),
    [people.data],
  );
  const requestItems = useMemo(
    () => Array.from(new Map(
      (requests.data?.pages.flat() ?? []).map((request) => [request.user_id, request]),
    ).values()),
    [requests.data],
  );
  const followingItems = useMemo(
    () => Array.from(new Map(
      (following.data?.pages.flat() ?? []).map((person) => [person.id, person]),
    ).values()),
    [following.data],
  );
  const followerItems = useMemo(
    () => Array.from(new Map(
      (followers.data?.pages.flat() ?? []).map((person) => [person.id, person]),
    ).values()),
    [followers.data],
  );
  const mutationError = follow.error ?? unfollow.error ?? accept.error ?? reject.error;

  if (status !== 'authenticated') return <Redirect href="/" />;

  const relationshipAction = (
    username: string,
    followStatus: FollowStatus,
    isPublic: boolean,
  ) => {
    const remove = followStatus !== null;
    const pending = remove
      ? unfollow.isPending && unfollow.variables === username
      : follow.isPending && follow.variables === username;
    return (
      <AppButton
        compact
        label={relationshipLabel(t, followStatus, isPublic)}
        variant={remove ? 'secondary' : 'primary'}
        loading={pending}
        onPress={() => remove ? unfollow.mutate(username) : follow.mutate(username)}
      />
    );
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['bottom']}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <ScreenHeader title={t('social.title')} subtitle={t('social.subtitle')} />
        <SegmentedControl value={tab} options={tabs} onChange={setTab} />

        {mutationError ? (
          <AppText variant="caption" style={{ color: theme.danger }}>
            {getErrorMessage(mutationError, t('social.relationshipError'))}
          </AppText>
        ) : null}

        {tab === 'feed' ? (
          <SocialListState
            loading={feed.isLoading}
            error={feed.isError}
            empty={feedItems.length === 0}
            emptyIcon={Users}
            emptyTitle={t('social.feedEmptyTitle')}
            emptyMessage={t('social.feedEmptyMessage')}
            onRetry={() => void feed.refetch()}
          >
            {feedItems.map((item) => <SocialActivityRow key={item.id} item={item} />)}
            <LoadMore
              visible={feed.hasNextPage}
              pending={feed.isFetchingNextPage}
              onPress={() => void feed.fetchNextPage()}
            />
          </SocialListState>
        ) : null}

        {tab === 'people' ? (
          <View style={styles.panel}>
            <View style={[styles.searchBox, { borderColor: theme.border, backgroundColor: theme.elevated }]}>
              <Search color={theme.mutedText} size={20} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={t('social.searchPlaceholder')}
                placeholderTextColor={theme.mutedText}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={50}
                returnKeyType="search"
                style={[styles.input, { color: theme.text }]}
              />
            </View>
            {debouncedQuery.length > 0 && !isValidPeopleSearch(debouncedQuery) ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {t('social.searchInvalid')}
              </AppText>
            ) : null}
            <SocialListState
              loading={people.isLoading}
              error={people.isError}
              empty={peopleItems.length === 0}
              emptyIcon={Search}
              emptyTitle={
                debouncedQuery.length < 2 ? t('social.peopleFindTitle') : t('social.peopleNoneTitle')
              }
              emptyMessage={
                debouncedQuery.length < 2
                  ? t('social.peopleFindMessage')
                  : t('social.peopleNoneMessage')
              }
              onRetry={() => void people.refetch()}
            >
              {peopleItems.map((person) => (
                <SocialUserRow
                  key={person.id}
                  username={person.username}
                  avatarUrl={person.avatar_url}
                  bio={person.bio}
                  meta={[
                    person.followers_count !== null
                      ? t(
                          person.followers_count === 1
                            ? 'social.followersCountOne'
                            : 'social.followersCountMany',
                          { count: person.followers_count },
                        )
                      : null,
                    person.is_public ? null : t('social.privateBadge'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  action={person.id === currentUser?.id
                    ? <AppText variant="caption" muted>{t('social.you')}</AppText>
                    : relationshipAction(person.username, person.follow_status, person.is_public)}
                />
              ))}
              <LoadMore
                visible={people.hasNextPage}
                pending={people.isFetchingNextPage}
                onPress={() => void people.fetchNextPage()}
              />
            </SocialListState>
          </View>
        ) : null}

        {tab === 'requests' ? (
          <SocialListState
            loading={requests.isLoading}
            error={requests.isError}
            empty={requestItems.length === 0}
            emptyIcon={Inbox}
            emptyTitle={t('social.requestsEmptyTitle')}
            emptyMessage={t('social.requestsEmptyMessage')}
            onRetry={() => void requests.refetch()}
          >
            {requestItems.map((request) => (
              <SocialUserRow
                key={request.user_id}
                username={request.username}
                avatarUrl={request.avatar_url}
                meta={t('social.requestedAt', { date: formatDateTime(request.requested_at) })}
                action={
                  <View style={styles.requestActions}>
                    <IconAction
                      label={t('social.acceptAria', { username: request.username })}
                      color={theme.success}
                      pending={accept.isPending && accept.variables === request.user_id}
                      onPress={() => accept.mutate(request.user_id)}
                      icon="accept"
                    />
                    <IconAction
                      label={t('social.rejectAria', { username: request.username })}
                      color={theme.danger}
                      pending={reject.isPending && reject.variables === request.user_id}
                      onPress={() => reject.mutate(request.user_id)}
                      icon="reject"
                    />
                  </View>
                }
              />
            ))}
            <LoadMore
              visible={requests.hasNextPage}
              pending={requests.isFetchingNextPage}
              onPress={() => void requests.fetchNextPage()}
            />
          </SocialListState>
        ) : null}

        {tab === 'following' ? (
          <SocialListState
            loading={following.isLoading}
            error={following.isError}
            empty={followingItems.length === 0}
            emptyIcon={UserCheck}
            emptyTitle={t('social.followingEmptyTitle')}
            emptyMessage={t('social.followingEmptyMessage')}
            onRetry={() => void following.refetch()}
          >
            {followingItems.map((person) => (
              <SocialUserRow
                key={person.id}
                username={person.username}
                avatarUrl={person.avatar_url}
                bio={person.bio}
                action={
                  <AppButton
                    compact
                    label={t('social.unfollow')}
                    variant="secondary"
                    loading={unfollow.isPending && unfollow.variables === person.username}
                    onPress={() => unfollow.mutate(person.username)}
                  />
                }
              />
            ))}
            <LoadMore
              visible={following.hasNextPage}
              pending={following.isFetchingNextPage}
              onPress={() => void following.fetchNextPage()}
            />
          </SocialListState>
        ) : null}

        {tab === 'followers' ? (
          <SocialListState
            loading={followers.isLoading}
            error={followers.isError}
            empty={followerItems.length === 0}
            emptyIcon={Users}
            emptyTitle={t('social.followersEmptyTitle')}
            emptyMessage={t('social.followersEmptyMessage')}
            onRetry={() => void followers.refetch()}
          >
            {followerItems.map((person) => (
              <SocialUserRow
                key={person.id}
                username={person.username}
                avatarUrl={person.avatar_url}
                bio={person.bio}
              />
            ))}
            <LoadMore
              visible={followers.hasNextPage}
              pending={followers.isFetchingNextPage}
              onPress={() => void followers.fetchNextPage()}
            />
          </SocialListState>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function SocialListState({
  loading,
  error,
  empty,
  emptyIcon,
  emptyTitle,
  emptyMessage,
  onRetry,
  children,
}: {
  loading: boolean;
  error: boolean;
  empty: boolean;
  emptyIcon: typeof Users;
  emptyTitle: string;
  emptyMessage: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  const t = useT();
  if (loading) return <LoadingState label={t('social.loading')} />;
  if (error) return <ErrorState message={t('social.loadError')} onRetry={onRetry} />;
  if (empty) return <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} />;
  return <View style={styles.list}>{children}</View>;
}

function LoadMore({ visible, pending, onPress }: { visible: boolean; pending: boolean; onPress: () => void }) {
  const t = useT();
  if (!visible) return null;
  return <AppButton label={t('common.loadMore')} variant="secondary" loading={pending} onPress={onPress} />;
}

function IconAction({
  label,
  color,
  pending,
  onPress,
  icon,
}: {
  label: string;
  color: string;
  pending: boolean;
  onPress: () => void;
  icon: 'accept' | 'reject';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={pending}
      onPress={onPress}
      style={({ pressed }) => [styles.iconAction, { opacity: pending ? 0.45 : pressed ? 0.7 : 1 }]}
    >
      {pending ? (
        <ActivityIndicator color={color} size="small" />
      ) : icon === 'accept' ? (
        <Check color={color} size={21} />
      ) : (
        <X color={color} size={21} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: 760,
    minHeight: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  panel: { gap: spacing.md },
  list: { gap: spacing.md },
  searchBox: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  input: { flex: 1, minHeight: 46, fontSize: 16 },
  requestActions: { flexDirection: 'row', gap: spacing.xs },
  iconAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
