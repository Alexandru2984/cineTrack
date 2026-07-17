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

const tabs = [
  { value: 'feed', label: 'Feed' },
  { value: 'people', label: 'People' },
  { value: 'requests', label: 'Requests' },
  { value: 'following', label: 'Following' },
  { value: 'followers', label: 'Followers' },
] as const;

export default function SocialScreen() {
  const theme = useTheme();
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
        label={relationshipLabel(followStatus, isPublic)}
        variant={remove ? 'secondary' : 'primary'}
        loading={pending}
        onPress={() => remove ? unfollow.mutate(username) : follow.mutate(username)}
      />
    );
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['bottom']}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <ScreenHeader title="Social" subtitle="People and recent activity" />
        <SegmentedControl value={tab} options={tabs} onChange={setTab} />

        {mutationError ? (
          <AppText variant="caption" style={{ color: theme.danger }}>
            {getErrorMessage(mutationError, 'Could not update this relationship')}
          </AppText>
        ) : null}

        {tab === 'feed' ? (
          <SocialListState
            loading={feed.isLoading}
            error={feed.isError}
            empty={feedItems.length === 0}
            emptyIcon={Users}
            emptyTitle="No activity yet"
            emptyMessage="Your activity and posts from people you follow appear here."
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
                placeholder="Search usernames"
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
                Enter 2-50 letters, numbers, underscores, or hyphens.
              </AppText>
            ) : null}
            <SocialListState
              loading={people.isLoading}
              error={people.isError}
              empty={peopleItems.length === 0}
              emptyIcon={Search}
              emptyTitle={debouncedQuery.length < 2 ? 'Find people' : 'No people found'}
              emptyMessage={debouncedQuery.length < 2 ? 'Enter at least two username characters.' : 'Try another username.'}
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
                      ? `${person.followers_count} follower${person.followers_count === 1 ? '' : 's'}`
                      : null,
                    person.is_public ? null : 'Private',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  action={person.id === currentUser?.id
                    ? <AppText variant="caption" muted>You</AppText>
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
            emptyTitle="No follow requests"
            emptyMessage="New requests for your private profile appear here."
            onRetry={() => void requests.refetch()}
          >
            {requestItems.map((request) => (
              <SocialUserRow
                key={request.user_id}
                username={request.username}
                avatarUrl={request.avatar_url}
                meta={`Requested ${formatDateTime(request.requested_at)}`}
                action={
                  <View style={styles.requestActions}>
                    <IconAction
                      label={`Accept ${request.username}`}
                      color={theme.success}
                      pending={accept.isPending && accept.variables === request.user_id}
                      onPress={() => accept.mutate(request.user_id)}
                      icon="accept"
                    />
                    <IconAction
                      label={`Reject ${request.username}`}
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
            emptyTitle="Not following anyone"
            emptyMessage="Find people to build your activity feed."
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
                    label="Unfollow"
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
            emptyTitle="No followers"
            emptyMessage="Followers will appear here."
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
  if (loading) return <LoadingState label="Loading social activity" />;
  if (error) return <ErrorState message="Social data could not be loaded" onRetry={onRetry} />;
  if (empty) return <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} />;
  return <View style={styles.list}>{children}</View>;
}

function LoadMore({ visible, pending, onPress }: { visible: boolean; pending: boolean; onPress: () => void }) {
  if (!visible) return null;
  return <AppButton label="Load more" variant="secondary" loading={pending} onPress={onPress} />;
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
