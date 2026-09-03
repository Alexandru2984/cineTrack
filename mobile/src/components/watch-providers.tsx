import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ExternalLink, Tv } from 'lucide-react-native';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { imageUrl } from '@/components/poster';
import { radius, spacing } from '@/constants/theme';
import { useWatchProviders } from '@/hooks/use-media';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { safeWatchProviderLink } from '@/lib/watch-providers';
import type { WatchProviderEntry } from '@/types';

function ProviderGroup({
  label,
  providers,
}: {
  label: string;
  providers: WatchProviderEntry[];
}) {
  const theme = useTheme();
  if (providers.length === 0) return null;
  return (
    <View style={styles.group}>
      <AppText variant="caption" muted style={styles.groupLabel}>
        {label}
      </AppText>
      <View style={styles.providers}>
        {providers.map((provider) => {
          // The provider's name labels the pressable below, so the logo inside
          // it is marked decorative rather than announced a second time.
          const logo = imageUrl(provider.logo_path, 'w92');
          return (
            <View
              key={provider.provider_id}
              accessibilityLabel={provider.name}
              style={styles.provider}
            >
              {logo ? (
                <Image
                  accessible={false}
                  source={{ uri: logo }}
                  contentFit="cover"
                  transition={120}
                  style={[
                    styles.logo,
                    { backgroundColor: theme.surface, borderColor: theme.border },
                  ]}
                />
              ) : (
                <View
                  style={[
                    styles.logo,
                    styles.logoFallback,
                    { backgroundColor: theme.surface, borderColor: theme.border },
                  ]}
                >
                  <Tv color={theme.mutedText} size={18} />
                </View>
              )}
              <AppText variant="caption" numberOfLines={2} style={styles.providerName}>
                {provider.name}
              </AppText>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function WatchProviders({
  tmdbId,
  mediaType,
}: {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}) {
  const theme = useTheme();
  const t = useT();
  const providers = useWatchProviders(String(tmdbId), mediaType);
  if (!providers.data) return null;

  const { stream, rent, buy, region, link } = providers.data;
  const hasOffers = stream.length > 0 || rent.length > 0 || buy.length > 0;

  const openJustWatch = async () => {
    try {
      await Linking.openURL(safeWatchProviderLink(link));
    } catch {
      Alert.alert(t('watchProviders.openErrorTitle'), t('watchProviders.openErrorMessage'));
    }
  };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.elevated, borderColor: theme.border },
      ]}
    >
      <View style={styles.heading}>
        <View style={styles.title}>
          <Tv color={theme.primary} size={20} />
          <AppText variant="section">{t('watchProviders.title')}</AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('watchProviders.changeRegionAria', { region })}
          onPress={() => router.push('/settings')}
          style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}
        >
          <AppText variant="caption" style={{ color: theme.primary }}>
            {t('watchProviders.regionChange', { region })}
          </AppText>
        </Pressable>
      </View>

      {hasOffers ? (
        <View style={styles.groups}>
          <ProviderGroup label={t('watchProviders.stream').toUpperCase()} providers={stream} />
          <ProviderGroup label={t('watchProviders.rent').toUpperCase()} providers={rent} />
          <ProviderGroup label={t('watchProviders.buy').toUpperCase()} providers={buy} />
        </View>
      ) : (
        <AppText muted>{t('watchProviders.none', { region })}</AppText>
      )}

      <Pressable
        accessibilityRole="link"
        accessibilityLabel="JustWatch"
        onPress={() => void openJustWatch()}
        style={({ pressed }) => [
          styles.attribution,
          { borderTopColor: theme.border, opacity: pressed ? 0.65 : 1 },
        ]}
      >
        <AppText variant="caption" muted style={styles.attributionCopy}>
          {t('watchProviders.attributionPre')}{' '}
          <AppText variant="caption" style={{ color: theme.primary }}>
            JustWatch
          </AppText>
          .
        </AppText>
        <ExternalLink color={theme.primary} size={15} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  heading: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  groups: {
    gap: spacing.lg,
  },
  group: {
    gap: spacing.sm,
  },
  groupLabel: {
    letterSpacing: 0.8,
  },
  providers: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  provider: {
    width: 68,
    alignItems: 'center',
    gap: spacing.xs,
  },
  logo: {
    width: 46,
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
  },
  logoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerName: {
    width: '100%',
    textAlign: 'center',
  },
  attribution: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.md,
  },
  attributionCopy: {
    flex: 1,
    minWidth: 0,
  },
});
