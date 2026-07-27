import { router } from 'expo-router';
import { ListPlus, Lock, Plus, X } from 'lucide-react-native';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import { useAddListItem, useMyLists } from '@/hooks/use-lists';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';

export function AddToListSheet({
  mediaId,
  title,
  onClose,
  onAdded,
}: {
  mediaId: string;
  title: string;
  onClose: () => void;
  onAdded: (listName: string) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const lists = useMyLists();
  const addItem = useAddListItem();

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable
        style={[styles.overlay, { backgroundColor: theme.overlay }]}
        onPress={() => {
          if (!addItem.isPending) onClose();
        }}
      >
        <SafeAreaView
          edges={['bottom']}
          style={[styles.sheet, { backgroundColor: theme.elevated }]}
        >
          <Pressable onPress={(event) => event.stopPropagation()}>
            <View style={[styles.header, { borderBottomColor: theme.border }]}>
              <View style={styles.headerCopy}>
                <AppText variant="section">{t('addToList.title')}</AppText>
                <AppText variant="caption" muted numberOfLines={1}>
                  {title}
                </AppText>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('addToList.closeAria')}
                disabled={addItem.isPending}
                onPress={onClose}
                style={[styles.iconButton, { borderColor: theme.border }]}
              >
                <X color={theme.mutedText} size={20} />
              </Pressable>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {lists.isLoading ? <LoadingState label={t('addToList.loading')} /> : null}
              {lists.isError ? (
                <View style={styles.state}>
                  <AppText variant="caption" style={{ color: theme.danger }}>
                    {getErrorMessage(lists.error, t('addToList.loadError'))}
                  </AppText>
                  <AppButton
                    label={t('common.tryAgain')}
                    variant="secondary"
                    compact
                    onPress={() => void lists.refetch()}
                  />
                </View>
              ) : null}
              {lists.data?.map((list) => {
                const pending = addItem.isPending && addItem.variables?.listId === list.id;
                return (
                  <Pressable
                    key={list.id}
                    accessibilityRole="button"
                    accessibilityLabel={t('addToList.addTo', { name: list.name })}
                    disabled={addItem.isPending}
                    onPress={() =>
                      addItem.mutate(
                        { listId: list.id, mediaId },
                        { onSuccess: () => onAdded(list.name) },
                      )
                    }
                    style={({ pressed }) => [
                      styles.row,
                      {
                        borderBottomColor: theme.border,
                        opacity: addItem.isPending ? 0.55 : pressed ? 0.72 : 1,
                      },
                    ]}
                  >
                    <ListPlus color={theme.primary} size={20} />
                    <View style={styles.rowCopy}>
                      <AppText variant="label" numberOfLines={2}>
                        {list.name}
                      </AppText>
                      <View style={styles.meta}>
                        {!list.is_public ? <Lock color={theme.mutedText} size={13} /> : null}
                        <AppText variant="caption" muted>
                          {t(
                            list.item_count === 1 ? 'library.titleCount' : 'library.titleCountPlural',
                            { count: list.item_count },
                          )}
                        </AppText>
                      </View>
                    </View>
                    {pending ? (
                      <ActivityIndicator color={theme.primary} size="small" />
                    ) : (
                      <Plus color={theme.mutedText} size={20} />
                    )}
                  </Pressable>
                );
              })}
              {!lists.isLoading && !lists.isError && !lists.data?.length ? (
                <View style={styles.state}>
                  <ListPlus color={theme.mutedText} size={30} />
                  <AppText variant="label">{t('addToList.empty')}</AppText>
                  <AppText variant="caption" muted style={styles.center}>
                    {t('addToList.emptyHint')}
                  </AppText>
                  <AppButton
                    label={t('addToList.createList')}
                    compact
                    onPress={() => {
                      onClose();
                      router.push('/lists');
                    }}
                  />
                </View>
              ) : null}
              {addItem.error ? (
                <AppText variant="caption" style={{ color: theme.danger }}>
                  {getErrorMessage(addItem.error, t('addToList.addError'))}
                </AppText>
              ) : null}
            </ScrollView>
          </Pressable>
        </SafeAreaView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    maxHeight: '78%',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  header: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
  },
  headerCopy: {
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
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  row: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  state: {
    minHeight: 190,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  center: {
    textAlign: 'center',
  },
});
