import { Stack, router, useLocalSearchParams } from 'expo-router';
import {
  Globe2,
  Lock,
  Pencil,
  Share2,
  Trash2,
} from 'lucide-react-native';
import { useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { ListEditorSheet } from '@/components/list-editor-sheet';
import { Poster } from '@/components/poster';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import {
  useDeleteList,
  useList,
  useRemoveListItem,
  useUpdateList,
} from '@/hooks/use-lists';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { API_ORIGIN } from '@/lib/config';
import { getErrorMessage } from '@/lib/http';
import type { ListInput } from '@/lib/lists';
import { useAuthStore } from '@/store/auth';
import type { Media } from '@/types';

export default function ListDetailScreen() {
  const theme = useTheme();
  const t = useT();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
  const id = rawId?.trim() || undefined;
  const user = useAuthStore((state) => state.user);
  const detail = useList(id);
  const updateList = useUpdateList();
  const deleteList = useDeleteList();
  const removeItem = useRemoveListItem();
  const [editing, setEditing] = useState(false);

  if (detail.isLoading) return <LoadingState label={t('listDetail.loading')} />;
  if (detail.isError || !detail.data) {
    return (
      <ErrorState
        message={getErrorMessage(detail.error, t('listDetail.loadError'))}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const { list, items } = detail.data;
  const isOwner = user?.id === list.user_id;

  const confirmDelete = () => {
    Alert.alert(
      t('lists.confirmDeleteTitle'),
      t('lists.confirmDeleteMessage', { name: list.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () =>
            deleteList.mutate(list.id, {
              onSuccess: () => router.replace('/lists'),
            }),
        },
      ],
    );
  };

  const confirmRemove = (item: Media) => {
    Alert.alert(t('listDetail.removeConfirmTitle'), item.title, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.remove'),
        style: 'destructive',
        onPress: () => removeItem.mutate({ listId: list.id, mediaId: item.id }),
      },
    ]);
  };

  const save = (input: ListInput) => {
    updateList.mutate(
      { id: list.id, ...input },
      { onSuccess: () => setEditing(false) },
    );
  };

  const share = () => {
    const url = `${API_ORIGIN}/lists/${encodeURIComponent(list.id)}`;
    void Share.share({
      title: list.name,
      message: `${list.name}\n${url}`,
      url,
    });
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <Stack.Screen options={{ title: list.name }} />
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={detail.isRefetching}
            onRefresh={() => void detail.refetch()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        ListHeaderComponent={
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <View style={styles.privacy}>
              {list.is_public ? (
                <Globe2 color={theme.primary} size={16} />
              ) : (
                <Lock color={theme.mutedText} size={16} />
              )}
              <AppText variant="caption" muted>
                {list.is_public ? t('listDetail.publicList') : t('listDetail.privateList')}
              </AppText>
            </View>
            <AppText variant="title">{list.name}</AppText>
            {list.description ? <AppText muted>{list.description}</AppText> : null}
            <AppText variant="caption" muted>
              {t(items.length === 1 ? 'library.titleCount' : 'library.titleCountPlural', {
                count: items.length,
              })}
            </AppText>
            <View style={styles.headerActions}>
              {list.is_public ? (
                <AppButton
                  label={t('common.share')}
                  variant="secondary"
                  compact
                  icon={<Share2 color={theme.mutedText} size={18} />}
                  onPress={share}
                />
              ) : null}
              {isOwner ? (
                <>
                  <AppButton
                    label={t('common.edit')}
                    variant="secondary"
                    compact
                    icon={<Pencil color={theme.mutedText} size={18} />}
                    onPress={() => {
                      updateList.reset();
                      setEditing(true);
                    }}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('lists.deleteAria', { name: list.name })}
                    disabled={deleteList.isPending}
                    onPress={confirmDelete}
                    style={[
                      styles.iconButton,
                      {
                        borderColor: theme.border,
                        opacity: deleteList.isPending ? 0.45 : 1,
                      },
                    ]}
                  >
                    <Trash2 color={theme.danger} size={18} />
                  </Pressable>
                </>
              ) : null}
            </View>
            {removeItem.error || deleteList.error ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {getErrorMessage(
                  removeItem.error || deleteList.error,
                  t('listDetail.updateError'),
                )}
              </AppText>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon={Globe2}
            title={t('listDetail.emptyTitle')}
            message={isOwner ? t('listDetail.emptyOwner') : t('listDetail.emptyVisitor')}
          />
        }
        renderItem={({ item }) => (
          <View style={[styles.row, { borderBottomColor: theme.border }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('mediaCard.open', { title: item.title })}
              onPress={() =>
                router.push({
                  pathname: '/media/[id]',
                  params: { id: String(item.tmdb_id), type: item.media_type },
                })
              }
              style={({ pressed }) => [
                styles.rowMain,
                { opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <Poster path={item.poster_path} width={54} height={81} />
              <View style={styles.rowCopy}>
                <AppText variant="label" numberOfLines={2}>
                  {item.title}
                </AppText>
                <AppText variant="caption" muted>
                  {t(item.media_type === 'tv' ? 'mediaType.tv' : 'mediaType.movie')}
                </AppText>
              </View>
            </Pressable>
            {isOwner ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('listDetail.removeFromListAria', {
                  title: item.title,
                  name: list.name,
                })}
                disabled={removeItem.isPending}
                onPress={() => confirmRemove(item)}
                style={[
                  styles.iconButton,
                  {
                    borderColor: theme.border,
                    opacity: removeItem.isPending ? 0.45 : 1,
                  },
                ]}
              >
                <Trash2 color={theme.mutedText} size={18} />
              </Pressable>
            ) : null}
          </View>
        )}
      />

      {editing ? (
        <ListEditorSheet
          list={list}
          pending={updateList.isPending}
          error={updateList.error}
          onClose={() => {
            if (!updateList.isPending) setEditing(false);
          }}
          onSave={save}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: 900,
    flexGrow: 1,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  header: {
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.lg,
  },
  privacy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  row: {
    minHeight: 104,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
