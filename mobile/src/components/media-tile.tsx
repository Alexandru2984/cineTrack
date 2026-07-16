import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Check, Film, Plus } from 'lucide-react-native';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { AppText } from '@/components/app-text';
import { imageUrl } from '@/components/poster';
import { radius, spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { MediaType, TmdbSearchResult } from '@/types';

export function mediaResultType(
  item: TmdbSearchResult,
  fallback?: MediaType,
): MediaType {
  if (item.media_type === 'tv' || item.media_type === 'movie') return item.media_type;
  if (fallback) return fallback;
  return item.name && !item.title ? 'tv' : 'movie';
}

export function MediaTile({
  item,
  fallbackType,
  width,
  onAdd,
  added = false,
  addPending = false,
}: {
  item: TmdbSearchResult;
  fallbackType?: MediaType;
  width?: number;
  onAdd?: () => void;
  added?: boolean;
  addPending?: boolean;
}) {
  const theme = useTheme();
  const type = mediaResultType(item, fallbackType);
  const title = item.title || item.name || 'Unknown title';
  const date = item.release_date || item.first_air_date;
  const uri = imageUrl(item.poster_path);
  const tileStyle: ViewStyle = width ? { width } : { flex: 1 };

  return (
    <View style={[styles.tile, tileStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${title}`}
        onPress={() =>
          router.push({
            pathname: '/media/[id]',
            params: { id: String(item.id), type },
          })
        }
        style={({ pressed }) => [{ opacity: pressed ? 0.78 : 1 }]}
      >
        <View
          style={[
            styles.imageFrame,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          {uri ? (
            <Image source={{ uri }} contentFit="cover" transition={120} style={styles.image} />
          ) : (
            <Film color={theme.mutedText} size={30} />
          )}
          <View style={[styles.typeBadge, { backgroundColor: theme.info }]}>
            <AppText variant="caption" style={styles.badgeText}>
              {type === 'tv' ? 'TV' : 'FILM'}
            </AppText>
          </View>
        </View>
        <AppText variant="label" numberOfLines={2} style={styles.title}>
          {title}
        </AppText>
        <AppText variant="caption" muted numberOfLines={1}>
          {date ? new Date(`${date}T12:00:00`).getFullYear() : 'Release TBA'}
        </AppText>
      </Pressable>

      {onAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={added ? `${title} is in your library` : `Add ${title} to your plan`}
          disabled={added || addPending}
          onPress={onAdd}
          style={({ pressed }) => [
            styles.addButton,
            {
              backgroundColor: added ? theme.success : theme.primary,
              opacity: addPending ? 0.5 : pressed ? 0.75 : 1,
            },
          ]}
        >
          {added ? <Check color="#FFFFFF" size={18} /> : <Plus color="#FFFFFF" size={18} />}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    minWidth: 0,
    position: 'relative',
  },
  imageFrame: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  typeBadge: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    minHeight: 22,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  title: {
    marginTop: spacing.sm,
    minHeight: 40,
  },
  addButton: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
