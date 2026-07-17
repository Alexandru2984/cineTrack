import { Redirect, router } from 'expo-router';
import {
  ChevronRight,
  Globe2,
  ListPlus,
  Lock,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react-native';
import { useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { ListEditorSheet } from '@/components/list-editor-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import {
  useCreateList,
  useDeleteList,
  useMyLists,
  useUpdateList,
} from '@/hooks/use-lists';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import type { ListInput } from '@/lib/lists';
import { hasLocalSession, useAuthStore } from '@/store/auth';
import type { CustomListSummary } from '@/types';

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; list: CustomListSummary }
  | null;

export default function ListsScreen() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const hasSession = hasLocalSession(status);
  const lists = useMyLists(hasSession);
  const createList = useCreateList();
  const updateList = useUpdateList();
  const deleteList = useDeleteList();
  const [editor, setEditor] = useState<EditorState>(null);

  if (!hasSession) return <Redirect href="/" />;

  const save = (input: ListInput) => {
    if (!editor) return;
    if (editor.mode === 'create') {
      createList.mutate(input, { onSuccess: () => setEditor(null) });
      return;
    }
    updateList.mutate(
      { id: editor.list.id, ...input },
      { onSuccess: () => setEditor(null) },
    );
  };

  const confirmDelete = (list: CustomListSummary) => {
    Alert.alert(
      'Delete list?',
      `${list.name}\n\nThe titles inside will not be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteList.mutate(list.id),
        },
      ],
    );
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <FlatList
        data={lists.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={lists.isRefetching}
            onRefresh={() => void lists.refetch()}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenHeader
              title="Custom lists"
              subtitle="Collections independent from tracking status"
              right={
                <AppButton
                  label="Create"
                  compact
                  icon={<Plus color="#FFFFFF" size={18} />}
                  onPress={() => {
                    createList.reset();
                    setEditor({ mode: 'create' });
                  }}
                />
              }
            />
            {deleteList.error ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {getErrorMessage(deleteList.error, 'The list could not be deleted')}
              </AppText>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          lists.isLoading ? (
            <LoadingState label="Loading lists" />
          ) : lists.isError ? (
            <ErrorState
              message={getErrorMessage(lists.error, 'Your lists could not be loaded')}
              onRetry={() => void lists.refetch()}
            />
          ) : (
            <EmptyState
              icon={ListPlus}
              title="No custom lists"
              message="Create a collection, then add titles from their detail pages."
              actionLabel="Create your first list"
              onAction={() => setEditor({ mode: 'create' })}
            />
          )
        }
        renderItem={({ item }) => (
          <View style={[styles.row, { borderBottomColor: theme.border }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
              onPress={() =>
                router.push({ pathname: '/lists/[id]', params: { id: item.id } })
              }
              style={({ pressed }) => [
                styles.rowMain,
                { opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <View style={[styles.privacyIcon, { backgroundColor: theme.surface }]}>
                {item.is_public ? (
                  <Globe2 color={theme.primary} size={20} />
                ) : (
                  <Lock color={theme.mutedText} size={20} />
                )}
              </View>
              <View style={styles.rowCopy}>
                <AppText variant="label" numberOfLines={2}>
                  {item.name}
                </AppText>
                {item.description ? (
                  <AppText variant="caption" muted numberOfLines={1}>
                    {item.description}
                  </AppText>
                ) : null}
                <AppText variant="caption" muted>
                  {item.item_count} {item.item_count === 1 ? 'title' : 'titles'} ·{' '}
                  {item.is_public ? 'Public' : 'Private'}
                </AppText>
              </View>
              <ChevronRight color={theme.mutedText} size={18} />
            </Pressable>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Edit ${item.name}`}
                onPress={() => {
                  updateList.reset();
                  setEditor({ mode: 'edit', list: item });
                }}
                style={[styles.iconButton, { borderColor: theme.border }]}
              >
                <Pencil color={theme.mutedText} size={18} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${item.name}`}
                disabled={deleteList.isPending}
                onPress={() => confirmDelete(item)}
                style={[
                  styles.iconButton,
                  {
                    borderColor: theme.border,
                    opacity: deleteList.isPending ? 0.45 : 1,
                  },
                ]}
              >
                <Trash2 color={theme.mutedText} size={18} />
              </Pressable>
            </View>
          </View>
        )}
      />

      {editor ? (
        <ListEditorSheet
          list={editor.mode === 'edit' ? editor.list : undefined}
          pending={editor.mode === 'create' ? createList.isPending : updateList.isPending}
          error={editor.mode === 'create' ? createList.error : updateList.error}
          onClose={() => {
            if (!createList.isPending && !updateList.isPending) setEditor(null);
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
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  row: {
    minHeight: 100,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
  privacyIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
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
