import { Check } from 'lucide-react-native';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { SegmentedControl } from '@/components/segmented-control';
import { radius, spacing } from '@/constants/theme';
import type { LibraryFilters, LibrarySort } from '@/hooks/use-tracking';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import type { MediaType, TrackingFacets } from '@/types';

export const LIBRARY_SORTS: readonly LibrarySort[] = [
  'updated',
  'added',
  'title',
  'rating',
  'release',
];

const SORT_LABELS: Record<LibrarySort, string> = {
  updated: 'library.sortUpdated',
  added: 'library.sortAdded',
  title: 'library.sortTitle',
  rating: 'library.sortRating',
  release: 'library.sortRelease',
};

/** What the sheet changes; `undefined` clears a filter. */
export interface LibraryFilterChanges {
  type?: MediaType | undefined;
  genre?: string | undefined;
  favorite?: boolean | undefined;
  sort?: LibrarySort | undefined;
}

/** Type, genre, order and favourites, each choice with the number of titles
 *  it would leave given the others. Changes apply as they are made, so the
 *  count on the close button is always the list behind the sheet. */
export function LibraryFilterSheet({
  visible,
  filters,
  facets,
  onChange,
  onClear,
  onClose,
}: {
  visible: boolean;
  filters: LibraryFilters;
  facets: TrackingFacets | undefined;
  onChange: (changes: LibraryFilterChanges) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  const counted = (label: string, count: number | undefined) =>
    count === undefined ? label : `${label} (${count})`;
  const typeCount = (type: MediaType) => facets && (facets.media_types[type] ?? 0);

  const genres: { value: string | undefined; label: string; count?: number }[] = [
    { value: undefined, label: t('library.genreAll') },
  ];
  if (filters.genre === 'anime' || (facets?.anime ?? 0) > 0) {
    genres.push({ value: 'anime', label: t('library.anime'), count: facets?.anime });
  }
  for (const genre of facets?.genres ?? []) {
    genres.push({ value: String(genre.id), label: genre.name, count: genre.count });
  }

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <Pressable
        // Not a control: the dimmed backdrop behind the sheet.
        accessible={false}
        style={[styles.overlay, { backgroundColor: theme.overlay }]}
        onPress={onClose}
      >
        <SafeAreaView edges={['bottom']} style={[styles.sheet, { backgroundColor: theme.elevated }]}>
          <Pressable
            // Not a control: stops taps on the sheet reaching the backdrop.
            accessible={false}
            style={styles.sheetBody}
            onPress={(event) => event.stopPropagation()}
          >
            <AppText variant="section" accessibilityRole="header">
              {t('library.filtersTitle')}
            </AppText>
            <ScrollView contentContainerStyle={styles.scroll}>
              <AppText variant="caption" muted style={styles.sectionLabel}>
                {t('library.type')}
              </AppText>
              <SegmentedControl
                value={filters.mediaType ?? 'all'}
                options={[
                  { value: 'all', label: t('library.typeAll') },
                  { value: 'movie', label: counted(t('library.typeMovie'), typeCount('movie')) },
                  { value: 'tv', label: counted(t('library.typeTv'), typeCount('tv')) },
                ]}
                onChange={(value) => onChange({ type: value === 'all' ? undefined : value })}
              />

              <View style={[styles.switchRow, { borderBottomColor: theme.border }]}>
                <AppText variant="label">
                  {counted(t('library.favoritesOnly'), facets?.favorites)}
                </AppText>
                <Switch
                  accessibilityLabel={t('library.favoritesOnly')}
                  value={Boolean(filters.favorite)}
                  onValueChange={(favorite) => onChange({ favorite: favorite || undefined })}
                  trackColor={{ false: theme.border, true: theme.primarySoft }}
                  thumbColor={filters.favorite ? theme.primary : theme.mutedText}
                />
              </View>

              <AppText variant="caption" muted style={styles.sectionLabel}>
                {t('library.sort')}
              </AppText>
              {LIBRARY_SORTS.map((sort) => (
                <Choice
                  key={sort}
                  label={t(SORT_LABELS[sort])}
                  selected={(filters.sort ?? 'updated') === sort}
                  onPress={() => onChange({ sort: sort === 'updated' ? undefined : sort })}
                />
              ))}

              <AppText variant="caption" muted style={styles.sectionLabel}>
                {t('library.genre')}
              </AppText>
              {genres.map((genre) => (
                <Choice
                  key={genre.value ?? 'all'}
                  label={counted(genre.label, genre.count)}
                  selected={filters.genre === genre.value}
                  onPress={() => onChange({ genre: genre.value })}
                />
              ))}
            </ScrollView>
            <View style={styles.actions}>
              <AppButton
                label={t('library.clearFilters')}
                variant="secondary"
                style={styles.action}
                onPress={onClear}
              />
              <AppButton
                label={
                  facets ? t('library.showResults', { count: facets.total }) : t('library.done')
                }
                style={styles.action}
                onPress={onClose}
              />
            </View>
          </Pressable>
        </SafeAreaView>
      </Pressable>
    </Modal>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        { borderBottomColor: theme.border, opacity: pressed ? 0.72 : 1 },
      ]}
    >
      <AppText variant="label" style={selected ? { color: theme.primary } : undefined}>
        {label}
      </AppText>
      {selected ? <Check color={theme.primary} size={20} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '88%',
    alignSelf: 'center',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
  },
  sheetBody: {
    flexShrink: 1,
    gap: spacing.md,
  },
  scroll: {
    paddingBottom: spacing.md,
  },
  sectionLabel: {
    textTransform: 'uppercase',
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  switchRow: {
    minHeight: 56,
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  choice: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  action: {
    flex: 1,
  },
});
